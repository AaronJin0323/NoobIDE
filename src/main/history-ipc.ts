import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseNoPayload, parseProjectRequest, type IpcResult } from '../shared/ipc/contract';
import {
  HISTORY_CHANNELS,
  parseClearRequest,
  parseHistoryFileRequest,
  parseOverviewRequest,
  parseRestoreDeletedRequest,
  parseVersionRequest,
  type HistoryError,
  type HistoryFile,
  type HistoryOverview,
  type HistoryVersion,
} from '../shared/ipc/history-contract';
import { historyKey, type SnapshotStore } from '../recovery/history';
import type { HistoryTriggers } from '../recovery/history-triggers';
import { errorCode } from '../recovery/atomic-file';
import { absoluteFromRel, isInside, resolveExisting } from '../workspace/paths';
import { decodeText } from '../workspace/text-codec';
import type { ProjectService } from '../workspace/project-service';
import type { HandleFn } from './ipc';

/**
 * Handlers of the local-history window (S21.3, S21.4), registered through ipc.ts's `handle` (sender + payload checks
 * first). History lives in the app-data directory (never in the project) and is keyed by the project's real root
 * path plus the file's real relative path in NFC (src/recovery/history.ts, ADR 0006).
 *
 * Restoring an existing file never writes it from here: the renderer loads the version into the file's editor tab
 * and saves it through the normal save pipeline. Main only takes the `before-restore` snapshot of what is on disk.
 * Restoring a *deleted* file creates it again without ever replacing anything (link() refuses an existing name).
 */
export interface HistoryPort {
  readonly store: Pick<SnapshotStore, 'files' | 'list' | 'read' | 'usage' | 'projects' | 'clear' | 'cleanup' | 'dir'>;
  readonly triggers: Pick<HistoryTriggers, 'beforeRestore'>;
  /** Shows the history folder in the file manager (shell.showItemInFolder / openPath). */
  revealFolder(folder: string): void;
}

const UNKNOWN_PROJECT = { ok: false, code: 'unknown-project', message: 'project is not open' } as const;
const UNAVAILABLE = { ok: false, code: 'unavailable', message: 'history is not available' } as const;

/** The history key of a file: its real path relative to the root when it exists (canonical case), else as given. */
async function keyOf(root: string, relPath: string): Promise<{ key: string; absPath: string | null }> {
  const resolved = await resolveExisting(root, relPath);
  if (resolved.ok && resolved.path !== root) {
    return {
      key: path.relative(root, resolved.path).split(path.sep).join('/').normalize('NFC'),
      absPath: resolved.path,
    };
  }
  return { key: historyKey(relPath), absPath: null };
}

async function isFile(absPath: string | null): Promise<boolean> {
  if (absPath === null) return false;
  try {
    return (await stat(absPath)).isFile();
  } catch {
    return false;
  }
}

function failure(e: unknown): HistoryError {
  switch (errorCode(e)) {
    case 'EEXIST':
      return 'exists';
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'permission-denied';
    case 'ENOSPC':
    case 'EDQUOT':
      return 'disk-full';
    default:
      return 'restore-failed';
  }
}

/** Errno codes of link() meaning "no hard links on this volume": fall back to an exclusive create. */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EINVAL']);

/**
 * Creates `relPath` inside `root` with `data`, never replacing anything: missing parent folders are created (each
 * realpath-checked inside the project), the content goes to a temporary file in the same folder, and link() gives it
 * the final name — which fails if the name exists. Volumes without hard links use an exclusive create (`wx`).
 */
