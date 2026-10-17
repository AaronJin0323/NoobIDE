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

export const FILE_OPS_CHANNELS = {
  /** S52.1/S52.3: moves entries into a folder of the project. */
  moveEntries: 'workspace:move-entries',
  /** S52.2: copy/paste into a folder, or duplicate next to the original. */
  copyEntries: 'workspace:copy-entries',
  /** S52.3: moves a selection to the OS trash, item by item. */
  trashEntries: 'workspace:trash-entries',
  /** S52.6: the byte size of a project image for the image viewer tab (the picture comes by the app protocol). */
  imageInfo: 'workspace:image-info',
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

export interface FileOpsApi {
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
