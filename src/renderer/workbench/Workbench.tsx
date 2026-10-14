import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { isMac } from '../../platform/labels';
import type { FileContent, FileVersion, OpenedProject } from '../../shared/ipc/contract';
import { useMediaQuery } from '../theme/useMediaQuery';
import { TopBar } from './TopBar';
import { Rail } from './Rail';
import { FilesPanel, type FileOpsHooks } from './FilesPanel';
import { isSameOrBelow } from './file-tree-model';
import { EditorPane, type SaveCopyNotice } from './EditorPane';
import { PreviewPane } from './PreviewPane';
import { ProblemsPanel } from './ProblemsPanel';
import { INITIAL_LAYOUT, NARROW_QUERY, layoutReducer, visibleRegions } from './layout';
import { INITIAL_DOCUMENT_STATE, activeSaveStatus, activeTab, cycleTab, documentReducer } from './document-state';
import { CHANGED_ON_DISK, DocumentSaver, saveEvery } from './save-controller';
import { isUnsaved, saveStatus } from './save-machine';
import { createSavedFileEvents } from './saved-file-events';
import { DEFAULT_FONT_SIZE, zoomFontSize } from './zoom';
// S12: crash-recovery journal
import { useJournals } from '../recovery/useJournal';
import { newBufferId, type JournalScheduler } from '../recovery/journal-scheduler';
import { RecoveryDialog, type RestoreOutcome } from '../recovery/RecoveryDialog';
import type { RecoveredEntry } from '../../shared/ipc/recovery-contract';

const releaseModel = (uri: string) => import('../editor/editor-models').then((m) => m.releaseModel(uri));
const releaseFileModels = () => void import('../editor/editor-models').then((m) => m.releaseFileModels());
// S11: external changes
import { DiskSync, pathsToCheck } from './disk-sync';
import type { DiskActions } from './DiskStateBanner';
const editorModels = () => import('../editor/editor-models');

/**
 * The five workbench regions of PLAN §3 backed by real files: open a folder, open files as tabs (S09), edit, and
 * save through the save pipeline (S10): every tab has a DocumentSaver that coalesces edits, autosaves after a pause
 * and on blur, writes one revision at a time and reports confirmed writes. Edits are never dropped: closing a tab,
 * switching projects or closing the window first saves, and a failed save cancels the action.
 */
