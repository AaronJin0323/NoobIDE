/**
 * Typed contract of project checkpoints (S56). Pure TypeScript: no Electron, Node or DOM imports. Exposed by the
 * preload as `window.noobide.checkpoints`.
 *
 * Invariants:
 * - Checkpoints live in the app-data directory only (src/recovery/checkpoints.ts), never in the project folder. They
 *   are not version control: no branches, no commits, no sharing — a named picture of the project to go back to.
 * - The renderer names a project by its opaque `projectId`, a checkpoint by its id, a file by its portable relative
 *   path. Main maps them to real paths and checks every path stays inside the project.
 * - A restore never writes a file behind its editor: an open text file is restored through its tab (one undo step,
 *   the tab's save pipeline); `restoreFile` writes only closed files, atomically, and only while the file is still
 *   exactly the version the comparison saw (`expectedHash`; null = it must not exist). File contents cross IPC only
 *   on `readText` and are never logged.
 */
import { isListedRelPath, isProjectId, type IpcResult } from './contract';

export const CHECKPOINT_CHANNELS = {
  list: 'checkpoints:list',
  create: 'checkpoints:create',
  rename: 'checkpoints:rename',
  delete: 'checkpoints:delete',
  compare: 'checkpoints:compare',
  readText: 'checkpoints:read-text',
  restoreFile: 'checkpoints:restore-file',
} as const;

export type CheckpointKind = 'named' | 'auto';
/** Why the checkpoint was taken: by the user, or automatically right before an operation (S56.3). */
export type CheckpointCause = 'manual' | 'before-ai' | 'before-history-restore' | 'before-checkpoint-restore';
const AUTO_CAUSES: readonly CheckpointCause[] = ['before-ai', 'before-history-restore', 'before-checkpoint-restore'];

export const MAX_CHECKPOINT_NAME = 80;
/** `<createdAt>-<8 hex>` (src/recovery/checkpoints.ts). */
const CHECKPOINT_ID = /^\d{1,16}-[0-9a-f]{8}$/;
const HASH = /^[0-9a-f]{64}$/;

export interface CheckpointInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: CheckpointKind;
  readonly cause: CheckpointCause;
  readonly createdAt: number;
  readonly fileCount: number;
  readonly bytes: number;
}

export interface DamagedCheckpointInfo {
  readonly id: string;
  readonly reason: 'corrupt' | 'unreadable' | 'newer-format';
}

export interface CheckpointUsageInfo {
  /** Unique bytes over all projects' checkpoints, against `maxTotalBytes`. */
  readonly totalBytes: number;
  readonly projectBytes: number;
  readonly maxTotalBytes: number;
  readonly named: number;
  readonly automatic: number;
  readonly maxNamed: number;
  readonly maxAuto: number;
  readonly maxAutoAgeDays: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
}

export interface CheckpointListing {
  /** Newest first. */
  readonly checkpoints: readonly CheckpointInfo[];
  readonly damaged: readonly DamagedCheckpointInfo[];
  readonly usage: CheckpointUsageInfo;
}

export type CheckpointCompareStatus = 'added' | 'changed' | 'removed' | 'same';

export interface CheckpointCompareEntry {
  readonly relPath: string;
  readonly status: CheckpointCompareStatus;
  /** SHA-256 of the file in the project now; null when it does not exist (`removed`). */
  readonly currentHash: string | null;
  readonly checkpointSize: number | null;
  /** False when the checkpoint's copy of this file is missing or damaged. */
  readonly available: boolean;
}

export interface CheckpointComparison {
  readonly checkpoint: CheckpointInfo;
  readonly entries: readonly CheckpointCompareEntry[];
  readonly incomplete: boolean;
}

export type CheckpointErrorCode =
  | 'unknown-project'
  | 'too-many-files'
  | 'file-too-large'
  | 'checkpoint-too-large'
  | 'storage-full'
  | 'too-many-named'
  | 'invalid-name'
  | 'unavailable'
  | 'read-failed'
  | 'write-failed'
  | 'not-found'
  | 'damaged'
  | 'corrupt'
  | 'missing'
  /** A file changed while the checkpoint was being saved: nothing was kept. */
  | 'project-changed'
  /** A file name a checkpoint cannot hold; `detail.relPath` names it. */
  | 'unsupported-path'
  | 'not-text'
  /** restoreFile: the file is no longer the version the comparison saw (or exists again); nothing was written. */
  | 'changed-on-disk'
  | 'outside-project'
  | 'permission-denied'
  | 'disk-full';

/** Why a checkpoint was refused: the file or sizes concerned (never contents). */
export interface CheckpointRefusal {
  readonly relPath?: string;
  readonly bytes?: number;
  readonly limit?: number;
}

