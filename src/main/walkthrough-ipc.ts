import type { IpcMain } from 'electron';
import { parseNoPayload } from '../shared/ipc/contract';
import { WALKTHROUGH_CHANNELS, parseWalkthroughState } from '../shared/ipc/walkthrough-contract';
import { isTrustedSender, senderInfo } from './ipc';
import type { WalkthroughStore } from './walkthrough-store';

/**
 * IPC handlers of the walkthrough channels (S23.1). Same checks as ipc.ts, in the same order: the sender is the
 * workbench's top-level frame on the app origin, at most one argument, and it passes the channel's parser.
 */
export interface WalkthroughIpcDeps {
  readonly allowedOrigin: string;
  readonly store: Pick<WalkthroughStore, 'get' | 'save'>;
}

const FORBIDDEN = { ok: false, code: 'forbidden-sender', message: 'sender is not the workbench' } as const;
const INVALID = { ok: false, code: 'invalid-request', message: 'payload does not match the contract' } as const;

export function registerWalkthroughIpcHandlers(ipc: Pick<IpcMain, 'handle'>, deps: WalkthroughIpcDeps): void {
  ipc.handle(WALKTHROUGH_CHANNELS.get, async (event, ...args: unknown[]) => {
    if (!isTrustedSender(senderInfo(event), deps.allowedOrigin)) return FORBIDDEN;
    if (args.length > 1 || parseNoPayload(args[0]) === null) return INVALID;
    return { ok: true, value: await deps.store.get() };
  });
  ipc.handle(WALKTHROUGH_CHANNELS.save, async (event, ...args: unknown[]) => {
    if (!isTrustedSender(senderInfo(event), deps.allowedOrigin)) return FORBIDDEN;
    if (args.length !== 1) return INVALID;
    const state = parseWalkthroughState(args[0]);
    if (state === null) return INVALID;
    await deps.store.save(state);
    return { ok: true, value: null };
  });
}
