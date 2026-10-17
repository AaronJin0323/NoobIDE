/**
 * S52: complete file management — move, copy/paste/duplicate, multi-select trash, import from outside the project
 * and the image viewer. Types and parsers shared by main (handlers in src/main/file-ops-ipc.ts), preload (exposes
 * `window.noobide.fileOps`) and the renderer. Pure TypeScript: no Electron, Node or DOM imports.
 *
 * Same security model as contract.ts: the renderer never sends an absolute path except the files the user dropped
 * from Explorer/Finder (S52.5), which main only ever reads, and every project path is resolved and realpath-checked
 * inside the project root by main.
 */
import { isListedRelPath, isPortableRelPath, isProjectId, type FileOpError, type IpcResult } from './contract';
import { isImagePath } from '../image-files';
import type { ImportKind, ImportRefusal } from '../import-rules';

export const FILE_OPS_CHANNELS = {
  /** S52.1/S52.3: moves entries into a folder of the project. */
  moveEntries: 'workspace:move-entries',
  /** S52.2: copy/paste into a folder, or duplicate next to the original. */
  copyEntries: 'workspace:copy-entries',
  /** S52.3: moves a selection to the OS trash, item by item. */
  trashEntries: 'workspace:trash-entries',
  /** S52.6: the byte size of a project image for the image viewer tab (the picture comes by the app protocol). */
  imageInfo: 'workspace:image-info',
  /** S52.4: the native "Add files…"/"Add image…" dialog; the chosen entries stay in main under ids. */
  chooseImport: 'workspace:choose-import',
  /** S52.4/S52.5: copies chosen or dropped entries into a project folder under the names the user confirmed. */
  importEntries: 'workspace:import-entries',
  /** S52.5: files and folders dropped from Explorer/Finder onto the tree, registered like chosen ones. */
  registerDropped: 'workspace:register-dropped',
} as const;

/** Most entries one request may name (a selection in the tree). */
export const MAX_BATCH_ENTRIES = 500;

/** S52.1/S52.3: move the entries into `toFolder` (`''` = the project root), keeping their names. */
export interface MoveEntriesRequest {
  readonly projectId: string;
  readonly from: readonly string[];
  readonly toFolder: string;
}

/** One entry an operation on a selection did not handle, and why (never resolved silently). */
export interface BatchFailure {
  readonly relPath: string;
  readonly code: FileOpError;
  /** Main's detail, e.g. the existing name. Never file contents. */
  readonly message: string;
}

export interface MovedEntry {
  readonly from: string;
  readonly to: string;
}

/** What a move of a selection did: every entry is either moved or listed as failed with its cause. */
export interface MoveEntriesResult {
  readonly moved: readonly MovedEntry[];
  readonly failed: readonly BatchFailure[];
}

/**
 * S52.2: `paste` copies into `toFolder` (the original name when it is free there, else a copy name); `duplicate`
 * copies each entry next to itself as `name copy.ext` (`toFolder` must be `''` and is not used).
 */
export interface CopyEntriesRequest {
  readonly projectId: string;
  readonly from: readonly string[];
  readonly toFolder: string;
  readonly mode: 'paste' | 'duplicate';
}

export interface CopiedEntry {
  readonly from: string;
  readonly to: string;
  /** Links inside a copied folder are not copied; how many were left out. */
  readonly skippedLinks: number;
}

export interface CopyEntriesResult {
  readonly copied: readonly CopiedEntry[];
  readonly failed: readonly BatchFailure[];
}

/** S52.3: move every entry to the OS trash (never a permanent delete). The renderer confirms first. */
export interface TrashEntriesRequest {
  readonly projectId: string;
  readonly relPaths: readonly string[];
}

/** Every entry is either in the trash now or listed as failed with its cause (nothing was deleted then). */
export interface TrashEntriesResult {
  readonly trashed: readonly string[];
  readonly failed: readonly BatchFailure[];
}