export function Workbench() {
  const bridge = window.noobide;
  const platform = bridge?.platform ?? 'other';
  const [layout, dispatchLayout] = useReducer(layoutReducer, INITIAL_LAYOUT);
  const [doc, dispatch] = useReducer(documentReducer, INITIAL_DOCUMENT_STATE);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [copyNotice, setCopyNotice] = useState<SaveCopyNotice | null>(null);
  /** A window close was refused because a save failed: offer "close without saving" (S10.6). */
  const [closeRefused, setCloseRefused] = useState(false);
  /** Paths being renamed, moved or trashed: their tabs are read-only until the operation ends (S08 + S10). */
  const [lockedPaths, setLockedPaths] = useState<readonly string[]>([]);
  const narrow = useMediaQuery(NARROW_QUERY);
  const visible = visibleRegions(layout, narrow);

  // Async handlers read the latest state without being re-created on every keystroke.
  const docRef = useRef(doc);
  docRef.current = doc;
  /** One saver per open tab, keyed by relPath. Owns the live text and the save state of that file. */
  const savers = useRef(new Map<string, DocumentSaver>());
  /** Bumped whenever the project changes: file reads that started for an older project are dropped. */
  const projectSeq = useRef(0);
  const loading = useRef(new Set<string>());
  /** Confirmed writes, for the preview refresh (S10.5): emitted strictly after the write and the status update. */
  const savedFiles = useRef(createSavedFileEvents());
  // S12: each tab's unsaved buffer is journaled to app data until saved (independent of undo, autosave, history).
  const journals = useJournals(bridge);
  const tabJournals = useRef(new Map<string, JournalScheduler>());
  // --- S11: external changes ---
  /** Per open tab: the disk version its buffer is based on (last read, reload or confirmed save). */
  const knownDisk = useRef(new Map<string, FileVersion>());
  /** Tabs whose model is being replaced with the disk text: that edit is not the user's. */
  const reloading = useRef(new Set<string>());
  const lockedRef = useRef<readonly string[]>([]);
  lockedRef.current = lockedPaths;
  /** A deleted file's tab the user asked to close: the banner asks to confirm (S11.3). */
  const [confirmCloseDeleted, setConfirmCloseDeleted] = useState<string | null>(null);
  // --- end S11 ---

  const saverOf = (relPath: string | null | undefined) => (relPath ? savers.current.get(relPath) : undefined);
  const relPathOfUri = (uri: string) => docRef.current.tabs.find((tab) => tab.uri === uri)?.relPath;

  /**
   * Creates the saver and the journal of a newly opened tab. `journal` continues a restored crash copy's record;
   * otherwise every load gets a fresh buffer id, so it never overwrites another run's crash copy.
   */
  const createSaver = useCallback(
    (
      project: OpenedProject,
      relPath: string,
      content: FileContent,
      journal: { bufferId: string; baseRevision: number } = { bufferId: newBufferId(), baseRevision: 0 },
    ) => {
      const scheduler = journals.create();
      scheduler.begin({ projectId: project.projectId, relPath, bom: content.bom, ...journal });
      tabJournals.current.set(relPath, scheduler);
      knownDisk.current.set(relPath, content.version); // S11.1
      const saver = new DocumentSaver({
        initialText: content.text,
        async write(text, { create }) {
          if (!bridge) return { ok: false, code: 'write-failed', message: 'no bridge' };
          // S11.1: main checks the file is still the version this buffer is based on before replacing it.
          const expectedHash = knownDisk.current.get(relPath)?.hash;
          const result = await bridge.workspace.writeFile({
            projectId: project.projectId,
            relPath,
            text,
            bom: content.bom,
            ...(create ? { create: true as const } : expectedHash ? { expectedHash } : {}),
          });
          if (result.ok) {
            if (savers.current.get(relPath) === saver) knownDisk.current.set(relPath, result.value.version);
            return { ok: true };
          }
          // Someone else's version is on disk: load it for the comparison (S11.2).
          if (result.code === CHANGED_ON_DISK) setTimeout(() => void diskSync.current.check(relPath), 0);
          return { ok: false, code: result.code, message: result.message };
        },
        onState: (save) => dispatch({ type: 'saveState', relPath, save }),
      });
      saver.onSaved(({ revision }) => {
        scheduler.saved(revision); // S12: the journal record of this revision is no longer needed
        savedFiles.current.emit({ relPath, uri: content.uri, revision });
      });
      return saver;
    },
    [bridge, journals],
  );

  const forgetTab = (relPath: string) => {
    savers.current.get(relPath)?.dispose();
    savers.current.delete(relPath);
    const journal = tabJournals.current.get(relPath);
    if (journal) journals.release(journal);
    tabJournals.current.delete(relPath);
    knownDisk.current.delete(relPath); // S11
  };

  /**
   * Saves every open file until nothing is unsaved (edits typed during the pass are saved too). On a failure the
   * failing tab is shown (its banner explains) and false is returned.
   */
  const saveAll = useCallback(async (): Promise<boolean> => {
    const result = await saveEvery(() => savers.current.entries());
    if (!result.ok) dispatch({ type: 'activate', relPath: result.failed });
    return result.ok;
  }, []);

  const closeProjectFiles = () => {
    for (const relPath of [...savers.current.keys()]) forgetTab(relPath);
    loading.current.clear();
    projectSeq.current += 1;
    releaseFileModels();
  };

  const openFolder = useCallback(async () => {
    if (!bridge || !(await saveAll())) return;
    const result = await bridge.workspace.openFolder();
    if (!result.ok) dispatch({ type: 'projectOpenFailed' });
    else if (result.value) {
      // Edits typed while the dialog was open are saved too; a failure keeps the current project.
      if (!(await saveAll())) return;
      closeProjectFiles();
      setCopyNotice(null);
      dispatch({ type: 'projectOpened', project: result.value });
    }
  }, [bridge, saveAll]);

  const openFile = useCallback(
    async (relPath: string) => {
      const project = docRef.current.project;
      if (!bridge || !project) return;
      if (savers.current.has(relPath)) {
        dispatch({ type: 'activate', relPath });
        return;
      }
      if (loading.current.has(relPath)) return;
      const seq = projectSeq.current;
      loading.current.add(relPath);
      const result = await bridge.workspace.readFile({ projectId: project.projectId, relPath });
      // A read that finishes after the project changed belongs to nothing any more.
      if (seq !== projectSeq.current) return;
      loading.current.delete(relPath);
      if (savers.current.has(relPath)) return;
      if (result.ok) {
        savers.current.set(relPath, createSaver(project, relPath, result.value));
        dispatch({ type: 'docLoaded', relPath, content: result.value });
      } else {
        dispatch({ type: 'docFailed', relPath, code: result.code });
      }
    },
    [bridge, createSaver],
  );

  /** Closes a tab without saving: only for tabs whose edits are already on disk (or gone with the file). */
  const dropTab = (relPath: string) => {
    const tab = docRef.current.tabs.find((open) => open.relPath === relPath);
    forgetTab(relPath);
    dispatch({ type: 'closed', relPath });
    if (tab) void releaseModel(tab.uri);
  };

  const closeTab = useCallback(async (relPath: string) => {
    const saver = saverOf(relPath);
    const tab = docRef.current.tabs.find((open) => open.relPath === relPath);
    if (!saver || !tab) return;
    if (saver.state.deleted) {
      // S11.3: the file is gone from disk; its text exists only here. Ask before closing.
      dispatch({ type: 'activate', relPath });
      setConfirmCloseDeleted(relPath);
      return;
    }
    // Never drops edits: unsaved text is written first; a failed write keeps the tab open with its banner.
    if (!(await saver.save())) {
      dispatch({ type: 'activate', relPath });
      return;
    }
    // Order matters: the saver goes before the model is discarded (cleared), so that change reaches no saver.
    dropTab(relPath);
  }, []);

  const saveActive = useCallback(() => void saverOf(docRef.current.active)?.save(), []);

  const saveCopy = useCallback(async () => {
    const project = docRef.current.project;
    const tab = activeTab(docRef.current);
    const saver = saverOf(tab?.relPath);
    if (!bridge || !project || !tab || !saver) return;
    const result = await bridge.workspace.saveCopy({
      projectId: project.projectId,
      relPath: tab.relPath,
      text: saver.text,
      bom: tab.content.bom,
    });
    if (result.ok && result.value === null) return; // cancelled
    setCopyNotice(
      result.ok
        ? { relPath: tab.relPath, path: result.value?.path ?? null }
        : { relPath: tab.relPath, path: null, code: result.code, message: result.message },
    );
  }, [bridge]);

  const onChange = useCallback((uri: string, text: string) => {
    const relPath = relPathOfUri(uri);
    const saver = saverOf(relPath);
    if (!relPath || !saver) return;
    if (reloading.current.has(relPath)) return; // S11: the disk text going in is not an edit of the user's
    if (docRef.current.tabs.find((tab) => tab.relPath === relPath)?.diskNotice) {
      dispatch({ type: 'diskNoticeDismissed', relPath });
    }
    saver.edit(text);
    tabJournals.current.get(relPath)?.edited(saver.state.revision, () => saver.text); // S12
  }, []);

  // --- S11: external changes (watcher → re-read → compare hashes → reload / conflict / deleted) ---
  /** Puts a disk version into a tab's buffer: the model (one undoable edit, cursor kept), the saver and the tab. */
  const applyDiskText = useCallback(async (relPath: string, content: FileContent, notice: boolean) => {
    const tab = docRef.current.tabs.find((open) => open.relPath === relPath);
    const saver = saverOf(relPath);
    if (!tab || !saver) return;
    const { replaceModelText } = await editorModels();
    if (saverOf(relPath) !== saver) return;
    reloading.current.add(relPath);
    let text: string;
    try {
      text = replaceModelText(tab.uri, content.text, content.eol) ?? content.text.replace(/\r?\n/g, content.eol);
    } finally {
      reloading.current.delete(relPath);
    }
    saver.reload(text);
    knownDisk.current.set(relPath, content.version);
    tabJournals.current.get(relPath)?.saved(saver.state.revision); // nothing unsaved is left to journal
    dispatch({ type: 'diskReloaded', relPath, content, notice });
  }, []);

  const diskSync = useRef(
    new DiskSync({
      tab: (relPath) => {
        const saver = savers.current.get(relPath);
        return saver ? { saver, known: () => knownDisk.current.get(relPath) } : undefined;
      },
      read: async (relPath) => {
        const project = docRef.current.project;
        if (!bridge || !project) return { ok: false, code: 'unknown-project' };
        const result = await bridge.workspace.readFile({ projectId: project.projectId, relPath });
        return result.ok ? { ok: true, content: result.value } : { ok: false, code: result.code };
      },
      reload: (relPath, content) => void applyDiskTextRef.current(relPath, content, true),
      conflict: (relPath, content) => {
        saverOf(relPath)?.externalChange();
        dispatch({ type: 'diskConflict', relPath, content });
      },
      deleted: (relPath) => saverOf(relPath)?.markDeleted(),
    }),
  );
  const applyDiskTextRef = useRef(applyDiskText);
  applyDiskTextRef.current = applyDiskText;

  const projectIdNow = doc.project?.projectId;
  useEffect(() => {
    if (!bridge || !projectIdNow) return undefined;
    return bridge.workspace.onChanged((change) => {
      if (change.projectId !== docRef.current.project?.projectId) return;
      const open = docRef.current.tabs
        .map((tab) => tab.relPath)
        .filter((relPath) => !lockedRef.current.some((locked) => isSameOrBelow(relPath, locked)));
      for (const relPath of pathsToCheck(change.events, open)) void diskSync.current.check(relPath);
    });
  }, [bridge, projectIdNow]);

  const diskActions = useMemo<DiskActions>(
    () => ({
      dismissNotice: (relPath) => dispatch({ type: 'diskNoticeDismissed', relPath }),
      keepMine: async (relPath) => {
        const saver = saverOf(relPath);
        const disk = docRef.current.tabs.find((tab) => tab.relPath === relPath)?.conflictDisk;
        if (!saver || !disk) return;
        // Overwrite exactly the disk version the user compared; if it changed again, the conflict comes back.
        knownDisk.current.set(relPath, disk.version);
        dispatch({ type: 'conflictCleared', relPath });
        await saver.keepMine();
      },
      takeDisk: async (relPath) => {
        const disk = docRef.current.tabs.find((tab) => tab.relPath === relPath)?.conflictDisk;
        if (!disk) return;
        await applyDiskText(relPath, disk, false);
      },
      resave: async (relPath) => {
        setConfirmCloseDeleted(null);
        await saverOf(relPath)?.recreate();
      },
      askCloseDeleted: (relPath) => setConfirmCloseDeleted(relPath),
      cancelCloseDeleted: () => setConfirmCloseDeleted(null),
      closeDeleted: (relPath) => {
        setConfirmCloseDeleted(null);
        if (saverOf(relPath)?.state.deleted) dropTab(relPath);
      },
    }),
    [applyDiskText],
  );
  // --- end S11 ---

  // ── S08: file operations keep the open tabs consistent ──
  const fileOps = useMemo<FileOpsHooks>(() => {
    const unlock = (relPath: string) => setLockedPaths((paths) => paths.filter((locked) => locked !== relPath));
    return {
      // Renaming, moving or trashing an open file (or a folder holding open files): the affected tabs become
      // read-only for the duration, their edits are saved through each tab's serialized save queue first, and a
      // failed save cancels the operation and shows that tab. Nothing typed during the operation can get lost.
      beforeChange: async (relPath) => {
        setLockedPaths((paths) => [...paths, relPath]);
        for (const [open, saver] of [...savers.current]) {
          if (!isSameOrBelow(open, relPath)) continue;
          if (!(await saver.save())) {
            unlock(relPath);
            dispatch({ type: 'activate', relPath: open });
            return false;
          }
        }
        return true;
      },
      cancelled: unlock,
      afterChange: (change) => {
        const changed = change.type === 'renamed' ? change.from : change.relPath;
        unlock(changed);
        const affected = docRef.current.tabs.map((tab) => tab.relPath).filter((open) => isSameOrBelow(open, changed));
        // A tab that somehow still has unsaved edits is never dropped: it stays open as an unsaved buffer (its
        // saves now explain that the file is gone, and "save elsewhere" keeps the text).
        const clean = affected.filter((open) => {
          const saver = saverOf(open);
          return !saver || !isUnsaved(saver.state);
        });
        const wasActive = docRef.current.active;
        for (const open of clean) dropTab(open);
        if (change.type === 'renamed') {
          // Reopen at the new path(s) from disk (the text is the same: it was saved); the visible file stays visible.
          const moved = clean.map((open) => change.to + open.slice(change.from.length));
          const visible =
            wasActive && clean.includes(wasActive) ? change.to + wasActive.slice(change.from.length) : null;
          void (async () => {
            for (const relPath of moved) if (relPath !== visible) await openFile(relPath);
            if (visible) await openFile(visible);
          })();
        }
      },
    };
  }, [openFile]);

  // --- S12: restore after an abnormal termination (RecoveryDialog) ---
  const adoptProject = useCallback(
    async (project: OpenedProject) => {
      if (!(await saveAll())) return false;
      closeProjectFiles();
      setCopyNotice(null);
      dispatch({ type: 'projectOpened', project });
      return true;
    },
    [saveAll],
  );

  /**
   * Opens the file in a tab with the recovered text as unsaved edits; it reaches the disk only when the user saves
   * (autosave leaves a restored copy alone until the user edits it). A tab of the same file with unsaved edits of
   * its own is never overwritten: the user saves first.
   */
  const restoreRecovered = useCallback(
    async (project: OpenedProject, entry: RecoveredEntry): Promise<RestoreOutcome> => {
      if (!entry.disk || docRef.current.project?.projectId !== project.projectId) return 'failed';
      const { relPath, bufferId, bom } = entry;
      const open = saverOf(relPath);
      if (open) {
        if (open.busy || isUnsaved(open.state)) return 'save-first';
        const tab = docRef.current.tabs.find((t) => t.relPath === relPath);
        forgetTab(relPath);
        dispatch({ type: 'closed', relPath });
        if (tab) await releaseModel(tab.uri); // the restored text must get a fresh model, not the clean one
        if (docRef.current.project?.projectId !== project.projectId || savers.current.has(relPath)) return 'failed';
      }
      const disk = { ...entry.disk, bom };
      // Continue the crashed buffer's journal record so the first save removes it (journal revision = entry's).
      const saver = createSaver(project, relPath, disk, { bufferId, baseRevision: entry.revision - 1 });
      savers.current.set(relPath, saver);
      saver.restore(entry.text);
      dispatch({ type: 'docLoaded', relPath, content: { ...disk, text: entry.text } });
      dispatch({ type: 'saveState', relPath, save: saver.state });
      return 'restored';
    },
    [createSaver],
  );

  /** The journal was cleared: unsaved edits still open in the editor are journaled again right away. */
  const rejournal = useCallback(() => {
    for (const [relPath, saver] of savers.current) {
      if (isUnsaved(saver.state)) tabJournals.current.get(relPath)?.resend(saver.state.revision, () => saver.text);
    }
  }, []);
  // --- end S12 ---
  const onBlur = useCallback((uri: string) => saverOf(relPathOfUri(uri))?.blur(), []);
  const onComposition = useCallback((uri: string, composing: boolean) => {
    const saver = saverOf(relPathOfUri(uri));
    if (composing) saver?.compositionStart();
    else saver?.compositionEnd();
  }, []);

  // Closing the window or quitting: main asks first; we answer after every file is saved (S10.6).
  useEffect(() => {
    if (!bridge) return;
    return bridge.app.onCloseRequested(() => {
      void saveAll().then((ok) => {
        if (!ok) setCloseRefused(true);
        return bridge.app.answerClose({ ok });
      });
    });
  }, [bridge, saveAll]);

  useEffect(
    () => () => {
      for (const saver of savers.current.values()) saver.dispose();
    },
    [],
  );

  // Window-wide shortcuts. Ctrl+S / ⌘S also works when focus is outside the editor (Monaco handles it inside).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = isMac(platform) ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();
      if (modifier && !event.altKey && !event.shiftKey && key === 's') {
        event.preventDefault();
        saveActive();
      }
    };
    // Capture phase, before Monaco and before the menu's whole-window zoom: Ctrl+Tab switches tabs (also on macOS,
    // like other editors), Ctrl/⌘ with + − 0 zooms the code font.
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        const next = cycleTab(docRef.current, event.shiftKey ? -1 : 1);
        if (next) dispatch({ type: 'activate', relPath: next });
        return;
      }
      const modifier = isMac(platform) ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey) return;
      const step = { '=': 1, '+': 1, '-': -1, _: -1, '0': 0 }[event.key] as 1 | -1 | 0 | undefined;
      if (step !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        setFontSize((size) => zoomFontSize(size, step));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keydown', onKeyDownCapture, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', onKeyDownCapture, true);
    };
  }, [platform, saveActive]);

  const project = doc.project;
  return (
    <div className={narrow ? 'workbench narrow' : 'workbench'}>
      <TopBar
        platform={platform}
        project={project}
        save={activeSaveStatus(doc)}
        onReveal={() => {
          if (bridge && project) void bridge.workspace.revealProject({ projectId: project.projectId });
        }}
        narrow={
          visible.narrowSwitch
            ? { view: layout.narrowView, onShow: (view) => dispatchLayout({ type: 'showNarrowView', view }) }
            : undefined
        }
      />
      <div className="workbench-middle">
        <Rail
          filesVisible={visible.files}
          problemsOpen={visible.problemsPanel}
          onToggleFiles={() => dispatchLayout({ type: 'toggleFiles', narrow })}
          onToggleProblems={() => dispatchLayout({ type: 'toggleProblems' })}
        />
        <FilesPanel
          hidden={!visible.files}
          project={project}
          activeRelPath={doc.active}
          openFailed={doc.openFailed}
          onOpenFolder={bridge ? () => void openFolder() : undefined}
          onOpenFile={(relPath) => void openFile(relPath)}
          api={bridge?.workspace}
          platform={platform}
          fileOps={fileOps}
        />
        <EditorPane
          hidden={!visible.editor}
          state={doc}
          fontSize={fontSize}
          onZoom={(step) => setFontSize((size) => zoomFontSize(size, step))}
          onActivate={(relPath) => dispatch({ type: 'activate', relPath })}
          onClose={(relPath) => void closeTab(relPath)}
          onChange={onChange}
          onSave={saveActive}
          onBlur={onBlur}
          onComposition={onComposition}
          onRetry={saveActive}
          onSaveCopy={bridge ? () => void saveCopy() : undefined}
          copyNotice={copyNotice}
          lockedPaths={lockedPaths}
          onCloseDiscarding={bridge && closeRefused ? () => void bridge.app.closeDiscarding() : undefined}
          diskActions={diskActions}
          confirmCloseDeleted={confirmCloseDeleted}
        />
        {/* S04.3 isolated preview (hidden under the narrow-layout files overlay so the native view cannot cover it);
            S10.5: a failed save shows "preview not updated" — refreshes come only from confirmed writes in main. */}
        <PreviewPane
          hidden={!visible.preview}
          covered={narrow && visible.files}
          projectId={project?.projectId ?? null}
          saveFailed={doc.tabs.some((tab) => saveStatus(tab.save) === 'failed')}
        />
      </div>
      <ProblemsPanel open={visible.problemsPanel} onToggle={() => dispatchLayout({ type: 'toggleProblems' })} />
      {/* S12: crash-recovery prompt and journal health */}
      <RecoveryDialog
        bridge={bridge}
        health={journals.health}
        onProjectOpened={adoptProject}
        onRestore={restoreRecovered}
        onCleared={rejournal}
      />
    </div>
  );
}
