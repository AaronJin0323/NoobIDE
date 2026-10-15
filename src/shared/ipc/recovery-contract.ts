/**
 * Typed contract of the crash-recovery journal channels (S12). Pure TypeScript, shared by main, preload and
 * renderer like contract.ts; the channel names live in CHANNELS there. Journal text crosses IPC only on these
 * channels and is never logged.
 */
import {
  MAX_TEXT_FILE_BYTES,
  isPortableRelPath,
  isProjectId,
  type FileContent,
  type IpcResult,
  type OpenFolderError,
  type OpenedProject,
  type ReadFileError,
  type SavedCopy,
  type WriteFileError,
} from './contract';

const BUFFER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_KEY = /^[0-9a-f]{32}$/;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;

/** Identifies one editor buffer of a file: a fresh random id each time a file is loaded into the editor. */
export interface BufferRef {
  readonly projectId: string;
  readonly relPath: string;
  readonly bufferId: string;
}

export interface JournalRecordRequest extends BufferRef {
  readonly revision: number;
  readonly text: string;
  readonly bom: boolean;
}

export interface JournalSavedRequest extends BufferRef {
  /** The revision that is now on disk. */
  readonly revision: number;
}

export type JournalRecordError = 'unknown-project' | 'too-large' | 'quota-exceeded' | 'write-failed';

export interface PendingRecoveryFile {
  readonly relPath: string;
  readonly bufferId: string;
  readonly revision: number;
  readonly updatedAt: number;
}

export interface PendingRecoveryProject {
  /** Opaque key to reopen the project without the folder dialog. */
  readonly key: string;
  readonly name: string;
  /** For display only. */
  readonly rootPath: string;
  readonly files: readonly PendingRecoveryFile[];
}

export interface PendingRecovery {
  readonly projects: readonly PendingRecoveryProject[];
  readonly usage: { readonly bytes: number; readonly entries: number; readonly maxTotalBytes: number };
}

export interface RecoveredEntry {
  readonly relPath: string;
  readonly bufferId: string;
  readonly revision: number;
  readonly updatedAt: number;
  readonly text: string;
  readonly bom: boolean;
  /** The file as it is on disk now, to compare with; `null` when it cannot be read (see `diskError`). */
  readonly disk: FileContent | null;
  readonly diskError: ReadFileError | null;
}

export type RecoveryReadError = 'unknown-project' | 'not-found' | 'corrupt';

/**
 * Decision 0033: a pending copy named by its project key (from listPending) and buffer id. Works without an open
 * project, so copies stay reachable when the project folder was moved, renamed or is on a missing drive.
 */
export interface PendingRef {
  readonly key: string;
  readonly bufferId: string;
}

/** The text of a pending copy, read without opening its project (nothing on disk to compare with). */
export interface PendingEntry {
  readonly relPath: string;
  readonly bufferId: string;
  readonly revision: number;
  readonly updatedAt: number;
  readonly text: string;
  readonly bom: boolean;
}

export type PendingReadError = 'not-found' | 'corrupt';

/** Saved with the native save dialog (in main); the journal copy is removed once the file is on disk. */
export interface SavedPendingCopy extends SavedCopy {
  readonly removed: boolean;
}

/**
 * Result of pointing at a moved project folder. `confirm`: the chosen folder lacks some of the recovered files; the
 * user confirms with `relocateConfirm` and the opaque `choiceId` (main keeps the folder; the renderer never sends a
 * path). `cancelled`: the folder dialog was closed.
 */
export type RelocateResult =
  | { readonly status: 'cancelled' }
  | { readonly status: 'opened'; readonly project: OpenedProject }
  | {
      readonly status: 'confirm';
      readonly choiceId: string;
      readonly folderName: string;
      readonly missing: readonly string[];
    };

export type RelocateError = OpenFolderError | 'not-found' | 'expired' | 'write-failed';
export type RecoveryOpenError = OpenFolderError | 'not-found';

