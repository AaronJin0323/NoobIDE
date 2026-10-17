import { isSameOrBelow, parentOf } from './file-tree-model';

/**
 * S52.1/S52.3 rules for moving tree entries, pure so drag-and-drop and the "Move to…" dialog decide alike and are
 * unit-tested. Main checks everything again (realpath, existing names); these rules only keep the UI from offering
 * a move that can never work.
 */
export interface MoveSource {
  readonly relPath: string;
  readonly kind: 'file' | 'directory' | string;
}

/** Why a folder cannot take the selection. */
export type MoveRefusal = 'into-itself' | 'same-folder';

/** The selection without entries that sit inside another selected folder (they move with it). */
export function outermostSources<T extends MoveSource>(sources: readonly T[]): T[] {
  return sources.filter(
    (s) => !sources.some((o) => o !== s && o.kind === 'directory' && s.relPath.startsWith(`${o.relPath}/`)),
  );
}

/**
 * Whether `folder` (`''` is the project root) can take the selection: never a selected folder itself or a folder
 * below one, and not the folder every selected entry is already in.
 */
export function moveRefusal(sources: readonly MoveSource[], folder: string): MoveRefusal | null {
  const outer = outermostSources(sources);
  if (outer.length === 0) return 'same-folder';
  if (outer.some((s) => s.kind === 'directory' && isSameOrBelow(folder, s.relPath) && s.relPath !== '')) {
    return 'into-itself';
  }
  if (outer.every((s) => parentOf(s.relPath) === folder)) return 'same-folder';
  return null;
}

/** The folder a drop onto a row moves into: a folder row itself, or the folder a file row is in. */
export function dropFolder(target: MoveSource | null): string {
  if (!target) return '';
  return target.kind === 'directory' ? target.relPath : parentOf(target.relPath);
}

/** Where an entry ends up when moved into `folder`. */
export function movedPath(relPath: string, folder: string): string {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  return folder === '' ? name : `${folder}/${name}`;
}

/** The folder's name as shown to the user; `root` is the label of the project folder itself. */
export function folderLabel(folder: string, root: string): string {
  return folder === '' ? root : folder.slice(folder.lastIndexOf('/') + 1);
}

/** Folders offered by the "Move to…" dialog, filtered by what the user typed (case-insensitive, any part). */
export function filterFolders(folders: readonly string[], query: string): string[] {
  const q = query.trim().toLocaleLowerCase();
  if (q === '') return [...folders];
  return folders.filter((f) => f.toLocaleLowerCase().includes(q));
}

/** MIME type of a tree drag (S52.1); drops of files from Explorer/Finder (S52.5) carry `Files` instead. */
export const TREE_DRAG_TYPE = 'application/x-noobide-tree-entries';
