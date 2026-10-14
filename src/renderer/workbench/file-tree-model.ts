import type { ListDirError, RequestError, TreeEntry } from '../../shared/ipc/contract';

/**
 * Renderer side of the lazy file tree (S07.2, S08.1). Pure so expansion, loading and keyboard rules are unit-tested;
 * FilesPanel owns the state and asks main for a folder's children only when it is expanded.
 */
export type FolderState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'loaded';
      readonly entries: readonly TreeEntry[];
      readonly truncated: boolean;
      /**
       * Known to be out of date (a change on disk or a file operation); listed again while the old rows stay on
       * screen, so the focused row and the scroll position survive a reload.
       */
      readonly stale?: boolean;
      /** A new listing of a stale folder is on its way. */
      readonly refreshing?: boolean;
    }
  | { readonly status: 'error'; readonly code: ListDirError | RequestError };

export interface TreeState {
  /** Children per folder relPath (`''` is the project root). Absent: never requested. */
  readonly folders: Readonly<Record<string, FolderState>>;
  /** Expanded folder relPaths. The root is always expanded. */
  readonly expanded: readonly string[];
  /** The focused/selected row (roving tabindex), or null before anything is selected. */
  readonly selected: string | null;
}

export const INITIAL_TREE: TreeState = { folders: {}, expanded: [], selected: null };

export type TreeAction =
  | { type: 'reset' }
  | { type: 'loading'; relPath: string }
  | { type: 'loaded'; relPath: string; entries: readonly TreeEntry[]; truncated: boolean }
  | { type: 'failed'; relPath: string; code: ListDirError | RequestError }
  | { type: 'expand'; relPath: string }
  | { type: 'collapse'; relPath: string }
  | { type: 'select'; relPath: string | null }
  /** Forget a folder's children so they are fetched again (watcher events, file operations). */
  | { type: 'invalidate'; relPath: string }
  /** A file or folder was renamed or moved: keep it (and its subtree) expanded/selected under the new path. */
  | { type: 'renamed'; from: string; to: string };

export function parentOf(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? '' : relPath.slice(0, i);
}

export function isSameOrBelow(relPath: string, ancestor: string): boolean {
  return ancestor === '' || relPath === ancestor || relPath.startsWith(`${ancestor}/`);
}

function rebase(relPath: string, from: string, to: string): string {
  return relPath === from ? to : isSameOrBelow(relPath, from) ? to + relPath.slice(from.length) : relPath;
}

export function treeReducer(state: TreeState, action: TreeAction): TreeState {
  switch (action.type) {
    case 'reset':
      return INITIAL_TREE;
    case 'loading': {
      const current = state.folders[action.relPath];
      const folder: FolderState =
        current?.status === 'loaded' ? { ...current, stale: false, refreshing: true } : { status: 'loading' };
      return { ...state, folders: { ...state.folders, [action.relPath]: folder } };
    }
    case 'loaded': {
      const folder: FolderState = { status: 'loaded', entries: action.entries, truncated: action.truncated };
      return { ...state, folders: { ...state.folders, [action.relPath]: folder } };
    }
    case 'failed':
      return { ...state, folders: { ...state.folders, [action.relPath]: { status: 'error', code: action.code } } };
    case 'expand':
      return state.expanded.includes(action.relPath)
        ? state
        : { ...state, expanded: [...state.expanded, action.relPath] };
    case 'collapse':
      return { ...state, expanded: state.expanded.filter((p) => p !== action.relPath) };
    case 'select':
      return { ...state, selected: action.relPath };
    case 'invalidate':
      return { ...state, folders: markStale(state.folders, action.relPath) };
    case 'renamed': {
      const { from, to } = action;
      let folders: Record<string, FolderState> = {};
      // Cached children under the old path carry old relPaths; drop them so they are listed again.
      for (const [key, value] of Object.entries(state.folders)) if (!isSameOrBelow(key, from)) folders[key] = value;
      folders = markStale(markStale(folders, parentOf(from)), parentOf(to));
      return {
        folders,
        expanded: state.expanded.map((p) => rebase(p, from, to)),
        selected: state.selected === null ? null : rebase(state.selected, from, to),
      };
    }
  }
}

