import { readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  errorCode,
  SerialQueue,
  silentLogger,
  TEMP_SUFFIX,
  writeFileAtomic,
  type RecoveryLogger,
} from '../recovery/atomic-file';
import { projectKey } from '../recovery/keys';
import { readJsonFile, schemaVersionOf } from '../main/json-file';
import type {
  AiChatList,
  AiChatToSave,
  AiSaveChatError,
  AiSavedChat,
  AiSavedChatSummary,
} from '../shared/ipc/ai-history-contract';
import { isChatId, parseSavedChatFile } from '../shared/ipc/ai-history-parse';
import { err, ok, type Result } from '../shared/result';

/**
 * Saved AI chats per project (S39.1, decision 0025), in app data: `<dir>/<projectKey(realRoot)>/<chatId>.json`
 * (`projectKey` is the same hash local history and the session store use, so no folder name contains a user path).
 * Never inside the project folder.
 *
 * - Writes are atomic (writeFileAtomic) and serialized per store.
 * - Caps: one chat file is at most `maxBytesPerChat` (the oldest turns of a very long chat are dropped to fit); a
 *   project keeps at most `maxChatsPerProject` chats and `maxBytesPerProject` bytes — the least recently updated chats
 *   are pruned first (the one just saved is always kept).
 * - A file that cannot be parsed or does not match the format is moved aside (`.corrupt`) and counted as skipped; one
 *   from a newer NoobIDE is skipped and left untouched (S28.4). Neither stops the list.
 * - Logs carry event names, counts and error codes only — never titles, prompts, answers or paths.
 */
export const AI_CHATS_VERSION = 1;

export interface ChatStoreLimits {
  readonly maxChatsPerProject: number;
  readonly maxBytesPerChat: number;
  readonly maxBytesPerProject: number;
}

export const CHAT_STORE_LIMITS: ChatStoreLimits = {
  maxChatsPerProject: 50,
  maxBytesPerChat: 2 * 1024 * 1024,
  maxBytesPerProject: 20 * 1024 * 1024,
};

const CHAT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
export const CORRUPT_SUFFIX = '.corrupt';

interface Loaded {
  readonly chats: { readonly chat: AiSavedChat; readonly bytes: number }[];
  readonly skipped: number;
}

