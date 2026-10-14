import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  CHANNELS,
  parseDirRequest,
  parseFileRequest,
  parseNoPayload,
  parseProjectRequest,
  parseWriteFileRequest,
  toIpcResult,
  type Channel,
  type IpcResult,
} from '../shared/ipc/contract';
import type { ProjectService } from '../workspace/project-service';
import { safeOrigin } from './harden';

/**
 * IPC handlers for the typed contract in src/shared/ipc (S03.1). Every call is checked in this order before any
 * service runs: the sender is the workbench's top-level frame on the app origin, there is at most one argument, and
 * that argument passes the channel's parser. Anything else gets an error result and touches nothing.
 */

export interface SenderInfo {
  readonly url: string;
  readonly isTopLevel: boolean;
}

export function senderInfo(event: IpcMainInvokeEvent): SenderInfo | null {
  const frame = event.senderFrame;
  if (!frame) return null; // The frame navigated or was destroyed before the message was handled.
  return { url: frame.url, isTopLevel: frame.parent === null };
}

/** Only the workbench page itself may call: not an iframe, not another origin, not a destroyed frame. */
export function isTrustedSender(info: SenderInfo | null, allowedOrigin: string): boolean {
  return info !== null && info.isTopLevel && safeOrigin(info.url) === allowedOrigin;
}

export interface IpcDeps {
  /** `noobide://app` in production, the Vite dev server origin in development. */
  readonly allowedOrigin: string;
  readonly projects: Pick<ProjectService, 'open' | 'read' | 'write' | 'rootOf' | 'listDir'>;
  /** Shows the native folder picker; `null` when cancelled. */
  chooseFolder(event: IpcMainInvokeEvent): Promise<string | null>;
  revealFolder(folder: string): void;
}

const FORBIDDEN = { ok: false, code: 'forbidden-sender', message: 'sender is not the workbench' } as const;
const INVALID = { ok: false, code: 'invalid-request', message: 'payload does not match the contract' } as const;

export function registerIpcHandlers(ipc: Pick<IpcMain, 'handle'>, deps: IpcDeps): void {
  function handle<P>(
    channel: Channel,
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

  handle(CHANNELS.openFolder, parseNoPayload, async (_payload, event) => {
    const chosen = await deps.chooseFolder(event);
    if (chosen === null) return { ok: true, value: null };
    return toIpcResult(await deps.projects.open(chosen));
  });

  handle(CHANNELS.readFile, parseFileRequest, async (request) => toIpcResult(await deps.projects.read(request)));

  handle(CHANNELS.writeFile, parseWriteFileRequest, async (request) => toIpcResult(await deps.projects.write(request)));

  handle(CHANNELS.revealProject, parseProjectRequest, async ({ projectId }) => {
    const root = deps.projects.rootOf(projectId);
    if (root === undefined) return { ok: false, code: 'unknown-project', message: 'project is not open' };
    deps.revealFolder(root);
    return { ok: true, value: null };
  });

  // ── S07/S08: file tree, watcher and file operations ──
  handle(CHANNELS.listDir, parseDirRequest, async (request) => toIpcResult(await deps.projects.listDir(request)));
}
