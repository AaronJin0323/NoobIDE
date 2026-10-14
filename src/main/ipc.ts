import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  CHANNELS,
  parseCloseAnswer,
  parseFileRequest,
  parseNoPayload,
  parseProjectRequest,
  parseWriteFileRequest,
  toIpcResult,
  type Channel,
  type CloseAnswer,
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
  readonly projects: Pick<ProjectService, 'open' | 'read' | 'write' | 'writeCopy' | 'rootOf'>;
  /** Shows the native folder picker; `null` when cancelled. */
  chooseFolder(event: IpcMainInvokeEvent): Promise<string | null>;
  /** Shows the native save dialog for "save elsewhere", suggesting `fileName`; `null` when cancelled. */
  chooseSaveFile(event: IpcMainInvokeEvent, fileName: string): Promise<string | null>;
  revealFolder(folder: string): void;
  /** The workbench answered a close request (S10.6). */
  closeAnswered(event: IpcMainInvokeEvent, answer: CloseAnswer): void;
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

  handle(CHANNELS.saveCopy, parseWriteFileRequest, async (request, event) => {
    if (deps.projects.rootOf(request.projectId) === undefined) {
      return { ok: false, code: 'unknown-project', message: 'project is not open' };
    }
    const fileName = request.relPath.slice(request.relPath.lastIndexOf('/') + 1);
    const destination = await deps.chooseSaveFile(event, fileName);
    if (destination === null) return { ok: true, value: null };
    return toIpcResult(await deps.projects.writeCopy(destination, request));
  });

  handle(CHANNELS.answerClose, parseCloseAnswer, async (answer, event) => {
    deps.closeAnswered(event, answer);
    return { ok: true, value: null };
  });

  handle(CHANNELS.revealProject, parseProjectRequest, async ({ projectId }) => {
    const root = deps.projects.rootOf(projectId);
    if (root === undefined) return { ok: false, code: 'unknown-project', message: 'project is not open' };
    deps.revealFolder(root);
    return { ok: true, value: null };
  });
}
