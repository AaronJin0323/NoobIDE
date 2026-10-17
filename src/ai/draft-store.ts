import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { errorCode, SerialQueue, silentLogger, writeFileAtomic, type RecoveryLogger } from '../recovery/atomic-file';
import { projectKey } from '../recovery/keys';
import { readJsonFile, schemaVersionOf } from '../main/json-file';
import type { AiDraft, AiSaveDraftError, AiStoredDraft } from '../shared/ipc/ai-draft-contract';
import { AI_DRAFT_LIMITS, parseDraftFile } from '../shared/ipc/ai-draft-parse';
import { err, ok, type Result } from '../shared/result';

/**
 * Unsent chat drafts (S48.7, zero-loss drafts), in app data: `<dir>/<projectKey(realRoot)>.json` per project and
 * `<dir>/no-project.json` for chats without one (`projectKey` is the hash local history and saved chats use, so no
 * file name contains a user path). Never inside the project folder.
 *
 * - Each file holds the drafts of one project, one per conversation (`new` or a saved chat id), newest first, at most
 *   `AI_DRAFT_LIMITS.drafts` (the least recently changed are dropped). Writes are atomic and serialized.
 * - A file that cannot be parsed is moved aside (`.corrupt`) and reads as empty; one from a newer NoobIDE is read as
 *   empty and never written (S28.4). A draft is never lost because another one is damaged: drafts that do not parse
 *   are left out one by one.
 * - Logs carry event names and error codes only — never prompts, chips or paths.
 */
export const AI_DRAFTS_VERSION = 1;
export const NO_PROJECT_FILE = 'no-project.json';
const CORRUPT_SUFFIX = '.corrupt';

export interface DraftStoreLimits {
  /** Bytes of one project's drafts file. */
  readonly maxBytesPerFile: number;
}

export const DRAFT_STORE_LIMITS: DraftStoreLimits = { maxBytesPerFile: 8 * 1024 * 1024 };

/** `newer` (a newer NoobIDE's file) and `unreadable` (locked, no permission) are read as empty and never written. */
type Loaded = { readonly kind: 'ok'; readonly drafts: AiStoredDraft[] } | { readonly kind: 'newer' | 'unreadable' };

export class AiDraftStore {
  private readonly queue = new SerialQueue();
  private readonly log: RecoveryLogger;
  private readonly now: () => number;
  private readonly limits: DraftStoreLimits;

  constructor(
    private readonly options: {
      readonly dir: string;
      readonly log?: RecoveryLogger;
      readonly now?: () => number;
      readonly limits?: Partial<DraftStoreLimits>;
    },
  ) {
    this.log = options.log ?? silentLogger;
    this.now = options.now ?? Date.now;
    this.limits = { ...DRAFT_STORE_LIMITS, ...options.limits };
  }

  /** The drafts file of a project (by the hash of its real root), or of chats without a project (null). */
  file(realRoot: string | null): string {
    return path.join(this.options.dir, realRoot === null ? NO_PROJECT_FILE : `${projectKey(realRoot)}.json`);
  }

  /** Every kept draft, newest first. */
  list(realRoot: string | null): Promise<AiStoredDraft[]> {
    return this.queue.run(async () => {
      const loaded = await this.load(realRoot);
      return loaded.kind === 'ok' ? loaded.drafts : [];
    });
  }

  /** Keeps one conversation's draft (an empty one, or null, forgets it). */
  save(
    realRoot: string | null,
    key: string,
    draft: AiDraft | null,
  ): Promise<Result<null, Exclude<AiSaveDraftError, 'unknown-project'>>> {
    return this.queue.run(async () => {
      const loaded = await this.load(realRoot);
      if (loaded.kind !== 'ok') {
        return err(
          'write-failed',
          loaded.kind === 'newer' ? 'saved by a newer NoobIDE' : 'drafts file is not readable',
        );
      }
      const others = loaded.drafts.filter((d) => d.key !== key);
      const empty = draft === null || (draft.prompt === '' && draft.chips.length === 0);
      if (empty && others.length === loaded.drafts.length) return ok(null); // nothing to forget
      const drafts = empty ? others : [{ key, updatedAt: this.now(), ...draft }, ...others];
      let kept = drafts.slice(0, AI_DRAFT_LIMITS.drafts);
      let text = serialize(kept);
      // Too big: older drafts go first; the one just saved is always kept (or refused when it alone is too big).
      while (Buffer.byteLength(text) > this.limits.maxBytesPerFile && kept.length > 1) {
        kept = kept.slice(0, -1);
        text = serialize(kept);
      }
      if (Buffer.byteLength(text) > this.limits.maxBytesPerFile) return err('too-large', 'draft is too large to keep');
      const target = this.file(realRoot);
      try {
        if (kept.length === 0) await rm(target, { force: true });
        else await writeFileAtomic(target, text);
      } catch (e) {
        this.log('ai-draft-write-failed', { code: errorCode(e) });
        return err('write-failed', errorCode(e));
      }
      return ok(null);
    });
  }

  /** Resolves once every write queued so far has finished (the quit waits for it). */
  flush(): Promise<void> {
    return this.queue.run(async () => undefined);
  }

  /** Forgets every draft of a project (its saved chats were deleted). */
  deleteAll(realRoot: string): Promise<void> {
    return this.queue.run(async () => {
      await rm(this.file(realRoot), { force: true }).catch((e: unknown) =>
        this.log('ai-draft-delete-failed', { code: errorCode(e) }),
      );
    });
  }

  private async load(realRoot: string | null): Promise<Loaded> {
    const file = this.file(realRoot);
    const read = await readJsonFile(file);
    if (read.kind === 'missing') return { kind: 'ok', drafts: [] };
    if (read.kind === 'unreadable') {
      // Locked by another program or not permitted (Windows indexing, antivirus): the other drafts must survive.
      this.log('ai-drafts-unreadable', { code: read.code });
      return { kind: 'unreadable' };
    }
    if (read.kind === 'parsed') {
      const version = schemaVersionOf(read.value, AI_DRAFTS_VERSION);
      if (version.kind === 'newer') return { kind: 'newer' };
      const drafts = version.kind === 'current' ? parseDraftFile(read.value) : null;
      if (drafts) return { kind: 'ok', drafts: drafts.sort((a, b) => b.updatedAt - a.updatedAt) };
    }
    const moved = await rename(file, `${file}${CORRUPT_SUFFIX}`).then(
      () => true,
      () => false,
    );
    this.log('ai-drafts-skipped', { reason: 'corrupt', movedAside: moved });
    return { kind: 'ok', drafts: [] };
  }
}

function serialize(drafts: readonly AiStoredDraft[]): string {
  return `${JSON.stringify({ version: AI_DRAFTS_VERSION, drafts })}\n`;
}