export async function createFileExclusive(root: string, relPath: string, data: Uint8Array): Promise<string> {
  const target = absoluteFromRel(root, relPath);
  if (target === null || target === root) throw Object.assign(new Error('outside'), { code: 'OUTSIDE' });
  // The nearest existing ancestor must really be inside the project (links and junctions are followed by realpath).
  const segments = relPath.split('/');
  let existing = root;
  let depth = 0;
  for (let i = segments.length - 1; i > 0; i -= 1) {
    const probe = await resolveExisting(root, segments.slice(0, i).join('/'));
    if (probe.ok) {
      existing = probe.path;
      depth = i;
      break;
    }
    if (probe.code === 'outside-project') throw Object.assign(new Error('outside'), { code: 'OUTSIDE' });
  }
  let parent = existing;
  for (const segment of segments.slice(depth, -1)) {
    parent = path.join(parent, segment);
    await mkdir(parent).catch((e: unknown) => {
      if (errorCode(e) !== 'EEXIST') throw e;
    });
  }
  const realParent = await realpath(parent);
  if (realParent !== root && !isInside(root, realParent))
    throw Object.assign(new Error('outside'), { code: 'OUTSIDE' });
  const name = segments[segments.length - 1] as string;
  const final = path.join(realParent, name);
  // Refuse early with a clear code; link() / `wx` below make the check race-free.
  const taken = await lstat(final).then(
    () => true,
    () => false,
  );
  if (taken) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
  const temp = path.join(realParent, `.noobide-restore-${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(temp, data, { flag: 'wx' });
  try {
    await link(temp, final);
  } catch (e) {
    if (!LINK_UNSUPPORTED.has(errorCode(e))) throw e;
    await writeFile(final, data, { flag: 'wx' });
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  return final;
}

export function registerHistoryHandlers(
  handle: HandleFn,
  projects: Pick<ProjectService, 'rootOf'>,
  port: HistoryPort | undefined,
): void {
  handle(
    HISTORY_CHANNELS.files,
    parseProjectRequest,
    async ({ projectId }): Promise<IpcResult<readonly HistoryFile[], HistoryError>> => {
      const root = projects.rootOf(projectId);
      if (root === undefined) return UNKNOWN_PROJECT;
      if (!port) return UNAVAILABLE;
      const files = await port.store.files(root);
      if (!files.ok) return { ok: false, code: 'unavailable', message: files.message };
      const out: HistoryFile[] = [];
      for (const relPath of files.value) {
        const versions = await port.store.list(root, relPath);
        const target = absoluteFromRel(root, relPath);
        out.push({ relPath, versions: versions.ok ? versions.value.length : 0, exists: await isFile(target) });
      }
      return { ok: true, value: out };
    },
  );

  handle(
    HISTORY_CHANNELS.versions,
    parseHistoryFileRequest,
    async ({ projectId, relPath }): Promise<IpcResult<readonly HistoryVersion[], HistoryError>> => {
      const root = projects.rootOf(projectId);
      if (root === undefined) return UNKNOWN_PROJECT;
      if (!port) return UNAVAILABLE;
      const { key } = await keyOf(root, relPath);
      const list = await port.store.list(root, key);
      if (!list.ok) return { ok: false, code: 'unavailable', message: list.message };
      return {
        ok: true,
        value: list.value.map((m) => ({ id: m.id, createdAt: m.createdAt, reason: m.reason, size: m.size })),
      };
    },
  );

  handle(HISTORY_CHANNELS.read, parseVersionRequest, async ({ projectId, relPath, id }) => {
    const root = projects.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    if (!port) return UNAVAILABLE;
    const { key } = await keyOf(root, relPath);
    const data = await port.store.read(root, key, id);
    if (!data.ok) return { ok: false, code: data.code, message: data.message };
    const decoded = decodeText(data.value);
    if (!decoded.ok) return { ok: false, code: 'not-text', message: decoded.reason };
    return { ok: true, value: { text: decoded.text, bom: decoded.bom } };
  });

  handle(HISTORY_CHANNELS.beforeRestore, parseHistoryFileRequest, async ({ projectId, relPath }) => {
    const root = projects.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    if (!port) return UNAVAILABLE;
    const { key, absPath } = await keyOf(root, relPath);
    if (!(await isFile(absPath)) || absPath === null) return { ok: false, code: 'not-found', message: 'no such file' };
    await port.triggers.beforeRestore(root, key, absPath);
    return { ok: true, value: null };
  });

  handle(HISTORY_CHANNELS.restoreDeleted, parseRestoreDeletedRequest, async ({ projectId, relPath, id }) => {
    const root = projects.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    if (!port) return UNAVAILABLE;
    const key = historyKey(relPath);
    const data = await port.store.read(root, key, id);
    if (!data.ok) return { ok: false, code: data.code, message: data.message };
    try {
      await createFileExclusive(root, relPath, data.value);
    } catch (e) {
      if (errorCode(e) === 'OUTSIDE') return { ok: false, code: 'outside-project', message: 'path leaves the project' };
      return { ok: false, code: failure(e), message: errorCode(e) };
    }
    return { ok: true, value: { relPath } };
  });

  handle(
    HISTORY_CHANNELS.overview,
    parseOverviewRequest,
    async ({ projectId }): Promise<IpcResult<HistoryOverview, never>> => {
      const usage = port
        ? await port.store.usage()
        : {
            totalBytes: 0,
            onDiskBytes: 0,
            versions: 0,
            quarantined: 0,
            unavailable: 0,
            limits: { maxTotalBytes: 0, maxVersionsPerFile: 0, maxBytesPerFile: 0 },
          };
      const all = port ? await port.store.projects() : [];
      const root = projectId === null ? undefined : projects.rootOf(projectId);
      const orphans = [];
      let current = null;
      for (const project of all) {
        if (root !== undefined && project.rootPath === root) current = project;
        else if (
          !(await stat(project.rootPath).then(
            (s) => s.isDirectory(),
            () => false,
          ))
        )
          orphans.push(project);
      }
      return {
        ok: true,
        value: {
          usage: {
            totalBytes: usage.totalBytes,
            onDiskBytes: usage.onDiskBytes,
            versions: usage.versions,
            quarantined: usage.quarantined,
            unavailable: usage.unavailable,
            maxTotalBytes: usage.limits.maxTotalBytes,
            maxVersionsPerFile: usage.limits.maxVersionsPerFile,
            maxBytesPerFile: usage.limits.maxBytesPerFile,
          },
          location: port?.store.dir ?? '',
          orphans,
          current,
        },
      };
    },
  );

  handle(HISTORY_CHANNELS.clear, parseClearRequest, async (request): Promise<IpcResult<null, HistoryError>> => {
    if (!port) return UNAVAILABLE;
    let rootPath: string | undefined;
    if (request.scope === 'project') {
      rootPath = projects.rootOf(request.projectId);
      if (rootPath === undefined) return UNKNOWN_PROJECT;
    } else if (request.scope === 'orphan') {
      // Only a history main itself lists as orphaned can be cleared by key (never an open project's by accident).
      const project = (await port.store.projects()).find((p) => p.key === request.key);
      if (!project) return { ok: false, code: 'not-found', message: 'no history with this key' };
      if (
        await stat(project.rootPath).then(
          () => true,
          () => false,
        )
      ) {
        return { ok: false, code: 'not-found', message: 'the project folder exists; it is not orphaned' };
      }
      rootPath = project.rootPath;
    }
    const result = await port.store.clear(rootPath);
    return result.ok ? { ok: true, value: null } : { ok: false, code: 'clear-failed', message: result.message };
  });

  handle(HISTORY_CHANNELS.cleanup, parseNoPayload, async () => {
    if (!port) return { ok: true, value: { removedBytes: 0 } };
    const result = await port.store.cleanup();
    return { ok: true, value: { removedBytes: result.removedBytes } };
  });

  handle(HISTORY_CHANNELS.reveal, parseNoPayload, async () => {
    if (port) {
      await mkdir(port.store.dir, { recursive: true }).catch(() => undefined);
      port.revealFolder(port.store.dir);
    }
    return { ok: true, value: null };
  });
}
