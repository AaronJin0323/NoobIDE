import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { toIpcResult, type IpcResult } from '../shared/ipc/contract';
import {
  FILE_OPS_CHANNELS,
  parseCopyEntriesRequest,
  parseMoveEntriesRequest,
  parseTrashEntriesRequest,
} from '../shared/ipc/file-ops-contract';
import type { ProjectService } from '../workspace/project-service';
import { isTrustedSender, senderInfo } from './ipc';

/**
 * IPC handlers of S52 file management (file-ops-contract.ts). The same checks as every other handler, in the same
 * order, before the project service runs: the sender is the workbench's top-level frame on the app origin, there is
 * at most one argument, and it passes the channel's parser. The service resolves and realpath-checks every path.
 */
export interface FileOpsIpcDeps {
  readonly allowedOrigin: string;
  readonly projects: Pick<ProjectService, 'moveEntries' | 'copyEntries' | 'trashEntries'>;
  /** Electron's shell.trashItem: moves to the OS trash, never deletes permanently. */
  trashItem(fullPath: string): Promise<void>;
}

const FORBIDDEN = { ok: false, code: 'forbidden-sender', message: 'sender is not the workbench' } as const;
const INVALID = { ok: false, code: 'invalid-request', message: 'payload does not match the contract' } as const;

export function registerFileOpsIpcHandlers(ipc: Pick<IpcMain, 'handle'>, deps: FileOpsIpcDeps): void {
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

  handle(FILE_OPS_CHANNELS.moveEntries, parseMoveEntriesRequest, async (request) =>
    toIpcResult(await deps.projects.moveEntries(request)),
  );
  handle(FILE_OPS_CHANNELS.copyEntries, parseCopyEntriesRequest, async (request) =>
    toIpcResult(await deps.projects.copyEntries(request)),
  );
  handle(FILE_OPS_CHANNELS.trashEntries, parseTrashEntriesRequest, async (request) =>
    toIpcResult(await deps.projects.trashEntries(request, deps.trashItem)),
  );
}