/** A loaded folder keeps its rows but is listed again; anything else is forgotten and requested afresh. */
function markStale(folders: Readonly<Record<string, FolderState>>, relPath: string): Record<string, FolderState> {
  const next = { ...folders };
  const current = next[relPath];
  if (current?.status === 'loaded') next[relPath] = { ...current, stale: true, refreshing: false };
  else delete next[relPath];
  return next;
}

/** Folders that are expanded (or the root) whose children were never requested or are out of date. */
export function foldersToLoad(state: TreeState): string[] {
  const wanted = ['', ...visibleRows(state).flatMap((r) => (r.expanded ? [r.entry.relPath] : []))];
  return wanted.filter((p) => {
    const folder = state.folders[p];
    return folder === undefined || (folder.status === 'loaded' && folder.stale === true);
  });
}

/** True while any listing is on its way (new or refreshed). */
export function isListing(state: TreeState): boolean {
  return Object.values(state.folders).some(
    (f) => f.status === 'loading' || (f.status === 'loaded' && f.refreshing === true),
  );
}

export interface TreeRow {
  readonly entry: TreeEntry;
  /** 1 for children of the root (aria-level). */
  readonly level: number;
  readonly posInSet: number;
  readonly setSize: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
  /** The folder's own listing state, for expanded folders. */
  readonly folder: FolderState | undefined;
}

export function isExpandable(entry: TreeEntry): boolean {
  // A folder with a non-portable name cannot be listed through the IPC contract; it can only be renamed first.
  return entry.kind === 'directory' && !entry.unportable;
}

/** The rows a screen reader and the keyboard move through: depth-first over expanded, loaded folders. */
export function visibleRows(state: TreeState): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (relPath: string, level: number) => {
    const folder = state.folders[relPath];
    if (folder?.status !== 'loaded') return;
    folder.entries.forEach((entry, i) => {
      const expandable = isExpandable(entry);
      const expanded = expandable && state.expanded.includes(entry.relPath);
      rows.push({
        entry,
        level,
        posInSet: i + 1,
        setSize: folder.entries.length,
        expandable,
        expanded,
        folder: expanded ? state.folders[entry.relPath] : undefined,
      });
      if (expanded) walk(entry.relPath, level + 1);
    });
  };
  walk('', 1);
  return rows;
}

export function findEntry(state: TreeState, relPath: string): TreeEntry | undefined {
  const folder = state.folders[parentOf(relPath)];
  return folder?.status === 'loaded' ? folder.entries.find((e) => e.relPath === relPath) : undefined;
}

export type TreeKey = 'ArrowDown' | 'ArrowUp' | 'ArrowRight' | 'ArrowLeft' | 'Home' | 'End';

/**
 * WAI-ARIA tree keyboard pattern: Up/Down move; Right expands a closed folder or moves to its first child; Left
 * collapses an open folder or moves to the parent; Home/End jump to the first/last row.
 */
export function keyAction(state: TreeState, key: TreeKey): TreeAction[] {
  const rows = visibleRows(state);
  if (rows.length === 0) return [];
  const index = rows.findIndex((r) => r.entry.relPath === state.selected);
  const current = rows[index];
  const select = (row: TreeRow | undefined): TreeAction[] =>
    row ? [{ type: 'select', relPath: row.entry.relPath }] : [];
  if (!current) return select(key === 'End' ? rows[rows.length - 1] : rows[0]);
  switch (key) {
    case 'ArrowDown':
      return select(rows[index + 1]);
    case 'ArrowUp':
      return select(rows[index - 1]);
    case 'Home':
      return select(rows[0]);
    case 'End':
      return select(rows[rows.length - 1]);
    case 'ArrowRight':
      if (!current.expandable) return [];
      if (!current.expanded) return [{ type: 'expand', relPath: current.entry.relPath }];
      return rows[index + 1]?.level === current.level + 1 ? select(rows[index + 1]) : [];
    case 'ArrowLeft': {
      if (current.expanded) return [{ type: 'collapse', relPath: current.entry.relPath }];
      const parent = parentOf(current.entry.relPath);
      return parent === '' ? [] : [{ type: 'select', relPath: parent }];
    }
  }
}
