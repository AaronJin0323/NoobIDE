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
  groupBefore: CHANNELS.historyGroupBefore,
  groupRecord: CHANNELS.historyGroupRecord,
  groups: CHANNELS.historyGroups,
  groupUndone: CHANNELS.historyGroupUndone,
} as const;

export type HistoryReason =
  | 'before-save'
  | 'after-save'
  | 'before-format'
  | 'before-delete'
  | 'before-restore'
  /** S34.2: before / after an AI agent change. */
  | 'before-ai'
  | 'after-ai';

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
  /** S34.2: the change group (AI agent turn) this version was kept for. */
  readonly group?: string;
}

// ── S34.2: change groups — the applied changes of one AI agent turn, undoable together ──────────────────────────
export type HistoryGroupStepKind = 'edit' | 'create' | 'delete' | 'rename';

/** Which turn a change belongs to: the agent request id and a short label (the user's request). */
export interface HistoryGroupRef {
  readonly id: string;
  readonly label: string;
}

export interface HistoryGroupStep {
  readonly kind: HistoryGroupStepKind;
  readonly relPath: string;
  /** `rename`: the new path. */
  readonly to?: string;
  /** Version id of the content before the change (`edit`, `delete`); null when none could be kept. */
  readonly before: string | null;
  /** SHA-256 of what the change left on disk (`edit`, `create`). */
  readonly afterHash: string | null;
}

export interface HistoryGroup {
  readonly id: string;
  readonly kind: 'ai-agent';
  readonly label: string;
  readonly createdAt: number;
  /** When it was undone, or null. */
  readonly undoneAt: number | null;
  /** In the order they were applied. */
  readonly steps: readonly HistoryGroupStep[];
  /** Distinct paths the group touched (a renamed file counts once, by its new path). */
  readonly files: readonly string[];
}

export interface GroupBeforeRequest {
  readonly projectId: string;
  readonly groupId: string;
  readonly relPath: string;
}

export interface GroupRecordRequest {
  readonly projectId: string;
  readonly group: HistoryGroupRef;
  readonly step: {
    readonly kind: HistoryGroupStepKind;
    readonly relPath: string;
    readonly to?: string;
    /** The id `groupBefore` returned (`edit`, `delete`), else null. Main checks it belongs to the file. */
    readonly before: string | null;
  };
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
  /**
   * S34.2: right before an AI change is applied to an existing file, keeps its content as a `before-ai` version of
   * the group. `id` is null when the file does not exist or its content could not be kept.
   */
  groupBefore(request: GroupBeforeRequest): Promise<
    IpcResult<
      {
        readonly id: string | null;
        /** The history key the version was kept under (the file's real relative path); record the step with it. */
        readonly relPath: string | null;
      },
      HistoryError
    >
  >;
  /** S34.2: after an AI change was applied, adds it to its group (main keeps what is on disk now as `after-ai`). */
  groupRecord(request: GroupRecordRequest): Promise<IpcResult<null, HistoryError>>;
  /** S34.2: the open project's change groups, newest first. */
  groups(request: { readonly projectId: string }): Promise<IpcResult<readonly HistoryGroup[], HistoryError>>;
  /** S34.2: the group was undone (it is shown as undone from now on). */
  groupUndone(request: {
    readonly projectId: string;
    readonly groupId: string;
  }): Promise<IpcResult<null, HistoryError>>;
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
/** An agent request id (UUID) as a group id. */
const GROUP_ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_GROUP_LABEL = 2000;
const STEP_KINDS: readonly HistoryGroupStepKind[] = ['edit', 'create', 'delete', 'rename'];

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

export function parseGroupBeforeRequest(payload: unknown): GroupBeforeRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'groupId', 'relPath'])) return null;
  const { projectId, groupId, relPath } = payload;
  if (!isProjectId(projectId) || !isListedRelPath(relPath)) return null;
  return typeof groupId === 'string' && GROUP_ID.test(groupId) ? { projectId, groupId, relPath } : null;
}

export function parseGroupRecordRequest(payload: unknown): GroupRecordRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'group', 'step'])) return null;
  const { projectId, group, step } = payload;
  if (!isProjectId(projectId) || !isRecord(group) || !isRecord(step)) return null;
  if (!hasExactKeys(group, ['id', 'label'])) return null;
  if (typeof group.id !== 'string' || !GROUP_ID.test(group.id)) return null;
  if (typeof group.label !== 'string' || group.label.length > MAX_GROUP_LABEL) return null;
  const kind = step.kind as HistoryGroupStepKind;
  if (!STEP_KINDS.includes(kind)) return null;
  if (!hasExactKeys(step, kind === 'rename' ? ['kind', 'relPath', 'to', 'before'] : ['kind', 'relPath', 'before'])) {
    return null;
  }
  if (!isListedRelPath(step.relPath)) return null;
  if (kind === 'rename' && !isListedRelPath(step.to)) return null;
  const before = step.before;
  if (before !== null && (typeof before !== 'string' || !VERSION_ID.test(before))) return null;
  // Only edits and deletions have a "before" version; a created file had none.
  if (before !== null && kind !== 'edit' && kind !== 'delete') return null;
  return {
    projectId,
    group: { id: group.id, label: group.label },
    step: {
      kind,
      relPath: step.relPath,
      ...(kind === 'rename' ? { to: step.to as string } : {}),
      before,
    },
  };
}

export function parseGroupUndoneRequest(payload: unknown): { projectId: string; groupId: string } | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'groupId'])) return null;
  const { projectId, groupId } = payload;
  return isProjectId(projectId) && typeof groupId === 'string' && GROUP_ID.test(groupId)
    ? { projectId, groupId }
    : null;
}
