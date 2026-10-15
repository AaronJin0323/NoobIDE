import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { AI_HISTORY_CHANNELS } from '../shared/ipc/ai-history-contract';
import {
  parseChatRef,
  parseNoPayload,
  parseProjectOnly,
  parseSaveChat,
  parseSetDailyBudget,
} from '../shared/ipc/ai-history-parse';
import { parseRecentRequest } from '../shared/ipc/app-data-contract';
import { toIpcResult, type IpcResult } from '../shared/ipc/contract';
import type { AiChatStore } from '../ai/chat-store';
import type { AiUsageStore } from '../ai/usage-store';
import { isTrustedSender, senderInfo } from './ipc';

/**
 * IPC handlers of saved AI chats and token usage (S39). The same checks as ai-ipc.ts, in the same order: the sender
 * is the workbench's top-level frame on the app origin, at most one argument, and it passes the channel's parser
 * (src/shared/ipc/ai-history-parse.ts) — before a store is touched. Projects are named by their opaque id (or a
 * recent entry's id); only main knows the real root, and the stores keep chats in app data, never in the project.
 */
export interface AiHistoryIpcDeps {
  readonly allowedOrigin: string;
  readonly chats: Pick<AiChatStore, 'list' | 'get' | 'save' | 'delete' | 'deleteAll' | 'count'>;
  readonly usage: Pick<AiUsageStore, 'summary' | 'setBudget'>;
  /** Real root of an open project, or undefined. */
  rootOf(projectId: string): string | undefined;
  /** Real root of a recent-projects entry, or undefined. */
  recentRootOf(id: string): Promise<string | undefined>;
}

const FORBIDDEN = { ok: false, code: 'forbidden-sender', message: 'sender is not the workbench' } as const;
const INVALID = { ok: false, code: 'invalid-request', message: 'payload does not match the contract' } as const;
const UNKNOWN_PROJECT = { ok: false, code: 'unknown-project', message: 'project is not open' } as const;
const UNKNOWN_RECENT = { ok: false, code: 'unknown-recent', message: 'no such recent project' } as const;

export function registerAiHistoryIpcHandlers(ipc: Pick<IpcMain, 'handle'>, deps: AiHistoryIpcDeps): void {
  const { chats, usage } = deps;

  function handle<P>(
    channel: string,
    parse: (payload: unknown) => P | null,
    run: (payload: P, event: IpcMainInvokeEvent) => Promise<IpcResult<unknown, string>>,
  ): void {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedSender(senderInfo(event), deps.allowedOrigin)) return FORBIDDEN;
      if (args.length > 1) return INVALID;
      const payload = parse(args[0]);
      if (payload === null) return INVALID;
      return run(payload, event);
    });
  }

  handle(AI_HISTORY_CHANNELS.listChats, parseProjectOnly, async ({ projectId }) => {
    const root = deps.rootOf(projectId);
    return root === undefined ? UNKNOWN_PROJECT : { ok: true, value: await chats.list(root) };
  });
  handle(AI_HISTORY_CHANNELS.getChat, parseChatRef, async ({ projectId, chatId }) => {
    const root = deps.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    const chat = await chats.get(root, chatId);
    return chat ? { ok: true, value: chat } : { ok: false, code: 'not-found', message: 'no such saved chat' };
  });
  handle(AI_HISTORY_CHANNELS.saveChat, parseSaveChat, async ({ projectId, chat }) => {
    const root = deps.rootOf(projectId);
    return root === undefined ? UNKNOWN_PROJECT : toIpcResult(await chats.save(root, chat));
  });
  handle(AI_HISTORY_CHANNELS.deleteChat, parseChatRef, async ({ projectId, chatId }) => {
    const root = deps.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    return (await chats.delete(root, chatId))
      ? { ok: true, value: null }
      : { ok: false, code: 'delete-failed', message: 'the saved chat could not be deleted' };
  });
  handle(AI_HISTORY_CHANNELS.deleteProjectChats, parseProjectOnly, async ({ projectId }) => {
    const root = deps.rootOf(projectId);
    return root === undefined ? UNKNOWN_PROJECT : { ok: true, value: { deleted: await chats.deleteAll(root) } };
  });
  handle(AI_HISTORY_CHANNELS.countRecentChats, parseRecentRequest, async ({ id }) => {
    const root = await deps.recentRootOf(id);
    return root === undefined ? UNKNOWN_RECENT : { ok: true, value: { count: await chats.count(root) } };
  });
  handle(AI_HISTORY_CHANNELS.deleteRecentChats, parseRecentRequest, async ({ id }) => {
    const root = await deps.recentRootOf(id);
    return root === undefined ? UNKNOWN_RECENT : { ok: true, value: { deleted: await chats.deleteAll(root) } };
  });
  handle(AI_HISTORY_CHANNELS.usage, parseNoPayload, async () => ({ ok: true, value: await usage.summary() }));
  handle(AI_HISTORY_CHANNELS.setDailyBudget, parseSetDailyBudget, async ({ dailyTokens }) => ({
    ok: true,
    value: await usage.setBudget(dailyTokens),
  }));
}
