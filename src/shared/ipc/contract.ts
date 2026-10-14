/**
 * The only way the trusted workbench reaches the main process (S03.1, PLAN §6 "restricted application API").
 * Shared by main (handlers validate with the parse* functions below), preload (exposes exactly these calls via
 * contextBridge) and renderer (types only). Pure TypeScript: no Electron, Node or DOM imports.
 *
 * Security model: the renderer never sends an absolute path. Main registers a project root only when the user picks
 * it in the native folder dialog and hands back an opaque `projectId`; every file request is that id plus a portable
 * relative path, which main resolves and re-checks inside the root (realpath).
 */
import type { PlatformId } from '../../platform/labels';
import type { Result } from '../result';
import { isUnsafePathSegment } from '../file-names';
import type { RecoveryApi } from './recovery-contract';

export const IPC_API_VERSION = 1;

export const CHANNELS = {
  openFolder: 'workspace:open-folder',
  readFile: 'workspace:read-file',
  writeFile: 'workspace:write-file',
  revealProject: 'workspace:reveal-project',
  // --- S10 save pipeline: save elsewhere, close / quit guard ---
  saveCopy: 'workspace:save-copy',
  answerClose: 'app:answer-close',
  closeDiscarding: 'app:close-discarding',
  // --- end S10 ---
  // ── S07/S08: file tree, watcher and file operations ──
  listDir: 'workspace:list-dir',
  createEntry: 'workspace:create-entry',
  renameEntry: 'workspace:rename-entry',
  trashEntry: 'workspace:trash-entry',
  revealEntry: 'workspace:reveal-entry',
  // --- S12 crash-recovery journal (types and parsers: recovery-contract.ts) ---
  recoveryRecord: 'recovery:record',
  recoveryDiscardSaved: 'recovery:discard-saved',
  recoveryListPending: 'recovery:list-pending',
  recoveryOpenProject: 'recovery:open-project',
  recoveryRead: 'recovery:read',
  recoveryDiscard: 'recovery:discard',
  recoveryClear: 'recovery:clear',
  // --- end S12 ---
} as const;

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

/** Every handler first checks its sender and payload; these codes are shared by all channels. */
export type RequestError = 'forbidden-sender' | 'invalid-request';

/** Errors cross the process boundary without `cause` (it can hold non-cloneable objects and stays in main). */
export interface IpcErr<C extends string> {
  readonly ok: false;
  readonly code: C;
  /** Technical detail for the "show details" line, e.g. the OS error code. Never file contents. */
  readonly message: string;
}
export type IpcResult<T, C extends string> = { readonly ok: true; readonly value: T } | IpcErr<C | RequestError>;

/** Strips `cause` from a service Result so it can be structured-cloned to the renderer. */
export function toIpcResult<T, C extends string>(result: Result<T, C>): IpcResult<T, C> {
  return result.ok ? { ok: true, value: result.value } : { ok: false, code: result.code, message: result.message };
}

export interface FileEntry {
  /** Portable relative path with `/` separators, e.g. `css/style.css`. */
  readonly relPath: string;
  /** Stable `file://` URI of the real file, built in main with url.pathToFileURL — the editor model key. */
  readonly uri: string;
}

export interface OpenedProject {
  readonly projectId: string;
  /** Folder name as shown to the user. */
  readonly name: string;
  /** Absolute folder path, for display only (the user must always be able to find their project, PLAN §2). */
  readonly rootPath: string;
  readonly files: readonly FileEntry[];
  /** True when the listing stopped at its limit; the full tree arrives with S07. */
  readonly truncated: boolean;
}

export type OpenFolderError = 'list-failed';

export interface FileRequest {
  readonly projectId: string;
  readonly relPath: string;
}

