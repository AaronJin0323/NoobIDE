import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  CHANNELS,
  parseCloseAnswer,
  parseCreateEntryRequest,
  parseDirRequest,
  parseEntryRequest,
  parseRevealRequest,
  parseFileRequest,
  parseNoPayload,
  parseProjectRequest,
  parseRenameEntryRequest,
  parseWriteFileRequest,
  toIpcResult,
  type Channel,
  type CloseAnswer,
  type IpcResult,
} from '../shared/ipc/contract';
import type { ProjectService } from '../workspace/project-service';
import { safeOrigin } from './harden';
import { registerRecoveryHandlers, type RecoveryJournalPort } from './recovery-ipc';
import { registerCreateProjectHandlers, type CreateProjectPort } from './create-project-ipc'; // S20.2

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
  readonly projects: Pick<
    ProjectService,
    | 'open'
    | 'read'
    | 'write'
    | 'writeCopy'
    | 'rootOf'
    | 'listDir'
    | 'createEntry'
    | 'renameEntry'
    | 'trashEntry'
    | 'revealPath'
  >;
  /** Shows the native folder picker; `null` when cancelled. */
  chooseFolder(event: IpcMainInvokeEvent): Promise<string | null>;
  /** Shows the native save dialog for "save elsewhere", suggesting `fileName`; `null` when cancelled. */
  chooseSaveFile(event: IpcMainInvokeEvent, fileName: string): Promise<string | null>;
  revealFolder(folder: string): void;
  /** The workbench answered a close request (S10.6). */
  closeAnswered(event: IpcMainInvokeEvent, answer: CloseAnswer): void;
  /** After a refused close, the user chose to close without the unsaved edits (S10.6). */
  closeDiscarding(event: IpcMainInvokeEvent): void;
  // ── S07/S08: file tree, watcher and file operations ──
  /** Starts watching a just-opened project and reports changes to the window that opened it (S07.3). */
  projectOpened?(projectId: string, root: string, sender: IpcMainInvokeEvent['sender']): void;
  /** Electron's shell.trashItem: moves to the OS trash, never deletes permanently (S08.3). */
  trashItem(fullPath: string): Promise<void>;
  /** Electron's shell.showItemInFolder (S08.5). */
  revealItem(fullPath: string): void;
  /** S12: crash-recovery journal (src/recovery/journal.ts). */
  readonly journal: RecoveryJournalPort;
  /** S20.2: templates, default location and folder dialog of the create-project wizard. */
  readonly create?: CreateProjectPort;
}

/** Registers one channel behind the sender and payload checks. */
export type HandleFn = <P>(
  channel: Channel,
  parse: (payload: unknown) => P | null,
  run: (payload: P, event: IpcMainInvokeEvent) => Promise<IpcResult<unknown, string>>,
) => void;

const FORBIDDEN = { ok: false, code: 'forbidden-sender', message: 'sender is not the workbench' } as const;
const INVALID = { ok: false, code: 'invalid-request', message: 'payload does not match the contract' } as const;

export function registerIpcHandlers(ipc: Pick<IpcMain, 'handle'>, deps: IpcDeps): void {
  const handle: HandleFn = (channel, parse, run) => {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedSender(senderInfo(event), deps.allowedOrigin)) return FORBIDDEN;
      if (args.length > 1) return INVALID;
      const payload = parse(args[0]);
      if (payload === null) return INVALID;
      return run(payload, event);
    });
  };

  handle(CHANNELS.openFolder, parseNoPayload, async (_payload, event) => {
    const chosen = await deps.chooseFolder(event);
    if (chosen === null) return { ok: true, value: null };
    const opened = await deps.projects.open(chosen);
    if (opened.ok) deps.projectOpened?.(opened.value.projectId, opened.value.rootPath, event.sender);
    return toIpcResult(opened);
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

  handle(CHANNELS.closeDiscarding, parseNoPayload, async (_payload, event) => {
    deps.closeDiscarding(event);
    return { ok: true, value: null };
  });

  handle(CHANNELS.revealProject, parseProjectRequest, async ({ projectId }) => {
    const root = deps.projects.rootOf(projectId);
    if (root === undefined) return { ok: false, code: 'unknown-project', message: 'project is not open' };
    deps.revealFolder(root);
    return { ok: true, value: null };
  });

  // ── S07/S08: file tree, watcher and file operations ──
  handle(CHANNELS.listDir, parseDirRequest, async (request) => toIpcResult(await deps.projects.listDir(request)));
  handle(CHANNELS.createEntry, parseCreateEntryRequest, async (request) =>
    toIpcResult(await deps.projects.createEntry(request)),
  );
  handle(CHANNELS.renameEntry, parseRenameEntryRequest, async (request) =>
    toIpcResult(await deps.projects.renameEntry(request)),
  );
  handle(CHANNELS.trashEntry, parseEntryRequest, async (request) =>
    toIpcResult(await deps.projects.trashEntry(request, deps.trashItem)),
  );
  handle(CHANNELS.revealEntry, parseRevealRequest, async (request) => {
    const target = await deps.projects.revealPath(request);
    if (target.ok) deps.revealItem(target.value);
    return target.ok ? { ok: true, value: null } : toIpcResult(target);
  });
  // S12: crash-recovery journal channels.
  // S07.3: projects reopened by crash recovery are watched too (passes the sender like openFolder).
  registerRecoveryHandlers(handle, deps.projects, deps.journal, deps.projectOpened?.bind(deps));
  // S20.2: create-project wizard; the new project is watched like one opened from the folder dialog.
  registerCreateProjectHandlers(handle, deps.projects, deps.create, deps.projectOpened?.bind(deps));
}
