import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import type { NoobideApi, OpenedProject, TreeEntry } from '../../shared/ipc/contract';
import { revealLabelKey, trashLabelKey, treeShortcutLabel, type PlatformId } from '../../platform/labels';
import { ConfirmDialog } from './ConfirmDialog';
import { FileTree, type TreeEditing } from './FileTree';
import { fill, nameProblemMessage, opErrorMessage, protectedFolderMessage } from './file-op-messages';
import { parentOf } from './file-tree-model';
import { FolderIcon, NewFileIcon, NewFolderIcon, SmallFolderIcon, WarningIcon } from './icons';
import { TreeContextMenu, type MenuItem } from './TreeContextMenu';
import type { FileOpsApi } from '../../shared/ipc/file-ops-contract';
import { MoveDialog } from './MoveDialog';
import { folderLabel, outermostSources } from './move-model';

/** What a file operation did to paths the editor may have open (S08.3: open tabs follow renames and deletions). */
export type FilesChange =
  | { readonly type: 'renamed'; readonly from: string; readonly to: string }
  | { readonly type: 'deleted'; readonly relPath: string };

export interface FileOpsHooks {
  /**
   * Called before a rename, move or delete of `relPath` (or a folder containing open files). Saves unsaved edits
   * first; `false` cancels the operation and nothing is changed on disk.
   */
  beforeChange(relPath: string): Promise<boolean>;
  afterChange(change: FilesChange): void;
  /** The operation that `beforeChange` allowed failed on disk; nothing changed (S10: unlocks the editors). */
  cancelled?(relPath: string): void;
}

interface FilesPanelProps {
  hidden: boolean;
  project: OpenedProject | null;
  activeRelPath: string | null;
  openFailed: boolean | 'protected-folder';
  /** Absent when the bridge is unavailable; the button is then not offered at all. */
  onOpenFolder: (() => void) | undefined;
  onOpenFile: (relPath: string) => void;
  /** The typed bridge (S07/S08); absent outside Electron. */
  api: NoobideApi['workspace'] | undefined;
  /** S52: move, copy, multi-select trash and import; absent outside Electron. */
  fileOpsApi?: FileOpsApi | undefined;
  platform: PlatformId;
  fileOps: FileOpsHooks;
  /** S13: extra context-menu commands for a row (e.g. "set as entry page"), labels as message keys. */
  extraMenuItems?: ((entry: TreeEntry) => readonly ExtraMenuItem[]) | undefined;
  /** Bumped by the workbench to start a new file from outside the panel (the narrow window's top-bar button). */
  newFileRequest?: number | undefined;
}

/** A context-menu command contributed by the workbench (S13.2). */
export interface ExtraMenuItem {
  readonly id: string;
  readonly label: MessageKey;
  readonly run: () => void;
}

interface Refresh {
  readonly id: number;
  readonly folders: readonly string[];
  readonly select?: string;
}

/**
 * The open project's files: lazy, accessible tree (S07.2, S08.1) with create, rename/move (S08.2, S08.4), delete
 * to the OS trash (S08.3) and reveal in Finder / File Explorer (S08.5). Every refusal is explained in place; nothing
 * on disk changes until the user confirms.
 */
