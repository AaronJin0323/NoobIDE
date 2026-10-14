/**
 * Typed contract of the local-history window (S21.3 browse, compare, restore; S21.4 storage, clear, reveal). Pure
 * TypeScript, shared by main, preload and renderer like contract.ts. The renderer names files only by an open
 * project's id plus a portable relative path, versions by their id, other projects' histories by their opaque key.
 * Version text crosses IPC only on `read` and is never logged.
 */
import { CHANNELS, isListedRelPath, isPortableRelPath, isProjectId, type IpcResult } from './contract';

export const HISTORY_CHANNELS = {
  files: CHANNELS.historyFiles,
  versions: CHANNELS.historyVersions,
  read: CHANNELS.historyRead,
  beforeRestore: CHANNELS.historyBeforeRestore,
  restoreDeleted: CHANNELS.historyRestoreDeleted,
  overview: CHANNELS.historyOverview,
  clear: CHANNELS.historyClear,
  cleanup: CHANNELS.historyCleanup,
  reveal: CHANNELS.historyReveal,
} as const;

export type HistoryReason = 'before-save' | 'after-save' | 'before-format' | 'before-delete' | 'before-restore';

export interface HistoryFile {
  /** Portable relative path the history is kept under. */
  readonly relPath: string;
  readonly versions: number;
  /** False when the file was deleted (or moved) since: it can be restored from here. */
  readonly exists: boolean;
}

export interface HistoryVersion {
  readonly id: string;
  readonly createdAt: number;
  readonly reason: HistoryReason;
  readonly size: number;
}

export interface HistoryVersionText {
  readonly text: string;
  readonly bom: boolean;
}

export interface HistoryProject {
  /** Opaque key of a project's history (never a path). */
  readonly key: string;
  /** Where the project was; shown so the user recognises it. */
  readonly rootPath: string;
  readonly files: number;
  readonly versions: number;
  readonly bytes: number;
}

export interface HistoryOverview {
  readonly usage: {
    readonly totalBytes: number;
    readonly onDiskBytes: number;
    readonly versions: number;
    readonly quarantined: number;
    readonly unavailable: number;
    readonly maxTotalBytes: number;
    readonly maxVersionsPerFile: number;
    readonly maxBytesPerFile: number;
  };
  /** The history folder in the app-data directory (display only; `reveal` opens it). */
  readonly location: string;
  /** Histories of projects whose folder no longer exists (ADR 0006). */
  readonly orphans: readonly HistoryProject[];
  /** The open project's history size, or null when no project (or no history) is given. */
  readonly current: HistoryProject | null;
}

export type HistoryError =
  | 'unknown-project'
  /** The history index is locked or written by a newer version: kept, not usable right now. */
  | 'unavailable'
  | 'not-found'
  | 'corrupt'
  /** The version is not UTF-8 text (binary or another encoding). */
  | 'not-text'
  /** Restoring a deleted file: something with that name exists again; never overwritten. */
  | 'exists'
  | 'outside-project'
  | 'permission-denied'
  | 'disk-full'
  | 'restore-failed'
  | 'clear-failed';

export type ClearHistoryRequest =
  | { readonly scope: 'project'; readonly projectId: string }
  | { readonly scope: 'orphan'; readonly key: string }
  | { readonly scope: 'all' };

export interface VersionRequest {
  readonly projectId: string;
  readonly relPath: string;
  readonly id: string;
}

export interface HistoryApi {
  /** Files of the open project that have history, including deleted ones. */
  files(request: { readonly projectId: string }): Promise<IpcResult<readonly HistoryFile[], HistoryError>>;
  /** Versions of one file, newest first. */
  versions(request: {
    readonly projectId: string;
    readonly relPath: string;
  }): Promise<IpcResult<readonly HistoryVersion[], HistoryError>>;
  read(request: VersionRequest): Promise<IpcResult<HistoryVersionText, HistoryError>>;
  /** Keeps the file's current content on disk as a version (reason before-restore) right before a restore. */
  beforeRestore(request: {
    readonly projectId: string;
    readonly relPath: string;
  }): Promise<IpcResult<null, HistoryError>>;
  /** Creates a deleted file again with a version's content; refuses if anything has that name now. */
  restoreDeleted(request: VersionRequest): Promise<IpcResult<{ readonly relPath: string }, HistoryError>>;
  overview(request: { readonly projectId: string | null }): Promise<IpcResult<HistoryOverview, never>>;
  clear(request: ClearHistoryRequest): Promise<IpcResult<null, HistoryError>>;
  /** Re-applies the limits and removes unreferenced data. */
  cleanup(): Promise<IpcResult<{ readonly removedBytes: number }, never>>;
  /** Shows the history folder in Explorer / Finder. */
  reveal(): Promise<IpcResult<null, never>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

/** `<createdAt>-<12 hex of the hash>-<seq>` (src/recovery/history.ts). */
const VERSION_ID = /^\d{1,16}-[0-9a-f]{12}-\d{1,16}$/;
const HISTORY_KEY = /^[0-9a-f]{32}$/;

export function parseHistoryFileRequest(payload: unknown): { projectId: string; relPath: string } | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'relPath'])) return null;
  const { projectId, relPath } = payload;
  return isProjectId(projectId) && isListedRelPath(relPath) ? { projectId, relPath } : null;
}

export function parseVersionRequest(payload: unknown): VersionRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'relPath', 'id'])) return null;
  const { projectId, relPath, id } = payload;
  if (!isProjectId(projectId) || !isListedRelPath(relPath)) return null;
  return typeof id === 'string' && VERSION_ID.test(id) ? { projectId, relPath, id } : null;
}

/** Restoring creates a file, so its path must be portable (the same rules as any new name). */
export function parseRestoreDeletedRequest(payload: unknown): VersionRequest | null {
  const request = parseVersionRequest(payload);
  return request && isPortableRelPath(request.relPath) ? request : null;
}

export function parseOverviewRequest(payload: unknown): { projectId: string | null } | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId'])) return null;
  const { projectId } = payload;
  return projectId === null || isProjectId(projectId) ? { projectId } : null;
}

export function parseClearRequest(payload: unknown): ClearHistoryRequest | null {
  if (!isRecord(payload)) return null;
  if (payload.scope === 'all' && hasExactKeys(payload, ['scope'])) return { scope: 'all' };
  if (payload.scope === 'project' && hasExactKeys(payload, ['scope', 'projectId']) && isProjectId(payload.projectId)) {
    return { scope: 'project', projectId: payload.projectId };
  }
  if (payload.scope === 'orphan' && hasExactKeys(payload, ['scope', 'key'])) {
    return typeof payload.key === 'string' && HISTORY_KEY.test(payload.key)
      ? { scope: 'orphan', key: payload.key }
      : null;
  }
  return null;
}