/** S52.6: an image of the project the viewer can show. */
export interface ImageInfo {
  readonly bytes: number;
  readonly mtimeMs: number;
}

/** S52.4: what the native dialog shows; the renderer passes the translated texts (main has no UI strings). */
export interface ChooseImportRequest {
  readonly projectId: string;
  readonly kind: ImportKind;
  readonly title: string;
  readonly filterName: string;
}

/** An entry from outside the project, chosen or dropped, as main saw it. Its path never leaves main. */
export interface ImportCandidate {
  readonly id: string;
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'other';
  readonly bytes: number;
  /** Why it cannot be added at all (renaming does not help), or null. */
  readonly refusal: ImportRefusal | null;
  /** For a folder refused because of something inside: that path, relative to the folder. */
  readonly detail?: string;
}

export interface ImportEntriesRequest {
  readonly projectId: string;
  readonly toFolder: string;
  /** Candidate ids with the name each gets in the folder (the original, or one the user typed). */
  readonly items: readonly { readonly id: string; readonly name: string }[];
}

export interface ImportEntriesResult {
  readonly imported: readonly { readonly id: string; readonly relPath: string; readonly skippedLinks: number }[];
  /** `exists` / `case-conflict` carry the existing name: the user renames or skips, nothing is overwritten. */
  readonly failed: readonly {
    readonly id: string;
    readonly code: FileOpError | ImportRefusal | 'unknown-id';
    readonly message: string;
  }[];
}

export interface FileOpsApi {
  /** S52.4: shows the native dialog; null when cancelled. Every chosen entry is listed, refused ones with why. */
  chooseImport(request: ChooseImportRequest): Promise<IpcResult<readonly ImportCandidate[] | null, FileOpError>>;
  /**
   * S52.5: the files dropped onto the tree (the File objects of the drop). Preload asks Electron for each file's OS
   * path and main registers them like "Add files…"; their paths never come back. A drop that is not files (text from
   * another app) gives an empty list.
   */
  registerDropped(request: {
    readonly projectId: string;
    readonly files: ArrayLike<File>;
  }): Promise<IpcResult<readonly ImportCandidate[], FileOpError>>;
  /** S52.4/S52.5: copies candidates into a folder; never links, moves or overwrites. */
  importEntries(request: ImportEntriesRequest): Promise<IpcResult<ImportEntriesResult, FileOpError>>;
  /** S52.6: size of a png/jpg/gif/svg/webp/ico inside the project; anything else is refused. */
  imageInfo(request: {
    readonly projectId: string;
    readonly relPath: string;
  }): Promise<IpcResult<ImageInfo, FileOpError>>;
  /** S52.3: moves files and folders to the OS trash one by one; a partial failure lists what stayed. */
  trashEntries(request: TrashEntriesRequest): Promise<IpcResult<TrashEntriesResult, FileOpError>>;
  /** S52.2: copies files and folders byte for byte; never overwrites, a failed copy removes only what it made. */
  copyEntries(request: CopyEntriesRequest): Promise<IpcResult<CopyEntriesResult, FileOpError>>;
  /** S52.1/S52.3: moves files and folders; an existing target is refused per entry, never overwritten. */
  moveEntries(request: MoveEntriesRequest): Promise<IpcResult<MoveEntriesResult, FileOpError>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

/** A non-empty list of distinct listed entry paths, bounded. */
function isEntryList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH_ENTRIES) return false;
  return value.every(isListedRelPath) && new Set(value).size === value.length;
}

const isFolderPath = (value: unknown): value is string => value === '' || isPortableRelPath(value);

export function parseMoveEntriesRequest(payload: unknown): MoveEntriesRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'from', 'toFolder'])) return null;
  const { projectId, from, toFolder } = payload;
  if (!isProjectId(projectId) || !isEntryList(from) || !isFolderPath(toFolder)) return null;
  return { projectId, from: [...from], toFolder };
}

