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

export const IPC_API_VERSION = 1;

export const CHANNELS = {
  openFolder: 'workspace:open-folder',
  readFile: 'workspace:read-file',
  writeFile: 'workspace:write-file',
  revealProject: 'workspace:reveal-project',
  saveCopy: 'workspace:save-copy',
  answerClose: 'app:answer-close',
  closeDiscarding: 'app:close-discarding',
} as const;

/** Main → workbench notifications (sent with webContents.send; the workbench only listens). */
export const EVENTS = {
  /** The window is about to close or the app to quit: save everything, then answer on `answerClose` (S10.6). */
  closeRequested: 'app:close-requested',
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
  };
  readonly app: {
    /** Registers the handler for close/quit requests. Returns the unsubscribe function. */
    onCloseRequested(listener: () => void): () => void;
    answerClose(answer: CloseAnswer): Promise<IpcResult<null, never>>;
    /** After a refused close: the user chose to close the window without the edits that could not be saved. */
    closeDiscarding(): Promise<IpcResult<null, never>>;
  };
}

/** Largest text file the editor opens or saves in v1 (bytes). */
export const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REL_PATH_LENGTH = 1024;
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A relative path the renderer may send: `/`-separated, no empty, `.` or `..` segments, no backslashes, no NUL,
 * not absolute and no drive or URL prefix. Main still realpath-checks the result inside the project root.
 */
export function isPortableRelPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REL_PATH_LENGTH) return false;
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false;
  const segments = value.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
  return !segments[0]?.includes(':');
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