export interface FileContent {
  readonly text: string;
  readonly eol: '\n' | '\r\n';
  /** The file started with a UTF-8 byte order mark; it is written back unchanged. */
  readonly bom: boolean;
  readonly uri: string;
  /**
   * The file mixes CRLF and LF line breaks. The editor shows it with `eol` throughout, so the first save writes
   * `eol` everywhere; the workbench says so before that happens (docs/decisions/0011-mixed-line-endings.md).
   */
  readonly mixedEol: boolean;
  // ── S07.4: other encodings open read-only (absent = UTF-8, editable) ──
  /** WHATWG label of a non-UTF-8 encoding, e.g. `gb18030` or `utf-16le`. */
  readonly encoding?: string;
  /** The file is shown but cannot be saved: saving would re-encode it as UTF-8. */
  readonly readOnly?: boolean;
  /** The encoding is a best guess (legacy text has no marker); the notice says so. */
  readonly encodingGuessed?: boolean;
}

export type ReadFileError =
  | 'unknown-project'
  | 'outside-project'
  | 'not-found'
  | 'not-a-file'
  | 'too-large'
  | 'unsupported-encoding'
  | 'read-failed';

export interface WriteFileRequest extends FileRequest {
  readonly text: string;
  readonly bom: boolean;
}

export type WriteFileError =
  | 'unknown-project'
  | 'outside-project'
  | 'not-found'
  | 'not-a-file'
  | 'too-large'
  | 'permission-denied'
  | 'busy'
  | 'disk-full'
  /** S07.4: the file on disk is not UTF-8 text (another encoding or binary); it is never overwritten. */
  | 'unsupported-encoding'
  | 'write-failed';

export interface SavedFile {
  readonly savedAt: number;
}

export type RevealError = 'unknown-project';

/** Where "save elsewhere" wrote the copy (absolute path, chosen by the user in the native save dialog). */
export interface SavedCopy {
  readonly path: string;
}

/** The workbench's answer to `closeRequested`: `ok` false keeps the window open (a save failed). */
export interface CloseAnswer {
  readonly ok: boolean;
}

// ── S07/S08: file tree, watcher and file operations ─────────────────────────────────────────────────────────────

/** One child in the lazy file tree (S07.2). */
export interface TreeEntry {
  /** The name exactly as the file system reports it (case and Unicode normalisation untouched). */
  readonly name: string;
  readonly relPath: string;
  /**
   * `directory` / `file`, also for a link whose real target is inside the project. A link that leads outside the
   * project or nowhere is listed but never followed (cannot be expanded or opened).
   */
  readonly kind: 'file' | 'directory' | 'link-outside' | 'link-broken';
  readonly isLink: boolean;
  /**
   * The name is not valid on Windows or macOS (trailing dot/space, `:`, `\`, a device name — e.g. from a zip or
   * another system). It is listed with an explanation and can be renamed, trashed or revealed, but not opened.
   */
  readonly unportable?: true;
}

export interface DirRequest {
  readonly projectId: string;
  /** `''` for the project root. */
  readonly relPath: string;
}

export interface DirListing {
  readonly relPath: string;
  readonly entries: readonly TreeEntry[];
  /** More entries than the tree shows in one folder. */
  readonly truncated: boolean;
}

export type ListDirError =
  'unknown-project' | 'outside-project' | 'not-found' | 'not-a-directory' | 'permission-denied' | 'list-failed';

export function parseDirRequest(payload: unknown): DirRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'relPath'])) return null;
  const { projectId, relPath } = payload;
  return isProjectId(projectId) && (relPath === '' || isPortableRelPath(relPath)) ? { projectId, relPath } : null;
}

/** Why a file operation (S08.2–S08.5) was refused or failed. Explained to the user, never silently resolved. */
export type FileOpError =
  | 'unknown-project'
  | 'outside-project'
  | 'not-found'
  /** The new name breaks the Windows or macOS rules (src/shared/file-names); message lists the problems. */
  | 'invalid-name'
  /** Something with that name already exists; message is its name. Never overwritten. */
  | 'exists'
  /** A sibling differs only in letter case; message is its name. It would clash on Windows and macOS. */
  | 'case-conflict'
  | 'into-itself'
  | 'permission-denied'
  | 'busy'
  /** The OS could not move it to the trash (message from the OS); nothing was deleted. */
  | 'trash-failed'
  /** A case-only rename could neither finish nor be undone; message is the temporary name the entry now has. */
  | 'interrupted'
  | 'op-failed';