export class AiChatStore {
  private readonly queue = new SerialQueue();
  private readonly limits: ChatStoreLimits;
  private readonly log: RecoveryLogger;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      readonly dir: string;
      readonly log?: RecoveryLogger;
      readonly limits?: Partial<ChatStoreLimits>;
      readonly now?: () => number;
    },
  ) {
    this.limits = { ...CHAT_STORE_LIMITS, ...options.limits };
    this.log = options.log ?? silentLogger;
    this.now = options.now ?? Date.now;
  }

  /** The folder of one project's chats (by the hash of its real root). */
  projectDir(realRoot: string): string {
    return path.join(this.options.dir, projectKey(realRoot));
  }

  private file(realRoot: string, chatId: string): string {
    return path.join(this.projectDir(realRoot), `${chatId}.json`);
  }

  list(realRoot: string): Promise<AiChatList> {
    return this.queue.run(async () => {
      const loaded = await this.load(realRoot);
      return { chats: loaded.chats.map(({ chat }) => summaryOf(chat)), skipped: loaded.skipped };
    });
  }

  async count(realRoot: string): Promise<number> {
    return (await this.list(realRoot)).chats.length;
  }

  get(realRoot: string, chatId: string): Promise<AiSavedChat | null> {
    return this.queue.run(async () => {
      if (!isChatId(chatId)) return null;
      const read = await this.readChat(this.file(realRoot, chatId));
      return read.kind === 'ok' ? read.chat : null;
    });
  }

  /** Creates or replaces a chat, then prunes the project's oldest chats beyond the caps. */
  save(
    realRoot: string,
    input: AiChatToSave,
  ): Promise<Result<AiSavedChatSummary, Exclude<AiSaveChatError, 'unknown-project'>>> {
    return this.queue.run(async () => {
      const target = this.file(realRoot, input.id);
      const existing = await this.readChat(target);
      if (existing.kind === 'newer') return err('write-failed', 'saved by a newer NoobIDE');
      const now = this.now();
      const createdAt = existing.kind === 'ok' ? existing.chat.createdAt : now;
      let turns = input.turns;
      let text = serialize({ ...input, turns, createdAt, updatedAt: now });
      // A very long chat keeps its newest turns.
      while (Buffer.byteLength(text) > this.limits.maxBytesPerChat && turns.length > 1) {
        turns = turns.slice(Math.max(1, Math.ceil(turns.length / 10)));
        text = serialize({ ...input, turns, createdAt, updatedAt: now });
      }
      if (Buffer.byteLength(text) > this.limits.maxBytesPerChat) return err('too-large', 'chat is too large to save');
      try {
        await writeFileAtomic(target, text);
      } catch (e) {
        this.log('ai-chat-write-failed', { code: errorCode(e) });
        return err('write-failed', errorCode(e));
      }
      await this.prune(realRoot, input.id);
      return ok(summaryOf({ ...input, turns, createdAt, updatedAt: now }));
    });
  }

  delete(realRoot: string, chatId: string): Promise<boolean> {
    return this.queue.run(async () => {
      if (!isChatId(chatId)) return false;
      try {
        await rm(this.file(realRoot, chatId), { force: true });
        return true;
      } catch (e) {
        this.log('ai-chat-delete-failed', { code: errorCode(e) });
        return false;
      }
    });
  }

  /** Deletes every saved chat of a project (and its damaged files). Returns how many readable chats there were. */
  deleteAll(realRoot: string): Promise<number> {
    return this.queue.run(async () => {
      const loaded = await this.load(realRoot);
      try {
        await rm(this.projectDir(realRoot), { recursive: true, force: true });
      } catch (e) {
        this.log('ai-chat-delete-failed', { code: errorCode(e) });
        return 0;
      }
      this.log('ai-chats-deleted', { count: loaded.chats.length });
      return loaded.chats.length;
    });
  }

  // ── internals (run inside the queue) ──

  private async readChat(
    file: string,
  ): Promise<
    { kind: 'ok'; chat: AiSavedChat; bytes: number } | { kind: 'missing' | 'corrupt' | 'newer' | 'unreadable' }
  > {
    const read = await readJsonFile(file);
    if (read.kind === 'missing') return { kind: 'missing' };
    if (read.kind === 'unreadable') return { kind: 'unreadable' };
    if (read.kind === 'corrupt') return { kind: 'corrupt' };
    const version = schemaVersionOf(read.value, AI_CHATS_VERSION);
    if (version.kind === 'newer') return { kind: 'newer' };
    if (version.kind !== 'current') return { kind: 'corrupt' };
    const chat = parseSavedChatFile(read.value);
    // The file name is the chat's identity; a body naming another id is damage.
    if (!chat || `${chat.id}.json` !== path.basename(file)) return { kind: 'corrupt' };
    const bytes = await stat(file).then(
      (s) => s.size,
      () => 0,
    );
    return { kind: 'ok', chat, bytes };
  }

  /** Every readable chat of a project, newest first; damaged files are moved aside and counted. */
  private async load(realRoot: string): Promise<Loaded> {
    const dir = this.projectDir(realRoot);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if (errorCode(e) !== 'ENOENT') this.log('ai-chats-unreadable', { code: errorCode(e) });
      return { chats: [], skipped: 0 };
    }
    const chats: Loaded['chats'] = [];
    let skipped = 0;
    for (const name of names) {
      const full = path.join(dir, name);
      if (name.endsWith(TEMP_SUFFIX)) {
        await rm(full, { force: true }).catch(() => undefined); // left by a crash mid-write
        continue;
      }
      if (!CHAT_FILE.test(name)) continue;
      const read = await this.readChat(full);
      if (read.kind === 'ok') chats.push({ chat: read.chat, bytes: read.bytes });
      else if (read.kind === 'corrupt') {
        skipped += 1;
        const moved = await rename(full, `${full}${CORRUPT_SUFFIX}`).then(
          () => true,
          () => false,
        );
        this.log('ai-chat-skipped', { reason: 'corrupt', movedAside: moved });
      } else if (read.kind !== 'missing') {
        skipped += 1;
        this.log('ai-chat-skipped', { reason: read.kind });
      }
    }
    chats.sort((a, b) => b.chat.updatedAt - a.chat.updatedAt);
    return { chats, skipped };
  }

  private async prune(realRoot: string, keepId: string): Promise<void> {
    const { chats } = await this.load(realRoot);
    let kept = 0;
    let bytes = 0;
    let pruned = 0;
    for (const { chat, bytes: size } of chats) {
      const fits = kept < this.limits.maxChatsPerProject && bytes + size <= this.limits.maxBytesPerProject;
      if (chat.id === keepId || fits) {
        kept += 1;
        bytes += size;
        continue;
      }
      await rm(this.file(realRoot, chat.id), { force: true }).catch(() => undefined);
      pruned += 1;
    }
    if (pruned > 0) this.log('ai-chats-pruned', { count: pruned });
  }
}

function serialize(chat: AiSavedChat): string {
  return `${JSON.stringify({ version: AI_CHATS_VERSION, ...chat })}\n`;
}

export function summaryOf(chat: AiSavedChat): AiSavedChatSummary {
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    turnCount: chat.turns.length,
  };
}