export function parseCopyEntriesRequest(payload: unknown): CopyEntriesRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'from', 'toFolder', 'mode'])) return null;
  const { projectId, from, toFolder, mode } = payload;
  if (!isProjectId(projectId) || !isEntryList(from) || !isFolderPath(toFolder)) return null;
  if (mode !== 'paste' && !(mode === 'duplicate' && toFolder === '')) return null;
  return { projectId, from: [...from], toFolder, mode };
}

export function parseTrashEntriesRequest(payload: unknown): TrashEntriesRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'relPaths'])) return null;
  const { projectId, relPaths } = payload;
  if (!isProjectId(projectId) || !isEntryList(relPaths)) return null;
  return { projectId, relPaths: [...relPaths] };
}

export function parseImageInfoRequest(payload: unknown): { projectId: string; relPath: string } | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'relPath'])) return null;
  const { projectId, relPath } = payload;
  return isProjectId(projectId) && isPortableRelPath(relPath) && isImagePath(relPath) ? { projectId, relPath } : null;
}

/** Ids main gives chosen and dropped entries (random, url-safe). */
export const IMPORT_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** Most entries one dialog or drop may bring in. */
export const MAX_IMPORT_ITEMS = 200;
/** Longest OS path a drop may name (Windows long paths included). */
export const MAX_DROP_PATH_LENGTH = 4096;

const isShortText = (value: unknown): value is string => typeof value === 'string' && value.length <= 200;

export function parseChooseImportRequest(payload: unknown): ChooseImportRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'kind', 'title', 'filterName'])) return null;
  const { projectId, kind, title, filterName } = payload;
  if (!isProjectId(projectId) || (kind !== 'files' && kind !== 'image')) return null;
  return isShortText(title) && isShortText(filterName) ? { projectId, kind, title, filterName } : null;
}

export function parseImportEntriesRequest(payload: unknown): ImportEntriesRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'toFolder', 'items'])) return null;
  const { projectId, toFolder, items } = payload;
  if (!isProjectId(projectId) || !isFolderPath(toFolder) || !Array.isArray(items)) return null;
  if (items.length === 0 || items.length > MAX_IMPORT_ITEMS) return null;
  const out: { id: string; name: string }[] = [];
  for (const item of items) {
    if (!isRecord(item) || !hasExactKeys(item, ['id', 'name'])) return null;
    const { id, name } = item;
    // One name in the folder, not a path. Its Windows/macOS rules are checked by main per item (`invalid-name`
    // asks the user for another name), so a file named `aux.png` on a Mac does not fail the whole batch.
    if (typeof id !== 'string' || !IMPORT_ID.test(id) || typeof name !== 'string') return null;
    if (name === '' || name.length > 255 || /[/\\\0]/.test(name) || name === '.' || name === '..') return null;
    out.push({ id, name });
  }
  if (new Set(out.map((i) => i.id)).size !== out.length) return null;
  return { projectId, toFolder, items: out };
}

/**
 * S52.5: the payload preload sends for a drop: the OS paths of the dropped files. The only place absolute paths
 * cross IPC; main only ever reads them (inspect, then copy into the project after the user confirms the names).
 * `''` is a dropped item without an OS path (Electron gives none for files that are not on disk).
 */
export function parseRegisterDroppedRequest(payload: unknown): { projectId: string; paths: string[] } | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['projectId', 'paths'])) return null;
  const { projectId, paths } = payload;
  if (!isProjectId(projectId) || !Array.isArray(paths) || paths.length > MAX_IMPORT_ITEMS) return null;
  if (!paths.every((p) => typeof p === 'string' && !p.includes('\0'))) return null;
  // An over-long path (e.g. a \\?\ path) is left out like an item without a path, not a reason to drop everything.
  return { projectId, paths: (paths as string[]).map((p) => (p.length > MAX_DROP_PATH_LENGTH ? '' : p)) };
}