export interface CreateEntryRequest {
  readonly projectId: string;
  readonly relPath: string;
  readonly kind: 'file' | 'directory';
}

export interface RenameEntryRequest {
  readonly projectId: string;
  readonly from: string;
  readonly to: string;
}

export function parseCreateEntryRequest(payload: unknown): CreateEntryRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'relPath', 'kind'])) return null;
  const { projectId, relPath, kind } = payload;
  if (!isProjectId(projectId) || !isPortableRelPath(relPath)) return null;
  return kind === 'file' || kind === 'directory' ? { projectId, relPath, kind } : null;
}

export function parseRenameEntryRequest(payload: unknown): RenameEntryRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'from', 'to'])) return null;
  const { projectId, from, to } = payload;
  // `from` may be an existing entry with a non-portable name (renaming it is how the user repairs it).
  return isProjectId(projectId) && isListedRelPath(from) && isPortableRelPath(to) ? { projectId, from, to } : null;
}

/** A change on disk, from the project watcher (S07.3). Paths are portable and relative to the project root. */
export type WatchEvent =
  | { readonly type: 'created' | 'changed' | 'deleted'; readonly relPath: string }
  | { readonly type: 'renamed'; readonly from: string; readonly to: string; readonly caseOnly: boolean }
  /** The watcher lost track (folder removed, too many changes): reload the whole tree. */
  | { readonly type: 'rescan' };

export interface WorkspaceChanged {
  readonly projectId: string;
  readonly events: readonly WatchEvent[];
}

/** Main → workbench notifications (sent with webContents.send, only to the window that opened the project). */
export const EVENTS = {
  changed: 'workspace:changed',
  /** The window is about to close or the app to quit: save everything, then answer on `answerClose` (S10.6). */
  closeRequested: 'app:close-requested',
} as const;

// ── end S07/S08 ──────────────────────────────────────────────────────────────────────────────────────────────────

/** What preload exposes as `window.noobide`. */
export interface NoobideApi {
  readonly apiVersion: typeof IPC_API_VERSION;
  readonly platform: PlatformId;
  readonly workspace: {
    /** Shows the native folder dialog. `null` when the user cancels. */
    openFolder(): Promise<IpcResult<OpenedProject | null, OpenFolderError>>;
    readFile(request: FileRequest): Promise<IpcResult<FileContent, ReadFileError>>;
    writeFile(request: WriteFileRequest): Promise<IpcResult<SavedFile, WriteFileError>>;
    /** Shows the project folder in Explorer / Finder. */
    revealProject(request: { readonly projectId: string }): Promise<IpcResult<null, RevealError>>;
    /**
     * "Save elsewhere" after a failed save (S10.3): shows the native save dialog and writes the text there.
     * `null` when the user cancels. The original file and its unsaved state are left as they are.
     */
    saveCopy(request: WriteFileRequest): Promise<IpcResult<SavedCopy | null, WriteFileError>>;
    // ── S07/S08: file tree, watcher and file operations ──
    /** One folder of the lazy file tree (S07.2). */
    listDir(request: DirRequest): Promise<IpcResult<DirListing, ListDirError>>;
    /** Subscribes to changes on disk in the open project (S07.3). Returns the unsubscribe function. */
    onChanged(listener: (change: WorkspaceChanged) => void): () => void;
    /** Creates an empty file or folder; never replaces anything (S08.2, S08.4). */
    createEntry(request: CreateEntryRequest): Promise<IpcResult<{ relPath: string }, FileOpError>>;
    /** Renames or moves; refuses existing targets, allows case-only renames (S08.2, S08.4). */
    renameEntry(request: RenameEntryRequest): Promise<IpcResult<{ from: string; to: string }, FileOpError>>;
    /** Moves a file or folder to the OS trash (S08.3). The renderer confirms first. */
    trashEntry(request: FileRequest): Promise<IpcResult<null, FileOpError>>;
    /** Shows a file or folder in Finder / File Explorer (S08.5); `''` is the project folder. */
    revealEntry(request: DirRequest): Promise<IpcResult<null, FileOpError>>;
  };
  readonly app: {
    /** Registers the handler for close/quit requests. Returns the unsubscribe function. */
    onCloseRequested(listener: () => void): () => void;
    answerClose(answer: CloseAnswer): Promise<IpcResult<null, never>>;
    /** After a refused close: the user chose to close the window without the edits that could not be saved. */
    closeDiscarding(): Promise<IpcResult<null, never>>;
  };
  /** S12: crash-recovery journal of unsaved buffers. */
  readonly recovery: RecoveryApi;
}