/** A failure may carry the refusal's details. */
export type CheckpointResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: CheckpointErrorCode | 'forbidden-sender' | 'invalid-request';
      readonly message: string;
      readonly detail?: CheckpointRefusal;
    };

export interface CreateCheckpointRequest {
  readonly projectId: string;
  readonly name: string;
  readonly kind: CheckpointKind;
  /** `manual` with `named`; an automatic checkpoint names the operation it is taken before. */
  readonly cause: CheckpointCause;
  /** `before-checkpoint-restore` only: the checkpoint being restored, never pruned by this create. */
  readonly keep?: string;
}

export interface CheckpointRef {
  readonly projectId: string;
  readonly id: string;
}

export interface CheckpointFileRef extends CheckpointRef {
  readonly relPath: string;
}

export interface RestoreFileRequest extends CheckpointFileRef {
  /** The file's SHA-256 as the comparison saw it, or null when it did not exist (it is then created). */
  readonly expectedHash: string | null;
}

export interface CheckpointsApi {
  list(request: { readonly projectId: string }): Promise<IpcResult<CheckpointListing, CheckpointErrorCode>>;
  create(
    request: CreateCheckpointRequest,
  ): Promise<CheckpointResult<{ readonly checkpoint: CheckpointInfo; readonly deduped: boolean }>>;
  rename(request: CheckpointRef & { readonly name: string }): Promise<CheckpointResult<CheckpointInfo>>;
  delete(request: CheckpointRef): Promise<IpcResult<null, CheckpointErrorCode>>;
  compare(request: CheckpointRef): Promise<IpcResult<CheckpointComparison, CheckpointErrorCode>>;
  /** A file's text in the checkpoint (`not-text` for binary or non-UTF-8 files). */
  readText(
    request: CheckpointFileRef,
  ): Promise<IpcResult<{ readonly text: string; readonly bom: boolean }, CheckpointErrorCode>>;
  /** Writes one closed file back from the checkpoint (atomic, never over a version the comparison did not see). */
  restoreFile(request: RestoreFileRequest): Promise<IpcResult<{ readonly relPath: string }, CheckpointErrorCode>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

const isName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_CHECKPOINT_NAME * 4;

export const isCheckpointIdValue = (value: unknown): value is string =>
  typeof value === 'string' && CHECKPOINT_ID.test(value);

export function parseCheckpointProject(payload: unknown): { projectId: string } | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId'])) return null;
  return isProjectId(payload.projectId) ? { projectId: payload.projectId } : null;
}

export function parseCreateCheckpoint(payload: unknown): CreateCheckpointRequest | null {
  if (!isRecord(payload)) return null;
  const withKeep = Object.hasOwn(payload, 'keep');
  const keys = ['projectId', 'name', 'kind', 'cause', ...(withKeep ? ['keep'] : [])];
  if (!hasExactKeys(payload, keys)) return null;
  const { projectId, name, kind, cause, keep } = payload;
  if (!isProjectId(projectId) || !isName(name)) return null;
  if (withKeep) {
    if (kind !== 'auto' || cause !== 'before-checkpoint-restore' || !isCheckpointIdValue(keep)) return null;
    return { projectId, name, kind, cause, keep };
  }
  // A named checkpoint is the user's (cause manual); an automatic one always names its operation.
  if (kind === 'named' && cause === 'manual') return { projectId, name, kind, cause };
  if (kind === 'auto' && AUTO_CAUSES.includes(cause as CheckpointCause)) {
    return { projectId, name, kind, cause: cause as CheckpointCause };
  }
  return null;
}

export function parseCheckpointRef(payload: unknown): CheckpointRef | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'id'])) return null;
  const { projectId, id } = payload;
  return isProjectId(projectId) && isCheckpointIdValue(id) ? { projectId, id } : null;
}

export function parseRenameCheckpoint(payload: unknown): (CheckpointRef & { name: string }) | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'id', 'name'])) return null;
  const { projectId, id, name } = payload;
  return isProjectId(projectId) && isCheckpointIdValue(id) && isName(name) ? { projectId, id, name } : null;
}

export function parseCheckpointFile(payload: unknown): CheckpointFileRef | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'id', 'relPath'])) return null;
  const { projectId, id, relPath } = payload;
  return isProjectId(projectId) && isCheckpointIdValue(id) && isListedRelPath(relPath)
    ? { projectId, id, relPath }
    : null;
}

export function parseRestoreFile(payload: unknown): RestoreFileRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'id', 'relPath', 'expectedHash'])) return null;
  const { projectId, id, relPath, expectedHash } = payload;
  if (!isProjectId(projectId) || !isCheckpointIdValue(id) || !isListedRelPath(relPath)) return null;
  if (expectedHash !== null && (typeof expectedHash !== 'string' || !HASH.test(expectedHash))) return null;
  return { projectId, id, relPath, expectedHash };
}
