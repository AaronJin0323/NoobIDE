import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { parseCommandContext, type CommandContext } from '../shared/commands';
import { COMMAND_CHANNELS } from '../shared/ipc/commands-contract';
import { isTrustedSender, senderInfo } from './ipc';

export interface CommandIpcDeps {
  readonly allowedOrigin: string;
  /** The workbench page `senderId` (its webContents id) reported its command context. */
  setContext(senderId: number, context: CommandContext): void;
}

const FORBIDDEN = { ok: false, code: 'forbidden-sender', message: 'sender is not the workbench' } as const;
const INVALID = { ok: false, code: 'invalid-request', message: 'payload does not match the contract' } as const;

/** S24.2: the command-context channel. Same checks as ipc.ts: trusted top-level sender, one valid argument. */
export function registerCommandIpcHandlers(ipc: Pick<IpcMain, 'handle'>, deps: CommandIpcDeps): void {
  ipc.handle(COMMAND_CHANNELS.setContext, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!isTrustedSender(senderInfo(event), deps.allowedOrigin)) return FORBIDDEN;
    if (args.length !== 1) return INVALID;
    const context = parseCommandContext(args[0]);
    if (context === null) return INVALID;
    deps.setContext(event.sender.id, context);
    return { ok: true, value: null };
  });
}