export function FilesPanel({
  hidden,
  project,
  activeRelPath,
  openFailed,
  onOpenFolder,
  onOpenFile,
  api,
  platform,
  fileOps,
  extraMenuItems,
  newFileRequest,
  fileOpsApi,
}: FilesPanelProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<TreeEditing | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState<Refresh | null>(null);
  const [renamed, setRenamed] = useState<{ id: number; moves: readonly { from: string; to: string }[] } | null>(null);
  /** S52.1: the entries the "Move to…" dialog is open for. */
  const [moveFor, setMoveFor] = useState<readonly TreeEntry[] | null>(null);
  /** S52.1: what the last operation did, announced as text. */
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TreeEntry | null>(null);
  /** `items`: S52.3 — the entries of a selection that were not handled, each with its cause. */
  const [opError, setOpError] = useState<{ text: string; detail: string; items?: readonly string[] } | null>(null);
  const [menu, setMenu] = useState<{ entry: TreeEntry; x: number; y: number } | null>(null);
  const selected = useRef<TreeEntry | null>(null);
  const counter = useRef(0);
  const busy = useRef(false);

  const reload = useCallback((folders: readonly string[], select?: string) => {
    counter.current += 1;
    setRefresh(select === undefined ? { id: counter.current, folders } : { id: counter.current, folders, select });
  }, []);

  const trash = t(trashLabelKey(platform));
  const projectId = project?.projectId;

  /** The folder new entries go into: the selected folder, the selected file's folder, or the project root. */
  const targetFolder = () => {
    const entry = selected.current;
    if (!entry) return '';
    return entry.kind === 'directory' ? entry.relPath : parentOf(entry.relPath);
  };

  const startCreate = (kind: 'file' | 'directory', parent = targetFolder()) => {
    setOpError(null);
    setEditError(null);
    setEditing({ mode: 'create', parent, kind });
  };

  const startCreateRef = useRef(startCreate);
  startCreateRef.current = startCreate;
  useEffect(() => {
    if (newFileRequest) startCreateRef.current('file');
  }, [newFileRequest]);

  const startRename = (entry: TreeEntry) => {
    setOpError(null);
    setEditError(null);
    setEditing({ mode: 'rename', entry });
  };

  const cancelEdit = (reason: 'escape' | 'blur') => {
    if (!editing) return;
    const back = editing.mode === 'rename' ? editing.entry.relPath : (selected.current?.relPath ?? '');
    setEditing(null);
    setEditError(null);
    if (reason === 'escape') reload([], back);
  };

  const commitName = async (name: string) => {
    if (!api || !projectId || !editing || busy.current) return;
    const problem = nameProblemMessage(t, name);
    if (problem) {
      setEditError(problem);
      return;
    }
    busy.current = true;
    let locked: string | null = null; // a path beforeChange locked; unlocked again if the rename throws
    try {
      if (editing.mode === 'create') {
        const relPath = editing.parent === '' ? name : `${editing.parent}/${name}`;
        const result = await api.createEntry({ projectId, relPath, kind: editing.kind });
        if (!result.ok) {
          setEditError(opErrorMessage(t, result.code, result.message, name));
          return;
        }
        setEditing(null);
        // The new entry is selected before its folder is listed again, so "New file" right after "New folder"
        // goes into the new folder.
        selected.current = { name, relPath, kind: editing.kind, isLink: false };
        reload([editing.parent], relPath);
        if (editing.kind === 'file') onOpenFile(relPath);
      } else {
        const from = editing.entry.relPath;
        const parent = parentOf(from);
        const to = parent === '' ? name : `${parent}/${name}`;
        if (to === from) {
          cancelEdit('escape');
          return;
        }
        if (!(await fileOps.beforeChange(from))) {
          setEditError(t('op.saveFirstFailed'));
          return;
        }
        locked = from;
        const result = await api.renameEntry({ projectId, from, to });
        locked = null;
        if (!result.ok) {
          fileOps.cancelled?.(from);
          setEditError(opErrorMessage(t, result.code, result.message, name));
          return;
        }
        setEditing(null);
        counter.current += 1;
        setRenamed({ id: counter.current, moves: [{ from, to }] });
        selected.current = { ...editing.entry, name, relPath: to };
        reload([parent], to);
        fileOps.afterChange({ type: 'renamed', from, to });
      }
    } catch {
      // Never an unhandled rejection: the field stays open with an explanation (review finding 11).
      if (locked !== null) fileOps.cancelled?.(locked);
      setEditError(t('op.generic'));
    } finally {
      busy.current = false;
    }
  };

  const deleteConfirmed = async () => {
    const entry = confirmDelete;
    setConfirmDelete(null);
    if (!api || !projectId || !entry) return;
    if (!(await fileOps.beforeChange(entry.relPath))) {
      setOpError({ text: t('op.saveFirstFailed'), detail: entry.relPath });
      reload([], entry.relPath);
      return;
    }
    const result = await api.trashEntry({ projectId, relPath: entry.relPath });
    if (!result.ok) {
      fileOps.cancelled?.(entry.relPath);
      const text =
        result.code === 'trash-failed'
          ? fill(t('delete.failed'), { trash })
          : opErrorMessage(t, result.code, result.message, entry.name);
      setOpError({ text, detail: result.message });
      reload([], entry.relPath);
      return;
    }
    setOpError(null);
    selected.current = null;
    reload([parentOf(entry.relPath), entry.relPath], parentOf(entry.relPath));
    fileOps.afterChange({ type: 'deleted', relPath: entry.relPath });
  };

  /**
   * S52.1/S52.3: moves entries into `folder`. Like a rename: unsaved edits of open files are saved first (a failed
   * save leaves that entry where it is), main refuses an existing target per entry, open tabs follow every moved
   * path, and whatever was not moved is listed with its cause.
   */
  const moveEntries = async (entries: readonly TreeEntry[], folder: string) => {
    setMoveFor(null);
    if (!fileOpsApi || !projectId || busy.current) return;
    busy.current = true;
    setOpError(null);
    setNotice(null);
    const sources = outermostSources(entries);
    const locked: string[] = [];
    const problems: string[] = [];
    try {
      for (const entry of sources) {
        if (await fileOps.beforeChange(entry.relPath)) locked.push(entry.relPath);
        else problems.push(`${entry.name}: ${t('op.saveFirstFailed')}`);
      }
      if (locked.length === 0) {
        setOpError({ text: t('op.saveFirstFailed'), detail: '', items: problems });
        return;
      }
      const result = await fileOpsApi.moveEntries({ projectId, from: locked, toFolder: folder });
      if (!result.ok) {
        for (const relPath of locked) fileOps.cancelled?.(relPath);
        setOpError({ text: opErrorMessage(t, result.code, result.message, ''), detail: result.message });
        return;
      }
      const moved = new Set(result.value.moved.map((m) => m.from));
      for (const relPath of locked) if (!moved.has(relPath)) fileOps.cancelled?.(relPath);
      for (const failure of result.value.failed) {
        const name = failure.relPath.slice(failure.relPath.lastIndexOf('/') + 1);
        problems.push(`${name}: ${opErrorMessage(t, failure.code, failure.message, name)}`);
      }
      if (result.value.moved.length > 0) {
        counter.current += 1;
        setRenamed({ id: counter.current, moves: result.value.moved });
        for (const m of result.value.moved) fileOps.afterChange({ type: 'renamed', from: m.from, to: m.to });
        const first = result.value.moved[0];
        if (first) {
          const entry = sources.find((e) => e.relPath === first.from);
          if (entry) selected.current = { ...entry, relPath: first.to };
        }
        reload([folder, ...result.value.moved.map((m) => parentOf(m.from))], result.value.moved[0]?.to ?? undefined);
        setNotice(fill(t('move.done'), { folder: folderLabel(folder, project?.name ?? '') }));
      }
      if (problems.length > 0) {
        setOpError({
          text: fill(t('move.partial'), { n: String(problems.length) }),
          detail: '',
          items: problems,
        });
      }
    } catch {
      for (const relPath of locked) fileOps.cancelled?.(relPath);
      setOpError({ text: t('op.generic'), detail: '' });
    } finally {
      busy.current = false;
    }
  };

  const reveal = (entry: TreeEntry | null) => {
    if (!api || !projectId) return;
    void api.revealEntry({ projectId, relPath: entry?.relPath ?? '' }).then((result) => {
      if (!result.ok) setOpError({ text: opErrorMessage(t, result.code, result.message, ''), detail: result.message });
    });
  };

  const menuItems = (entry: TreeEntry): MenuItem[] => {
    const items: MenuItem[] = [];
    if (entry.kind === 'file' && !entry.unportable) {
      items.push({ id: 'open', label: t('menu.open'), run: () => onOpenFile(entry.relPath) });
    }
    if (entry.kind === 'directory' && !entry.unportable) {
      items.push({ id: 'new-file', label: t('files.newFile'), run: () => startCreate('file', entry.relPath) });
      items.push({ id: 'new-folder', label: t('files.newFolder'), run: () => startCreate('directory', entry.relPath) });
    }
    items.push(
      {
        id: 'rename',
        label: t('menu.rename'),
        shortcut: treeShortcutLabel(platform, 'rename'),
        run: () => startRename(entry),
      },
      ...(fileOpsApi && !entry.unportable
        ? [{ id: 'move-to', label: t('menu.moveTo'), run: () => setMoveFor([entry]) }]
        : []),
      {
        id: 'delete',
        label: t('menu.delete'),
        shortcut: treeShortcutLabel(platform, 'delete'),
        run: () => setConfirmDelete(entry),
      },
      {
        id: 'reveal',
        label: t(revealLabelKey(platform)),
        shortcut: treeShortcutLabel(platform, 'reveal'),
        run: () => reveal(entry),
      },
    );
    for (const extra of extraMenuItems?.(entry) ?? [])
      items.push({ id: extra.id, label: t(extra.label), run: extra.run });
    return items;
  };

  return (
    <nav
      id="region-files"
      className="region panel files"
      aria-label={t('region.files')}
      data-testid="region-files"
      hidden={hidden}
    >
      <div className="panel-header">
        <h2 className="region-title">{t('region.files')}</h2>
        <div className="panel-actions">
          {project && api && (
            <>
              <button
                type="button"
                className="quiet-button files-action"
                aria-label={t('files.newFile')}
                title={t('files.newFile')}
                data-testid="new-file"
                onClick={() => startCreate('file')}
              >
                <NewFileIcon />
                {/* Shown when the panel has room (styles.css container query); the name stays in aria-label. */}
                <span className="files-action-label" aria-hidden="true">
                  {t('files.newFile')}
                </span>
              </button>
              <button
                type="button"
                className="quiet-button files-action"
                aria-label={t('files.newFolder')}
                title={t('files.newFolder')}
                data-testid="new-folder"
                onClick={() => startCreate('directory')}
              >
                <NewFolderIcon />
                {/* Shown when the panel has room (styles.css container query); the name stays in aria-label. */}
                <span className="files-action-label" aria-hidden="true">
                  {t('files.newFolder')}
                </span>
              </button>
            </>
          )}
          {project && onOpenFolder && (
            <button
              type="button"
              className="icon-button"
              aria-label={t('files.openOther')}
              title={t('files.openOther')}
              data-testid="open-other-folder"
              onClick={onOpenFolder}
            >
              <SmallFolderIcon />
            </button>
          )}
        </div>
      </div>
      {openFailed && (
        <p className="inline-alert" role="alert">
          <WarningIcon />
          {openFailed === 'protected-folder' ? protectedFolderMessage(t) : t('files.openFailed')}
        </p>
      )}
      {opError && (
        <div className="inline-alert" role="alert" data-testid="file-op-error">
          <WarningIcon />
          <div>
            {opError.text}
            {opError.items && opError.items.length > 0 && (
              <ul className="alert-list" data-testid="file-op-failures">
                {opError.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
            {opError.detail && (
              <span className="alert-detail">
                {t('error.detail')}: {opError.detail}
              </span>
            )}
          </div>
        </div>
      )}
      {project && api ? (
        <div className="tree-scroll">
          <FileTree
            api={api}
            platform={platform}
            projectId={project.projectId}
            activeRelPath={activeRelPath}
            refresh={refresh}
            renamed={renamed}
            editing={editing}
            editError={editError}
            onCommitName={(name) => void commitName(name)}
            onCancelEdit={cancelEdit}
            onOpenFile={onOpenFile}
            onRename={startRename}
            onDelete={(entry) => {
              setOpError(null);
              setConfirmDelete(entry);
            }}
            onReveal={reveal}
            onUnportable={(entry) =>
              setOpError({ text: fill(t('tree.unportableExplain'), { name: entry.name }), detail: '' })
            }
            onContextMenu={(entry, anchor) => setMenu({ entry, ...anchor })}
            onSelectionChange={(entry) => {
              selected.current = entry;
            }}
            projectName={project.name}
            {...(fileOpsApi ? { onMoveDrop: (sources, folder) => void moveEntries(sources, folder) } : {})}
          />
        </div>
      ) : (
        <div className="empty-state">
          <span className="empty-icon">
            <FolderIcon />
          </span>
          <p className="empty-title">{t('files.empty')}</p>
          {onOpenFolder && (
            <button type="button" className="primary-button" data-testid="open-folder" onClick={onOpenFolder}>
              {t('files.openFolder')}
            </button>
          )}
        </div>
      )}
      {menu && (
        <TreeContextMenu
          label={t('menu.label')}
          items={menuItems(menu.entry)}
          x={menu.x}
          y={menu.y}
          onClose={(restoreFocus) => {
            setMenu(null);
            if (restoreFocus) reload([], menu.entry.relPath);
          }}
        />
      )}
      {/* S52.1: what the last move did, as text */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="file-op-notice">
        {notice ?? ''}
      </p>
      {moveFor && api && project && (
        <MoveDialog
          projectId={project.projectId}
          projectName={project.name}
          sources={moveFor}
          name={moveFor.length === 1 ? (moveFor[0]?.name ?? null) : null}
          listDir={api.listDir}
          onMove={(folder) => void moveEntries(moveFor, folder)}
          onCancel={() => {
            const first = moveFor[0];
            setMoveFor(null);
            if (first) reload([], first.relPath);
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={fill(t('delete.title'), { trash })}
          confirmLabel={fill(t('delete.confirm'), { trash })}
          cancelLabel={t('delete.cancel')}
          testId="delete-dialog"
          onConfirm={() => void deleteConfirmed()}
          onCancel={() => {
            const entry = confirmDelete;
            setConfirmDelete(null);
            reload([], entry.relPath);
          }}
        >
          <p>{fill(t('delete.question'), { name: confirmDelete.name, trash })}</p>
          {confirmDelete.kind === 'directory' && <p>{t('delete.folderNote')}</p>}
          <p className="dialog-hint">{fill(t('delete.restoreHint'), { trash })}</p>
        </ConfirmDialog>
      )}
    </nav>
  );
}