/** Largest text file the editor opens or saves in v1 (bytes). */
export const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REL_PATH_LENGTH = 1024;
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A relative path the renderer may send: `/`-separated, no empty, `.` or `..` segments, no backslashes, no NUL,
 * not absolute, no `:` in any segment (drive or URL prefix, NTFS stream), no trailing dot or space and no Windows
 * device name (src/shared/file-names). Main still realpath-checks the result inside the project root.
 */
/**
 * The path of an existing entry the tree listed: like {@link isPortableRelPath}, except that the LAST segment may be
 * a name that is not portable (trailing dot/space, `:`, `\`, a device name), so such files can be renamed, trashed
 * or revealed. Main accepts it only if the parent folder really lists exactly that name (file-ops resolveEntry).
 */
export function isListedRelPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REL_PATH_LENGTH) return false;
  if (value.includes('\0') || value.startsWith('/')) return false;
  const slash = value.lastIndexOf('/');
  const name = value.slice(slash + 1);
  if (name === '' || name === '.' || name === '..') return false;
  return slash < 0 || isPortableRelPath(value.slice(0, slash));
}

export function parseEntryRequest(payload: unknown): FileRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'relPath'])) return null;
  const { projectId, relPath } = payload;
  return isProjectId(projectId) && isListedRelPath(relPath) ? { projectId, relPath } : null;
}

export function parseRevealRequest(payload: unknown): DirRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'relPath'])) return null;
  const { projectId, relPath } = payload;
  return isProjectId(projectId) && (relPath === '' || isListedRelPath(relPath)) ? { projectId, relPath } : null;
}

export function isPortableRelPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REL_PATH_LENGTH) return false;
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false;
  const segments = value.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
  // `:` in any segment (NTFS alternate data streams, drive prefixes), trailing dots/spaces and Windows device names.
  return !segments.some(isUnsafePathSegment);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID.test(value);
}

export function parseNoPayload(payload: unknown): null | undefined {
  return payload === undefined ? undefined : null;
}

export function parseProjectRequest(payload: unknown): { projectId: string } | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId'])) return null;
  return isProjectId(payload.projectId) ? { projectId: payload.projectId } : null;
}

export function parseFileRequest(payload: unknown): FileRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'relPath'])) return null;
  const { projectId, relPath } = payload;
  return isProjectId(projectId) && isPortableRelPath(relPath) ? { projectId, relPath } : null;
}

export function parseCloseAnswer(payload: unknown): CloseAnswer | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['ok'])) return null;
  return typeof payload.ok === 'boolean' ? { ok: payload.ok } : null;
}

export function parseWriteFileRequest(payload: unknown): WriteFileRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'relPath', 'text', 'bom'])) return null;
  const { projectId, relPath, text, bom } = payload;
  if (!isProjectId(projectId) || !isPortableRelPath(relPath)) return null;
  // A JS string can be up to 3 UTF-8 bytes per code unit; the service checks the exact encoded size.
  if (typeof text !== 'string' || text.length > MAX_TEXT_FILE_BYTES || typeof bom !== 'boolean') return null;
  return { projectId, relPath, text, bom };
}
