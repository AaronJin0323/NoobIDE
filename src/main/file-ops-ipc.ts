import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { toIpcResult, type IpcResult } from '../shared/ipc/contract';
import {
  FILE_OPS_CHANNELS,
  parseChooseImportRequest,
  parseCopyEntriesRequest,
  parseImportEntriesRequest,
  parseRegisterDroppedRequest,
  parseImageInfoRequest,
  parseMoveEntriesRequest,
  parseTrashEntriesRequest,
} from '../shared/ipc/file-ops-contract';
import type { ProjectService } from '../workspace/project-service';
import { isTrustedSender, senderInfo } from './ipc';
import { projectImageInfo } from './project-images'; // S52.6
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { inspectSources, importEntry, type ImportSource } from '../workspace/import-files'; // S52.4
import type { ImportKind } from '../shared/import-rules';
import { MAX_IMPORT_ITEMS, type ImportCandidate } from '../shared/ipc/file-ops-contract';

/** S52.4: an entry from outside the project, chosen in a dialog (or dropped, S52.5) by one window. */
interface ChosenEntry {
  readonly windowId: number;
  readonly projectId: string;
  readonly kind: ImportKind;
  readonly path: string;
  readonly at: number;
}
const PICK_TTL_MS = 30 * 60 * 1000;
const MAX_PICKS = 1000;

/**
 * IPC handlers of S52 file management (file-ops-contract.ts). The same checks as every other handler, in the same
 * order, before the project service runs: the sender is the workbench's top-level frame on the app origin, there is
 * at most one argument, and it passes the channel's parser. The service resolves and realpath-checks every path.
 */
export interface FileOpsIpcDeps {
  readonly allowedOrigin: string;
  readonly projects: Pick<ProjectService, 'moveEntries' | 'copyEntries' | 'trashEntries'>;
  /** S52.6: the real root of an open project (image sizes for the viewer). */
  rootOf?(projectId: string): string | undefined;
  /** S52.4: the native open dialog of the sender's window; null when cancelled. */
  chooseImportPaths?(
    event: IpcMainInvokeEvent,
    options: { readonly kind: ImportKind; readonly title: string; readonly filterName: string },
  ): Promise<readonly string[] | null>;
  /**
   * S52.5, e2e only: Playwright cannot drag from Explorer/Finder, and the synthetic File objects of a test drop have
   * no OS path, so the test names them here through main's test hook. Only main code can set it, never a page.
   */
  testDropPaths?(): readonly string[] | undefined;
  /** Random ids for chosen entries (tests pass a counter). */
  newId?(): string;
  now?(): number;
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
  // --- S52.4/S52.5: entries from outside the project, kept in main by id (their paths never reach the renderer) ---
  const picks = new Map<string, ChosenEntry>();
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => randomBytes(12).toString('base64url'));
  /** Keeps the entries for this window and project; older ones expire, at most MAX_PICKS per window. */
  const remember = (
    event: IpcMainInvokeEvent,
    projectId: string,
    kind: ImportKind,
    sources: readonly ImportSource[],
  ) => {
    const at = now();
    for (const [id, pick] of picks) if (at - pick.at > PICK_TTL_MS) picks.delete(id);
    const own = [...picks].filter(([, pick]) => pick.windowId === event.sender.id);
    for (const [id] of own.slice(0, Math.max(0, own.length + sources.length - MAX_PICKS))) picks.delete(id);
    return sources.map((source): ImportCandidate => {
      const id = newId();
      picks.set(id, { windowId: event.sender.id, projectId, kind, path: source.path, at });
      return {
        id,
        name: source.name,
        kind: source.kind,
        bytes: source.bytes,
        refusal: source.refusal,
        ...(source.detail ? { detail: source.detail } : {}),
      };
    });
  };
  /** Registers entries from outside (also used by the S52.5 drop) and returns them as candidates. */
  const registerSources = async (
    event: IpcMainInvokeEvent,
    projectId: string,
    kind: ImportKind,
    paths: readonly string[],
  ) => remember(event, projectId, kind, await inspectSources(paths.slice(0, MAX_IMPORT_ITEMS), kind));

  handle(FILE_OPS_CHANNELS.chooseImport, parseChooseImportRequest, async (request, event) => {
    if (deps.rootOf?.(request.projectId) === undefined || !deps.chooseImportPaths) {
      return { ok: false, code: 'unknown-project', message: 'project is not open' };
    }
    const paths = await deps.chooseImportPaths(event, request);
    if (paths === null) return { ok: true, value: null };
    return { ok: true, value: await registerSources(event, request.projectId, request.kind, paths) };
  });

  handle(FILE_OPS_CHANNELS.registerDropped, parseRegisterDroppedRequest, async (request, event) => {
    if (deps.rootOf?.(request.projectId) === undefined) {
      return { ok: false, code: 'unknown-project', message: 'project is not open' };
    }
    const override = deps.testDropPaths?.();
    const paths = request.paths
      .map((p, i) => (p === '' ? (override?.[i] ?? '') : p))
      .filter((p) => p !== '' && path.isAbsolute(p));
    return { ok: true, value: await registerSources(event, request.projectId, 'files', paths) };
  });

  handle(FILE_OPS_CHANNELS.importEntries, parseImportEntriesRequest, async (request, event) => {
    const root = deps.rootOf?.(request.projectId);
    if (root === undefined) return { ok: false, code: 'unknown-project', message: 'project is not open' };
    const imported: { id: string; relPath: string; skippedLinks: number }[] = [];
    const failed: { id: string; code: string; message: string }[] = [];
    for (const item of request.items) {
      const pick = picks.get(item.id);
      // Only this window's entries for this project; an expired or foreign id copies nothing.
      if (!pick || pick.windowId !== event.sender.id || pick.projectId !== request.projectId) {
        failed.push({ id: item.id, code: 'unknown-id', message: 'chosen entry expired' });
        continue;
      }
      const result = await importEntry(root, pick.path, request.toFolder, item.name, pick.kind);
      if (result.ok) {
        imported.push({ id: item.id, ...result.value });
        picks.delete(item.id);
      } else failed.push({ id: item.id, code: result.code, message: result.message });
    }
    return { ok: true, value: { imported, failed } };
  });

  handle(FILE_OPS_CHANNELS.imageInfo, parseImageInfoRequest, async ({ projectId, relPath }) => {
    const root = deps.rootOf?.(projectId);
    if (root === undefined) return { ok: false, code: 'unknown-project', message: 'project is not open' };
    return toIpcResult(await projectImageInfo(root, relPath));
  });
}
