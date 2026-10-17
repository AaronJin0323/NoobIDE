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
  /**
   * S52.3: every selected row (the focused row is usually one of them). Absent: just `selected`. Ctrl/Cmd-click and
   * Ctrl/Cmd+Space toggle a row, Shift-click and Shift+arrows select the range from `anchor`.
   */
  readonly selection?: readonly string[];
  /** S52.3: where a Shift range starts: the last row selected on its own or toggled. */
  readonly anchor?: string | null;
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
  /** S52.3: moves the focus only (Ctrl/Cmd+arrows, a row getting the focus); the selection stays. */
  | { type: 'focus'; relPath: string }
  /** S52.3: adds or removes one row from the selection (Ctrl/Cmd-click, Ctrl/Cmd+Space). */
  | { type: 'toggleSelect'; relPath: string }
  /** S52.3: selects the visible rows from the anchor to this one (Shift-click, Shift+arrows). */
  | { type: 'rangeSelect'; relPath: string }
  /** S52.3: selects every visible row (Ctrl/Cmd+A). */
  | { type: 'selectAll' }
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
      return {
        ...state,
        selected: action.relPath,
        selection: action.relPath === null ? [] : [action.relPath],
        anchor: action.relPath,
      };
    case 'focus': {
      const current = selectionOf(state);
      return {
        ...state,
        selected: action.relPath,
        selection: current.length === 0 ? [action.relPath] : current,
        anchor: state.anchor ?? action.relPath,
      };
    }
    case 'toggleSelect': {
      const current = selectionOf(state);
      const selection = current.includes(action.relPath)
        ? current.filter((p) => p !== action.relPath)
        : [...current, action.relPath];
      return { ...state, selected: action.relPath, selection, anchor: action.relPath };
    }
    case 'rangeSelect': {
      const rows = visibleRows(state).map((r) => r.entry.relPath);
      const anchor = state.anchor ?? state.selected ?? action.relPath;
      const from = rows.indexOf(anchor);
      const to = rows.indexOf(action.relPath);
      if (to < 0) return state;
      const selection = from < 0 ? [action.relPath] : rows.slice(Math.min(from, to), Math.max(from, to) + 1);
      return { ...state, selected: action.relPath, selection, anchor: from < 0 ? action.relPath : anchor };
    }
    case 'selectAll': {
      const rows = visibleRows(state).map((r) => r.entry.relPath);
      return { ...state, selection: rows, selected: state.selected ?? rows[0] ?? null };
    }
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
        ...(state.selection ? { selection: state.selection.map((p) => rebase(p, from, to)) } : {}),
        ...(state.anchor !== undefined
          ? { anchor: state.anchor === null ? null : rebase(state.anchor, from, to) }
          : {}),
      };
    }
  }
}

/** S52.3: the selected rows (just the focused one when no multi-selection was made). */
export function selectionOf(state: TreeState): readonly string[] {
  return state.selection ?? (state.selected === null ? [] : [state.selected]);
}

/**
 * S52.3: the selection as shown: rows that are visible now, in tree order (a row of a collapsed or reloaded folder
 * drops out, so an operation never acts on something the user cannot see).
 */
export function visibleSelection(state: TreeState): TreeRow[] {
  const selected = new Set(selectionOf(state));
  return visibleRows(state).filter((r) => selected.has(r.entry.relPath));
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
 * S52.3: Shift+Up/Down/Home/End extend the selection from the anchor; Ctrl/Cmd+Up/Down move the focus without
 * changing the selection (then Ctrl/Cmd+Space toggles the focused row). Other keys behave as {@link keyAction}.
 */
export function keyActionWith(
  state: TreeState,
  key: TreeKey,
  mods: { shift: boolean; primary: boolean },
): TreeAction[] {
  const actions = keyAction(state, key);
  if (!mods.shift && !mods.primary) return actions;
  if (key === 'ArrowLeft' || key === 'ArrowRight') return []; // expanding is not a selection change
  return actions.map((action) =>
    action.type === 'select' && action.relPath !== null
      ? mods.shift
        ? { type: 'rangeSelect', relPath: action.relPath }
        : { type: 'focus', relPath: action.relPath }
      : action,
  );
}

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

/** How long type-ahead keeps the typed buffer after the last key (S49.3). */
export const TYPE_AHEAD_RESET_MS = 1000;

/**
 * A key that extends the type-ahead buffer: one printable character with no Ctrl/Alt/Meta held. A space only
 * continues a buffer ("my page"), so it never starts one. IME keys are filtered by the caller (workbench/ime.ts).
 */
export function typeAheadChar(
  event: { readonly key: string; readonly ctrlKey: boolean; readonly altKey: boolean; readonly metaKey: boolean },
  buffer: string,
): string | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  if ([...event.key].length !== 1 || /\p{C}/u.test(event.key)) return null;
  if (event.key === ' ' && buffer === '') return null;
  return event.key;
}

const fold = (s: string) => s.normalize('NFC').toLowerCase();

/**
 * Type-ahead (S49.3): the next visible row whose name starts with `buffer` (case-insensitive, any script),
 * wrapping around. A one-character buffer starts after the selected row, so pressing a letter again moves on; a
 * longer buffer keeps the selected row while it still matches. Repeating one character ("ccc") cycles through
 * the rows starting with it. Returns the row's relPath, or null when nothing matches.
 */
export function typeAheadTarget(state: TreeState, buffer: string): string | null {
  const rows = visibleRows(state);
  if (rows.length === 0 || buffer === '') return null;
  const index = rows.findIndex((r) => r.entry.relPath === state.selected);
  const find = (prefix: string, startAfterSelected: boolean) => {
    const wanted = fold(prefix);
    const start = index < 0 ? 0 : startAfterSelected ? index + 1 : index;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[(start + i) % rows.length];
      if (row && fold(row.entry.name).startsWith(wanted)) return row.entry.relPath;
    }
    return null;
  };
  const chars = [...buffer];
  if (chars.length === 1) return find(buffer, true);
  const exact = find(buffer, false);
  if (exact !== null) return exact;
  const first = chars[0] ?? '';
  return chars.every((c) => fold(c) === fold(first)) ? find(first, true) : null;
}
