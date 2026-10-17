import { useCallback, useEffect, useId, useReducer, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { NoobideApi, TreeEntry, WatchEvent } from '../../shared/ipc/contract';
import {
  INITIAL_TREE,
  findEntry,
  foldersToLoad,
  isListing,
  keyAction,
  parentOf,
  TYPE_AHEAD_RESET_MS,
  treeReducer,
  typeAheadChar,
  typeAheadTarget,
  visibleRows,
  type TreeKey,
  type TreeRow,
} from './file-tree-model';
import { ChevronRightIcon, LinkIcon, TreeFileIcon, TreeFolderIcon, WarningIcon } from './icons';
import { NameEditor } from './NameEditor';
import { createListingTracker, listFolder } from './folder-listing';
import { protectedFolderMessage } from './file-op-messages';
import { FileRoleTag } from './FileRole';
import { fileRoleFor, fileRoleLabelKey } from './file-role';
import { treeCommandForKey, type PlatformId } from '../../platform/labels';
import { isImeKey } from './ime';

/** Tree commands the panel handles (rename, delete, context menu: S08.2–S08.5). */
export interface FileTreeCommands {
  onOpenFile(relPath: string): void;
  onRename?(entry: TreeEntry): void;
  onDelete?(entry: TreeEntry): void;
  onContextMenu?(entry: TreeEntry, anchor: { x: number; y: number }): void;
  onReveal?(entry: TreeEntry): void;
  /** Enter/click on an entry whose name Windows or macOS cannot represent: explain instead of opening. */
  onUnportable?(entry: TreeEntry): void;
}

/** An inline name field in the tree (S08.2): renaming a row, or naming a new entry inside `parent`. */
export type TreeEditing =
  | { readonly mode: 'rename'; readonly entry: TreeEntry }
  | { readonly mode: 'create'; readonly parent: string; readonly kind: 'file' | 'directory' };

interface FileTreeProps extends FileTreeCommands {
  api: Pick<NoobideApi['workspace'], 'listDir' | 'onChanged'>;
  platform: PlatformId;
  projectId: string;
  editing: TreeEditing | null;
  editError: string | null;
  onCommitName(name: string): void;
  onCancelEdit(reason: 'escape' | 'blur'): void;
  activeRelPath: string | null;
  /** Bumped by the panel after its own file operations, so the affected folders are listed again. */
  refresh: { readonly id: number; readonly folders: readonly string[]; readonly select?: string } | null;
  /** Rename/move done by the panel: keep expansion and selection under the new path. */
  renamed: { readonly id: number; readonly from: string; readonly to: string } | null;
  /** Reports the selected entry so header buttons (new file, …) know the target folder. */
  onSelectionChange?(entry: TreeEntry | null): void;
}

const TREE_KEYS = new Set<string>(['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']);

/**
 * Accessible project file tree (S08.1): WAI-ARIA tree pattern with a roving tabindex. Arrows move and expand,
 * Enter opens a file or toggles a folder, F2 renames, Delete moves to the trash, Shift+F10 / the context-menu key
 * opens the menu, and typing a name's first characters selects it (S49.3). Folders load lazily (S07.2) and reload on watcher events (S07.3).
 */
export function FileTree(props: FileTreeProps) {
  const { api, platform, projectId, activeRelPath, refresh, renamed, editing, onOpenFile, onSelectionChange } = props;
  const { t } = useI18n();
  const [state, dispatch] = useReducer(treeReducer, INITIAL_TREE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const focusSelected = useRef(false);
  const focusAfterSelect = useRef<string | null>(null);
  const commands = useRef(props);
  commands.current = props;
  // Type-ahead (S49.3): characters typed within TYPE_AHEAD_RESET_MS of each other form one prefix.
  const typeAhead = useRef({ buffer: '', at: 0 });

  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  // Only the newest listing of each folder may update the tree: replies can arrive out of order.
  const listings = useRef(createListingTracker());
  useEffect(() => {
    listings.current.reset();
    dispatch({ type: 'reset' });
  }, [projectId]);

  // Lazy loading: every expanded folder (and the root) whose children were never requested or are out of date.
  useEffect(() => {
    for (const relPath of foldersToLoad(state)) {
      dispatch({ type: 'loading', relPath });
      void listFolder(listings.current, api.listDir, projectId, relPath, (action) => {
        if (projectRef.current === projectId) dispatch(action); // else another project was opened meanwhile
      });
    }
  }, [api, projectId, state]);

  // Changes on disk (S07.3): list the affected folders again.
  useEffect(
    () =>
      api.onChanged((change) => {
        if (change.projectId !== projectId) return;
        for (const event of change.events) applyWatchEvent(event, stateRef.current.folders, dispatch);
      }),
    [api, projectId],
  );

  useEffect(() => {
    if (!refresh) return;
    for (const folder of refresh.folders) dispatch({ type: 'invalidate', relPath: folder });
    if (refresh.select !== undefined) {
      dispatch({ type: 'select', relPath: refresh.select });
      focusSelected.current = true;
      focusAfterSelect.current = refresh.select;
    }
  }, [refresh]);

  useEffect(() => {
    if (renamed) dispatch({ type: 'renamed', from: renamed.from, to: renamed.to });
  }, [renamed]);

  // A new entry is named inside its folder, which must be open to show the field.
  const createIn = editing?.mode === 'create' ? editing.parent : null;
  useEffect(() => {
    if (createIn) dispatch({ type: 'expand', relPath: createIn });
  }, [createIn]);

  // Keyboard moves focus with the selection (roving tabindex); mouse clicks focus the row themselves.
  useEffect(() => {
    if (!focusSelected.current) return;
    // A selection requested by the panel is applied by a dispatch that has not rendered yet: wait for it.
    if (focusAfterSelect.current !== null && state.selected !== focusAfterSelect.current) return;
    focusAfterSelect.current = null;
    // The selected row, or the tree's tab stop when the selection is gone (e.g. after a delete in the root).
    const rowsNow = visibleRows(state);
    const found = rowsNow.some((r) => r.entry.relPath === state.selected);
    // A just-created or renamed row appears once its folder is listed again; wait for that before falling back.
    const loading = foldersToLoad(state).length > 0 || isListing(state);
    if (!found && loading) return;
    const target = found ? state.selected : rowsNow[0]?.entry.relPath;
    const row = target === undefined || target === null ? undefined : rowRefs.current.get(target);
    if (row) {
      row.focus();
      focusSelected.current = false;
    }
  });

  const selectedEntry = state.selected === null ? undefined : findEntry(state, state.selected);
  // A selected path whose folder is still being listed keeps the last reported entry (the panel set it).
  useEffect(() => {
    if (state.selected === null) onSelectionChange?.(null);
    else if (selectedEntry) onSelectionChange?.(selectedEntry);
  }, [onSelectionChange, selectedEntry, state.selected]);

  const activate = useCallback(
    (row: TreeRow) => {
      if (row.expandable) dispatch({ type: row.expanded ? 'collapse' : 'expand', relPath: row.entry.relPath });
      else if (row.entry.unportable) commands.current.onUnportable?.(row.entry);
      else if (row.entry.kind === 'file') onOpenFile(row.entry.relPath);
    },
    [onOpenFile],
  );

  const rows = visibleRows(state);
  const root = state.folders[''];
  const tabStop = rows.some((r) => r.entry.relPath === state.selected)
    ? state.selected
    : (rows[0]?.entry.relPath ?? null);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const row = rows.find((r) => r.entry.relPath === state.selected);
    if (TREE_KEYS.has(event.key)) {
      event.preventDefault();
      focusSelected.current = true;
      typeAhead.current.buffer = '';
      for (const action of keyAction(state, event.key as TreeKey)) dispatch(action);
      return;
    }
    if (editing === null && !isImeKey(event.nativeEvent) && event.target instanceof HTMLLIElement) {
      const now = event.timeStamp;
      const buffer = now - typeAhead.current.at > TYPE_AHEAD_RESET_MS ? '' : typeAhead.current.buffer;
      const char = typeAheadChar(event, buffer);
      if (char !== null) {
        event.preventDefault();
        typeAhead.current = { buffer: buffer + char, at: now };
        const target = typeAheadTarget(state, buffer + char);
        if (target !== null && target !== state.selected) {
          focusSelected.current = true;
          dispatch({ type: 'select', relPath: target });
        }
        return;
      }
    }
    if (!row) return;
    const c = commands.current;
    const command = treeCommandForKey(platform, event);
    if (event.key === 'Enter') {
      event.preventDefault();
      activate(row);
    } else if (command === 'rename' && c.onRename) {
      event.preventDefault();
      c.onRename(row.entry);
    } else if (command === 'delete' && c.onDelete) {
      event.preventDefault();
      c.onDelete(row.entry);
    } else if (command === 'reveal' && c.onReveal) {
      event.preventDefault();
      c.onReveal(row.entry);
    } else if ((event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) && c.onContextMenu) {
      event.preventDefault();
      const box = rowRefs.current.get(row.entry.relPath)?.getBoundingClientRect();
      c.onContextMenu(row.entry, { x: box ? box.left + 24 : 0, y: box ? box.bottom : 0 });
    }
  };

  if (!root || root.status === 'loading') return <p className="placeholder">{t('tree.loading')}</p>;
  if (root.status === 'error') {
    return (
      <p className="inline-alert" role="alert">
        <WarningIcon />
        {t('tree.listFailed')}
      </p>
    );
  }
  const nameEditor = (
    <NameEditor
      label={
        editing?.mode === 'rename'
          ? t('files.renameLabel')
          : t(editing?.kind === 'directory' ? 'files.newFolderName' : 'files.newFileName')
      }
      initialName={editing?.mode === 'rename' ? editing.entry.name : ''}
      error={props.editError}
      onCommit={props.onCommitName}
      onCancel={props.onCancelEdit}
    />
  );
  const createRow = (level: number) => (
    <li role="none" className="tree-row tree-create" style={{ paddingLeft: `${8 + (level - 1) * 16}px` }}>
      <span className="tree-twisty none" />
      {editing?.mode === 'create' && editing.kind === 'directory' ? <TreeFolderIcon open={false} /> : <TreeFileIcon />}
      {nameEditor}
    </li>
  );

  if (rows.length === 0 && editing?.mode !== 'create') {
    return <p className="empty-detail list-note">{t('tree.emptyFolder')}</p>;
  }

  return (
    <>
      <ul
        className="file-tree"
        role="tree"
        aria-label={t('files.listLabel')}
        data-testid="file-tree"
        onKeyDown={onKeyDown}
      >
        {editing?.mode === 'create' && editing.parent === '' && createRow(1)}
        {rows.map((row) => (
          <TreeRowItem
            key={row.entry.relPath}
            row={row}
            editor={editing?.mode === 'rename' && editing.entry.relPath === row.entry.relPath ? nameEditor : null}
            createRow={
              editing?.mode === 'create' && editing.parent === row.entry.relPath && row.expanded
                ? createRow(row.level + 1)
                : null
            }
            selected={row.entry.relPath === state.selected}
            active={row.entry.relPath === activeRelPath}
            tabbable={row.entry.relPath === tabStop}
            rowRef={(el) => {
              if (el) rowRefs.current.set(row.entry.relPath, el);
              else rowRefs.current.delete(row.entry.relPath);
            }}
            onClick={() => {
              dispatch({ type: 'select', relPath: row.entry.relPath });
              activate(row);
            }}
            onFocus={() => {
              if (stateRef.current.selected !== row.entry.relPath) {
                dispatch({ type: 'select', relPath: row.entry.relPath });
              }
            }}
            onContextMenu={(x, y) => {
              dispatch({ type: 'select', relPath: row.entry.relPath });
              commands.current.onContextMenu?.(row.entry, { x, y });
            }}
          />
        ))}
      </ul>
      {root.truncated && <p className="empty-detail list-note">{t('tree.truncated')}</p>}
    </>
  );
}

function applyWatchEvent(
  event: WatchEvent,
  folders: Readonly<Record<string, unknown>>,
  dispatch: (action: Parameters<typeof treeReducer>[1]) => void,
) {
  switch (event.type) {
    case 'created':
    case 'deleted':
      dispatch({ type: 'invalidate', relPath: parentOf(event.relPath) });
      if (event.type === 'deleted') dispatch({ type: 'invalidate', relPath: event.relPath });
      return;
    case 'renamed':
      dispatch({ type: 'renamed', from: event.from, to: event.to });
      return;
    case 'changed':
      return; // Content changes do not alter the tree.
    case 'rescan':
      for (const relPath of Object.keys(folders)) dispatch({ type: 'invalidate', relPath });
  }
}

interface TreeRowItemProps {
  row: TreeRow;
  /** The inline rename field replacing the name (S08.2). */
  editor: ReactNode;
  /** The inline "new file/folder" row shown first among this folder's children (S08.2). */
  createRow: ReactNode;
  selected: boolean;
  active: boolean;
  tabbable: boolean;
  rowRef: (el: HTMLLIElement | null) => void;
  onClick: () => void;
  onFocus: () => void;
  onContextMenu: (x: number, y: number) => void;
}

function TreeRowItem({
  row,
  editor,
  createRow,
  selected,
  active,
  tabbable,
  rowRef,
  onClick,
  onFocus,
  onContextMenu,
}: TreeRowItemProps) {
  const { t } = useI18n();
  const { entry, level, expandable, expanded, folder } = row;
  const unavailable = entry.kind === 'link-outside' || entry.kind === 'link-broken';
  const note =
    entry.kind === 'link-outside'
      ? t('tree.linkOutside')
      : entry.kind === 'link-broken'
        ? t('tree.linkBroken')
        : entry.isLink
          ? t('tree.link')
          : '';
  // S20.3: the file's role ("页面结构") is shown after the real name; screen readers hear it as the description,
  // while the row's name stays exactly the file name.
  const role = entry.kind === 'file' ? fileRoleFor(entry.relPath) : null;
  const unportable = entry.unportable ? t('tree.unportable') : '';
  const description = [unportable, role ? t(fileRoleLabelKey(role)) : '', note].filter(Boolean).join(' · ');
  const nameId = useId();
  return (
    <>
      <li
        ref={rowRef}
        role="treeitem"
        className="tree-row"
        aria-level={level}
        aria-posinset={row.posInSet}
        aria-setsize={row.setSize}
        aria-expanded={expandable ? expanded : undefined}
        aria-selected={selected}
        aria-current={active ? 'true' : undefined}
        aria-disabled={unavailable || undefined}
        aria-labelledby={editor ? undefined : nameId}
        aria-description={description || undefined}
        tabIndex={tabbable ? 0 : -1}
        title={note ? `${entry.relPath} — ${note}` : entry.relPath}
        data-testid="tree-row"
        data-path={entry.relPath}
        style={{ paddingLeft: `${8 + (level - 1) * 16}px` }}
        onClick={onClick}
        onFocus={onFocus}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(event.clientX, event.clientY);
        }}
      >
        <span className={expandable ? (expanded ? 'tree-twisty open' : 'tree-twisty') : 'tree-twisty none'}>
          {expandable && <ChevronRightIcon />}
        </span>
        {entry.kind === 'directory' ? <TreeFolderIcon open={expanded} /> : <TreeFileIcon name={entry.name} />}
        {editor ?? (
          <span className="tree-name" id={nameId}>
            {entry.name}
          </span>
        )}
        {!editor && entry.kind === 'file' && <FileRoleTag relPath={entry.relPath} />}
        {entry.unportable && !editor && (
          <span className="tree-unportable" title={unportable} data-testid="tree-unportable">
            <WarningIcon />
          </span>
        )}
        {entry.isLink && (
          <span className="tree-link" aria-hidden="true">
            <LinkIcon />
          </span>
        )}
      </li>
      {createRow}
      {expanded && folder?.status === 'error' && (
        <li
          role="none"
          className="tree-note"
          style={{ paddingLeft: `${24 + level * 16}px` }}
          data-testid="tree-folder-error"
        >
          <WarningIcon />
          {folder.code === 'protected-folder'
            ? protectedFolderMessage(t)
            : t(folder.code === 'permission-denied' ? 'tree.folderDenied' : 'tree.folderFailed')}
        </li>
      )}
      {expanded && folder?.status === 'loaded' && folder.entries.length === 0 && (
        <li role="none" className="tree-note" style={{ paddingLeft: `${24 + level * 16}px` }}>
          {t('tree.emptyFolder')}
        </li>
      )}
      {expanded && folder?.status === 'loaded' && folder.truncated && (
        <li role="none" className="tree-note" style={{ paddingLeft: `${24 + level * 16}px` }}>
          {t('tree.truncated')}
        </li>
      )}
    </>
  );
}