export interface RecoveryApi {
  record(request: JournalRecordRequest): Promise<IpcResult<{ written: boolean }, JournalRecordError>>;
  discardSaved(request: JournalSavedRequest): Promise<IpcResult<{ removed: boolean }, 'unknown-project'>>;
  /** Unsaved buffers left over from a run that ended abnormally. */
  listPending(): Promise<IpcResult<PendingRecovery, never>>;
  openProject(request: { readonly key: string }): Promise<IpcResult<OpenedProject, RecoveryOpenError>>;
  read(request: BufferRef): Promise<IpcResult<RecoveredEntry, RecoveryReadError>>;
  /** The user threw this recovered copy away. */
  discard(request: BufferRef): Promise<IpcResult<{ removed: boolean }, 'unknown-project'>>;
  /** Decision 0033: pending copies without an open project. */
  readPending(request: PendingRef): Promise<IpcResult<PendingEntry, PendingReadError>>;
  discardPending(request: PendingRef): Promise<IpcResult<{ removed: boolean }, never>>;
  /** Asks for a destination with the native save dialog in main; `null` when cancelled. */
  savePendingAs(request: PendingRef): Promise<IpcResult<SavedPendingCopy | null, PendingReadError | WriteFileError>>;
  /** Asks for the project folder's new location with the native folder dialog in main. */
  relocate(request: { readonly key: string }): Promise<IpcResult<RelocateResult, RelocateError>>;
  relocateConfirm(request: {
    readonly key: string;
    readonly choiceId: string;
  }): Promise<IpcResult<RelocateResult, RelocateError>>;
  /** Clear-data control: removes every journal record. */
  clear(): Promise<IpcResult<null, 'clear-failed'>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

const isRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_REVISION;

function bufferRefOf(payload: Record<string, unknown>): BufferRef | null {
  const { projectId, relPath, bufferId } = payload;
  if (!isProjectId(projectId) || !isPortableRelPath(relPath)) return null;
  if (typeof bufferId !== 'string' || !BUFFER_ID.test(bufferId)) return null;
  return { projectId, relPath, bufferId };
}

export function parseBufferRef(payload: unknown): BufferRef | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'relPath', 'bufferId'])) return null;
  return bufferRefOf(payload);
}

export function parseJournalRecordRequest(payload: unknown): JournalRecordRequest | null {
  const keys = ['projectId', 'relPath', 'bufferId', 'revision', 'text', 'bom'];
  if (!isRecord(payload) || !hasExactKeys(payload, keys)) return null;
  const ref = bufferRefOf(payload);
  const { revision, text, bom } = payload;
  if (!ref || !isRevision(revision) || typeof bom !== 'boolean') return null;
  if (typeof text !== 'string' || text.length > MAX_TEXT_FILE_BYTES) return null;
  return { ...ref, revision, text, bom };
}

export function parseJournalSavedRequest(payload: unknown): JournalSavedRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'relPath', 'bufferId', 'revision'])) return null;
  const ref = bufferRefOf(payload);
  return ref && isRevision(payload.revision) ? { ...ref, revision: payload.revision } : null;
}

export function parseRecoveryKeyRequest(payload: unknown): { key: string } | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['key'])) return null;
  return typeof payload.key === 'string' && PROJECT_KEY.test(payload.key) ? { key: payload.key } : null;
}

export function parsePendingRef(payload: unknown): PendingRef | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['key', 'bufferId'])) return null;
  const { key, bufferId } = payload;
  if (typeof key !== 'string' || !PROJECT_KEY.test(key)) return null;
  return typeof bufferId === 'string' && BUFFER_ID.test(bufferId) ? { key, bufferId } : null;
}

export function parseRelocateConfirm(payload: unknown): { key: string; choiceId: string } | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['key', 'choiceId'])) return null;
  const { key, choiceId } = payload;
  if (typeof key !== 'string' || !PROJECT_KEY.test(key)) return null;
  return typeof choiceId === 'string' && BUFFER_ID.test(choiceId) ? { key, choiceId } : null;
}
