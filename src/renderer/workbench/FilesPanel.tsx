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
import {
  MAX_BATCH_ENTRIES,
  MAX_IMPORT_ITEMS,
  type FileOpsApi,
  type ImportCandidate,
} from '../../shared/ipc/file-ops-contract';
import type { FileOpError } from '../../shared/ipc/contract';
import type { ImportKind } from '../../shared/import-rules';
import { copyName, sameName } from '../../shared/file-names';
import { ImportNameDialog } from './ImportNameDialog';
import { importRefusalMessage, isImportRefusal, needsNewName } from './import-messages';
import { MoveDialog } from './MoveDialog';
import { dropFolder, folderLabel, outermostSources } from './move-model';

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
  /** S52.1/S52.2: a palette command on the tree's selection, bumped by the workbench. */
  fileCommand?: { readonly id: number; readonly command: FileCommand } | undefined;
}

/** S52.1/S52.2: file commands the palette runs on the tree's selection. */
export type FileCommand = 'copy' | 'paste' | 'duplicate' | 'move-to' | 'add-files' | 'add-image';

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
  fileCommand,
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
  /** S52.2: entries copied with Copy (in NoobIDE only; the OS clipboard is not touched), for one project only. */
  const clipboard = useRef<{ readonly projectId: string; readonly entries: readonly TreeEntry[] } | null>(null);
  /** The entries the delete confirmation is open for (S52.3: a selection of several). */
  const [confirmDelete, setConfirmDelete] = useState<readonly TreeEntry[] | null>(null);
  /** S52.4: an added file whose name is taken (or invalid): the user renames or skips it. */
  const [nameAsk, setNameAsk] = useState<{
    readonly name: string;
    readonly existing: string | null;
    readonly folder: string;
    readonly isFolder: boolean;
    readonly resolve: (name: string | null) => void;
  } | null>(null);
  /** S52.3: the tree's visible selection, in tree order. */
  const selectionEntries = useRef<readonly TreeEntry[]>([]);
  /** `items`: S52.3 — the entries of a selection that were not handled, each with its cause. */
  const [opError, setOpError] = useState<{ text: string; detail: string; items?: readonly string[] } | null>(null);
  const [menu, setMenu] = useState<{ entry: TreeEntry; x: number; y: number } | null>(null);
  const selected = useRef<TreeEntry | null>(null);
  const counter = useRef(0);
  const busy = useRef(false);

  const onSelectionEntries = useCallback((entries: readonly TreeEntry[]) => {
    selectionEntries.current = entries;
  }, []);

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

  /**
   * S52.3: what a command on `entry` acts on: the whole selection when the entry is part of a selection of several,
   * otherwise the entry alone.
   */
  const targets = (entry: TreeEntry): readonly TreeEntry[] => {
    const selection = selectionEntries.current;
    return selection.length > 1 && selection.some((e) => e.relPath === entry.relPath) ? selection : [entry];
  };

  /** S52.3: several entries to the OS trash; every failure is listed with its cause (those entries stay). */
  const deleteMany = async (entries: readonly TreeEntry[]) => {
    if (!fileOpsApi || !projectId || busy.current) return;
    const sources = outermostSources(entries);
    if (tooMany(sources)) return;
    busy.current = true;
    const locked: string[] = [];
    const problems: string[] = [];
    try {
      for (const entry of sources) {
        if (await fileOps.beforeChange(entry.relPath)) locked.push(entry.relPath);
        else problems.push(`${entry.name}: ${t('op.saveFirstFailed')}`);
      }
      const result = locked.length > 0 ? await fileOpsApi.trashEntries({ projectId, relPaths: locked }) : null;
      if (result && !result.ok) {
        for (const relPath of locked) fileOps.cancelled?.(relPath);
        setOpError({ text: opErrorMessage(t, result.code, result.message, ''), detail: result.message });
        return;
      }
      const trashed = new Set(result?.value.trashed ?? []);
      for (const relPath of locked) if (!trashed.has(relPath)) fileOps.cancelled?.(relPath);
      for (const failure of result?.value.failed ?? []) {
        const name = failure.relPath.slice(failure.relPath.lastIndexOf('/') + 1);
        const why =
          failure.code === 'trash-failed'
            ? fill(t('delete.failed'), { trash })
            : opErrorMessage(t, failure.code, failure.message, name);
        problems.push(`${name}: ${why}`);
      }
      selected.current = null;
      const folders = [...new Set(sources.map((e) => parentOf(e.relPath)))];
      reload([...folders, ...trashed], folders[0] ?? '');
      for (const relPath of trashed) fileOps.afterChange({ type: 'deleted', relPath });
      if (trashed.size > 0) setNotice(fill(t('delete.doneMany'), { n: String(trashed.size), trash }));
      if (problems.length > 0) {
        setOpError({
          text: fill(t('delete.partial'), { n: String(problems.length), trash }),
          detail: '',
          items: problems,
        });
      } else setOpError(null);
    } catch {
      for (const relPath of locked) fileOps.cancelled?.(relPath);
      setOpError({ text: t('op.generic'), detail: '' });
    } finally {
      busy.current = false;
    }
  };

  /** S52.3: one request takes at most MAX_BATCH_ENTRIES entries; more is explained instead of refused silently. */
  const tooMany = (sources: readonly TreeEntry[]): boolean => {
    if (sources.length <= MAX_BATCH_ENTRIES) return false;
    setOpError({ text: fill(t('op.tooMany'), { n: String(MAX_BATCH_ENTRIES) }), detail: '' });
    return true;
  };

  const deleteConfirmed = async () => {
    const entries = confirmDelete;
    setConfirmDelete(null);
    if (entries && entries.length > 1) {
      await deleteMany(entries);
      return;
    }
    const entry = entries?.[0];
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
    if (tooMany(sources)) {
      busy.current = false;
      return;
    }
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

  // --- S52.2: copy, paste and duplicate ---
  const copyToClipboard = (entries: readonly TreeEntry[]) => {
    const copyable = entries.filter((e) => !e.unportable && !e.isLink);
    if (!projectId) return;
    if (copyable.length === 0) {
      setNotice(null);
      setOpError({ text: t('op.link'), detail: '' });
      return;
    }
    clipboard.current = { projectId, entries: copyable };
    setOpError(null);
    setNotice(
      copyable.length === 1
        ? fill(t('copy.copied'), { name: copyable[0]?.name ?? '' })
        : fill(t('copy.copiedMany'), { n: String(copyable.length) }),
    );
  };

  /**
   * Copies entries into `folder` (`paste`) or next to themselves (`duplicate`). Main never overwrites: a taken name
   * gets a copy name, and a copy that fails half-way removes what it made. Each failure is listed with its cause.
   */
  const copyEntries = async (entries: readonly TreeEntry[], folder: string, mode: 'paste' | 'duplicate') => {
    if (!fileOpsApi || !projectId || busy.current || entries.length === 0) return;
    busy.current = true;
    setOpError(null);
    setNotice(null);
    try {
      const sources = outermostSources(entries);
      if (tooMany(sources)) return;
      const result = await fileOpsApi.copyEntries({
        projectId,
        from: sources.map((e) => e.relPath),
        toFolder: mode === 'duplicate' ? '' : folder,
        mode,
      });
      if (!result.ok) {
        setOpError({ text: opErrorMessage(t, result.code, result.message, ''), detail: result.message });
        return;
      }
      const { copied, failed } = result.value;
      const first = copied[0];
      if (first) {
        const source = sources.find((e) => e.relPath === first.from);
        const name = first.to.slice(first.to.lastIndexOf('/') + 1);
        if (source) selected.current = { ...source, name, relPath: first.to, isLink: false };
        reload([...new Set(copied.map((c) => parentOf(c.to)))], first.to);
        const skipped = copied.reduce((n, c) => n + c.skippedLinks, 0);
        const done =
          copied.length === 1 ? fill(t('copy.done'), { name }) : fill(t('copy.doneMany'), { n: String(copied.length) });
        setNotice(skipped > 0 ? `${done} ${fill(t('copy.skippedLinks'), { n: String(skipped) })}` : done);
      }
      if (failed.length > 0) {
        setOpError({
          text: fill(t('copy.partial'), { n: String(failed.length) }),
          detail: '',
          items: failed.map((f) => {
            const name = f.relPath.slice(f.relPath.lastIndexOf('/') + 1);
            const why =
              f.code === 'op-failed' && f.message === 'link'
                ? t('op.link')
                : opErrorMessage(t, f.code, f.message, name);
            return `${name}: ${why}`;
          }),
        });
      }
    } catch {
      setOpError({ text: t('op.generic'), detail: '' });
    } finally {
      busy.current = false;
    }
  };

  const pasteInto = (target: TreeEntry | null) => {
    // A copy made in another project is not pasted here: its paths mean other files in this one.
    const copied = clipboard.current;
    const entries = copied && copied.projectId === projectId ? copied.entries : null;
    if (!entries) {
      setOpError({ text: fill(t('copy.nothing'), { key: treeShortcutLabel(platform, 'copy') }), detail: '' });
      return;
    }
    void copyEntries(entries, dropFolder(target), 'paste');
  };

  /** The entries a palette command acts on: the tree's selection (S52.3), else the focused entry. */
  const selection = (): readonly TreeEntry[] =>
    selectionEntries.current.length > 0 ? selectionEntries.current : selected.current ? [selected.current] : [];

  // --- S52.4: add files and images from outside the project ---
  const askName = (name: string, existing: string | null, folder: string, isFolder: boolean) =>
    new Promise<string | null>((resolve) => setNameAsk({ name, existing, folder, isFolder, resolve }));

  /**
   * Copies outside entries (chosen in the dialog, or dropped: S52.5) into `folder`. Refused ones are explained with
   * the limit or type; a taken or invalid name asks the user for another name or to skip, one file at a time;
   * nothing in the project is ever overwritten.
   */
  const runImport = async (candidates: readonly ImportCandidate[], folder: string) => {
    if (!fileOpsApi || !projectId || busy.current || candidates.length === 0) return;
    busy.current = true;
    setOpError(null);
    setNotice(null);
    const folderName = folderLabel(folder, project?.name ?? '');
    const problems: string[] = [];
    const imported: string[] = [];
    try {
      for (const c of candidates) {
        if (c.refusal) problems.push(importRefusalMessage(t, c.refusal, c.name, c.kind, c.detail));
      }
      let queue = candidates.filter((c) => c.refusal === null).map((c) => ({ c, name: c.name }));
      while (queue.length > 0) {
        const result = await fileOpsApi.importEntries({
          projectId,
          toFolder: folder,
          items: queue.map((q) => ({ id: q.c.id, name: q.name })),
        });
        if (!result.ok) {
          problems.push(opErrorMessage(t, result.code, result.message, ''));
          break;
        }
        imported.push(...result.value.imported.map((i) => i.relPath));
        const next: typeof queue = [];
        for (const failure of result.value.failed) {
          const q = queue.find((x) => x.c.id === failure.id);
          if (!q) continue;
          if (needsNewName(failure.code)) {
            const existing = failure.code === 'invalid-name' ? null : failure.message;
            const name = await askName(q.name, existing, folderName, q.c.kind === 'directory');
            if (name !== null) next.push({ c: q.c, name });
          } else if (isImportRefusal(failure.code)) {
            problems.push(importRefusalMessage(t, failure.code, q.name, q.c.kind));
          } else if (failure.code === 'unknown-id') {
            problems.push(fill(t('import.expired'), { name: q.name }));
          } else {
            problems.push(`${q.name}: ${opErrorMessage(t, failure.code as FileOpError, failure.message, q.name)}`);
          }
        }
        queue = next;
      }
      if (imported.length > 0) {
        const first = imported[0];
        reload([folder], first);
        setNotice(fill(t('import.done'), { n: String(imported.length), folder: folderName }));
      }
      if (problems.length > 0) {
        setOpError({ text: fill(t('import.partial'), { n: String(problems.length) }), detail: '', items: problems });
      }
    } catch {
      setOpError({ text: t('op.generic'), detail: '' });
    } finally {
      busy.current = false;
    }
  };

  /** "Add files…" / "Add image…": the native dialog in main, then the copy into `folder`. */
  const startImport = async (kind: ImportKind, folder: string) => {
    if (!fileOpsApi || !projectId || busy.current) return; // one import (and its name questions) at a time
    const chosen = await fileOpsApi.chooseImport({
      projectId,
      kind,
      title: t(kind === 'image' ? 'import.imageDialogTitle' : 'import.dialogTitle'),
      filterName: t('import.imageFilter'),
    });
    if (!chosen.ok) {
      setOpError({ text: opErrorMessage(t, chosen.code, chosen.message, ''), detail: chosen.message });
      return;
    }
    if (chosen.value) await runImport(chosen.value, folder);
  };
  /** S52.5: files dropped from Explorer/Finder: registered in main (their paths stay there), then imported. */
  const dropFiles = async (files: readonly File[], folder: string) => {
    if (!fileOpsApi || !projectId) return;
    if (busy.current) {
      setOpError({ text: t('import.busy'), detail: '' });
      return;
    }
    try {
      const dropped = await fileOpsApi.registerDropped({ projectId, files });
      if (!dropped.ok) {
        setOpError({ text: opErrorMessage(t, dropped.code, dropped.message, ''), detail: dropped.message });
        return;
      }
      await runImport(dropped.value, folder);
      if (files.length > MAX_IMPORT_ITEMS) {
        setNotice(
          fill(t('import.tooMany'), { n: String(MAX_IMPORT_ITEMS), rest: String(files.length - MAX_IMPORT_ITEMS) }),
        );
      }
    } catch {
      setOpError({ text: t('op.generic'), detail: '' });
    }
  };
  // --- end S52.4 ---

  const fileCommandRef = useRef<(command: FileCommand) => void>(() => undefined);
  fileCommandRef.current = (command) => {
    if (command === 'add-files' || command === 'add-image') {
      void startImport(command === 'add-image' ? 'image' : 'files', targetFolder());
      return;
    }
    const entries = selection();
    if (command === 'paste') {
      pasteInto(entries[0] ?? null);
      return;
    }
    if (entries.length === 0) {
      setOpError({ text: t('copy.noSelection'), detail: '' });
      return;
    }
    if (command === 'copy') copyToClipboard(entries);
    else if (command === 'duplicate') void copyEntries(entries, '', 'duplicate');
    else setMoveFor(entries);
  };
  useEffect(() => {
    if (fileCommand) fileCommandRef.current(fileCommand.command);
  }, [fileCommand]);
  // --- end S52.2 ---

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
        ? [
            {
              id: 'copy',
              label: t('menu.copy'),
              shortcut: treeShortcutLabel(platform, 'copy'),
              run: () => copyToClipboard(targets(entry)),
            },
            ...(clipboard.current?.projectId === projectId
              ? [
                  {
                    id: 'paste',
                    label: t('menu.paste'),
                    shortcut: treeShortcutLabel(platform, 'paste'),
                    run: () => pasteInto(entry),
                  },
                ]
              : []),
            {
              id: 'duplicate',
              label: t('menu.duplicate'),
              shortcut: treeShortcutLabel(platform, 'duplicate'),
              run: () => void copyEntries(targets(entry), '', 'duplicate'),
            },
            { id: 'move-to', label: t('menu.moveTo'), run: () => setMoveFor(targets(entry)) },
            // S52.4: into this folder (or the folder this file is in)
            { id: 'add-files', label: t('menu.addFiles'), run: () => void startImport('files', dropFolder(entry)) },
            { id: 'add-image', label: t('menu.addImage'), run: () => void startImport('image', dropFolder(entry)) },
          ]
        : []),
      {
        id: 'delete',
        label: t('menu.delete'),
        shortcut: treeShortcutLabel(platform, 'delete'),
        run: () => setConfirmDelete(fileOpsApi ? targets(entry) : [entry]),
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
              setConfirmDelete(fileOpsApi ? targets(entry) : [entry]);
            }}
            onReveal={reveal}
            onUnportable={(entry) =>
              setOpError({ text: fill(t('tree.unportableExplain'), { name: entry.name }), detail: '' })
            }
            onContextMenu={(entry, anchor) => setMenu({ entry, ...anchor })}
            onSelectionChange={(entry) => {
              selected.current = entry;
            }}
            onSelectionEntries={onSelectionEntries}
            projectName={project.name}
            {...(fileOpsApi
              ? {
                  onMoveDrop: (sources, folder) => void moveEntries(sources, folder),
                  onFilesDrop: (files, folder) => void dropFiles(files, folder), // S52.5
                  onCopy: (entry) => copyToClipboard(targets(entry)),
                  onPaste: (entry) => pasteInto(entry),
                  onDuplicate: (entry) => void copyEntries(targets(entry), '', 'duplicate'),
                }
              : {})}
          />
        </div>
      ) : (
        <div className="empty-state">
          <span className="empty-icon">
            <FolderIcon />
          </span>
          <p className="empty-title">{t('files.empty')}</p>
          {/* S47.2: no button here — the welcome owns the window's one Open folder action. */}
          <p className="empty-detail">{t('files.emptyHint')}</p>
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
      {nameAsk && (
        <ImportNameDialog
          name={nameAsk.name}
          existing={nameAsk.existing}
          folder={nameAsk.folder}
          suggestion={
            nameAsk.existing === null
              ? nameAsk.name
              : copyName(
                  nameAsk.name,
                  (c) => !sameName(c, nameAsk.existing ?? '', false),
                  nameAsk.isFolder ? 'directory' : 'file',
                )
          }
          onRename={(name) => {
            setNameAsk(null);
            nameAsk.resolve(name);
          }}
          onSkip={() => {
            setNameAsk(null);
            nameAsk.resolve(null);
          }}
        />
      )}
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
          tone="danger"
          testId="delete-dialog"
          onConfirm={() => void deleteConfirmed()}
          onCancel={() => {
            const entry = confirmDelete[0];
            setConfirmDelete(null);
            if (entry) reload([], entry.relPath);
          }}
        >
          {confirmDelete.length === 1 ? (
            <p>{fill(t('delete.question'), { name: confirmDelete[0]?.name ?? '', trash })}</p>
          ) : (
            <>
              <p>{fill(t('delete.questionMany'), { n: String(confirmDelete.length), trash })}</p>
              <ul className="alert-list" data-testid="delete-list">
                {confirmDelete.slice(0, 8).map((e) => (
                  <li key={e.relPath}>{e.relPath}</li>
                ))}
                {confirmDelete.length > 8 && <li>{fill(t('delete.more'), { n: String(confirmDelete.length - 8) })}</li>}
              </ul>
            </>
          )}
          {confirmDelete.some((e) => e.kind === 'directory') && <p>{t('delete.folderNote')}</p>}
          <p className="dialog-hint">{fill(t('delete.restoreHint'), { trash })}</p>
        </ConfirmDialog>
      )}
    </nav>
  );
}
