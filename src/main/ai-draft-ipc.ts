import type { IpcMain } from 'electron';
import { AI_DRAFT_CHANNELS } from '../shared/ipc/ai-draft-contract';
import { parseGetDrafts, parseSaveDraft } from '../shared/ipc/ai-draft-parse';
import { toIpcResult, type IpcResult } from '../shared/ipc/contract';
import type { AiDraftStore } from '../ai/draft-store';
import { isTrustedSender, senderInfo } from './ipc';

/**
 * IPC handlers of the chat composer's unsent drafts (S48.7). The same checks as ai-history-ipc.ts, in the same order:
 * the sender is the workbench's top-level frame on the app origin, at most one argument, and it passes the channel's
 * parser (src/shared/ipc/ai-draft-parse.ts) — before the store is touched. Projects are named by their opaque id;
 * only main knows the real root, and the store keeps drafts in app data, never in the project.
 */
export interface AiDraftIpcDeps {
  readonly allowedOrigin: string;
  readonly drafts: Pick<AiDraftStore, 'list' | 'save'>;
  /** Real root of an open project, or undefined. */
  rootOf(projectId: string): string | undefined;
}

const FORBIDDEN = { ok: false, code: 'forbidden-sender', message: 'sender is not the workbench' } as const;
const INVALID = { ok: false, code: 'invalid-request', message: 'payload does not match the contract' } as const;
const UNKNOWN_PROJECT = { ok: false, code: 'unknown-project', message: 'project is not open' } as const;

export function registerAiDraftIpcHandlers(ipc: Pick<IpcMain, 'handle'>, deps: AiDraftIpcDeps): void {
  function handle<P>(
    channel: string,
    parse: (payload: unknown) => P | null,
    run: (payload: P) => Promise<IpcResult<unknown, string>>,
  ): void {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedSender(senderInfo(event), deps.allowedOrigin)) return FORBIDDEN;
      if (args.length > 1) return INVALID;
      const payload = parse(args[0]);
      if (payload === null) return INVALID;
      return run(payload);
    });
  }

  /** null: chats without a project; undefined: the project is not open (refused). */
  const rootOf = (projectId: string | null): string | null | undefined =>
    projectId === null ? null : deps.rootOf(projectId);

  handle(AI_DRAFT_CHANNELS.getDrafts, parseGetDrafts, async ({ projectId }) => {
    const root = rootOf(projectId);
    return root === undefined ? UNKNOWN_PROJECT : { ok: true, value: { drafts: await deps.drafts.list(root) } };
  });
  handle(AI_DRAFT_CHANNELS.saveDraft, parseSaveDraft, async ({ projectId, key, draft }) => {
    const root = rootOf(projectId);
    return root === undefined ? UNKNOWN_PROJECT : toIpcResult(await deps.drafts.save(root, key, draft));
  });
}
