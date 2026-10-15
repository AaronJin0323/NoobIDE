import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react';
import { useAppMenuItems, useCommands, type CommandHandlers } from '../commands/useCommands'; // S24.1
import type { FileContent, FileVersion, OpenedProject } from '../../shared/ipc/contract';
import { useMediaQuery } from '../theme/useMediaQuery';
import { TopBar } from './TopBar';
import { Rail } from './Rail';
import { FilesPanel, type ExtraMenuItem, type FileOpsHooks } from './FilesPanel';
import { isSameOrBelow } from './file-tree-model';
import { EditorPane, type SaveCopyNotice } from './EditorPane';
import { PreviewPane } from './PreviewPane';
import { PREVIEW_COMMAND_HANDLERS } from './preview-commands'; // S15.4
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
// S20.2: welcome screen and create-project wizard
import { WelcomeScreen } from '../welcome/WelcomeScreen';
import { CreateProjectDialog } from '../welcome/CreateProjectDialog';
import { recentProjectsSource } from '../welcome/welcome-model';
import type { CreatedProject } from '../../shared/ipc/create-contract';
// S21.3/S21.4: local history window
import { HistoryDialog } from '../history/HistoryDialog';
import type { RestoreOutcome as HistoryRestoreOutcome } from '../history/history-model';

/** S21.3: polls until `get` returns a value (state that arrives with a later render), or undefined after `ms`. */
async function eventually<T>(get: () => T | undefined, ms = 3000): Promise<T | undefined> {
  const started = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined || Date.now() - started > ms) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
// S18.4: the project's other JavaScript files feed the JavaScript language service.
import { useProjectScripts } from '../editor/useProjectScripts';
// S19.1: static problems (language-service markers of the open files).
import { useStaticProblems } from '../problems/useStaticProblems';
// S17.1: runtime / resource problems (main's store when present, else the preview's events) and the panel view.
import { useRuntimeProblems } from '../problems/useRuntimeProblems';
import { buildView } from '../problems/problems-view';
// S17.2 / S22.4: the problem card (go to code, original error, explanation and checks).
import { ProblemDetails } from '../problems/ProblemDetails';
// S22.5: one-click fix of a misspelled name.
import { FixCard } from '../problems/FixCard';
import { createFixHost } from '../problems/fix-host';
import { useProblemFix } from '../problems/useProblemFix';
import { usePreviewLoads } from '../problems/usePreviewLoads';
import { requestReveal } from '../editor/editor-handle';
// S23: onboarding walkthrough, final task and glossary
import { useWalkthrough } from '../walkthrough/useWalkthrough';
import { WalkthroughPanel } from '../walkthrough/WalkthroughPanel';
import { GlossaryDialog } from '../walkthrough/GlossaryDialog';

const releaseModel = (uri: string) => import('../editor/editor-models').then((m) => m.releaseModel(uri));
const releaseFileModels = () => void import('../editor/editor-models').then((m) => m.releaseFileModels());
// S11: external changes
import { DiskSync, pathsToCheck } from './disk-sync';
import type { DiskActions } from './DiskStateBanner';
const editorModels = () => import('../editor/editor-models');
// S13 app data
import type { SettingsSnapshot } from '../../shared/ipc/app-data-contract';
import { SettingsNotice } from './SettingsNotice';
import type { CommandContext } from '../../shared/commands'; // S24.1
import { useThemeChoice } from '../theme/ThemeProvider'; // S24.4
import { focusRegion } from '../commands/focus-regions'; // S24.3
import { openAbout } from './about'; // S28.1
import { isEntryPath } from '../../shared/project-config';
import type { TreeEntry } from '../../shared/ipc/contract';
import { EntryNotice, type EntryNoticeState } from './EntryNotice';
import { SessionNotice } from './SessionNotice';
import { TransferNotice } from './TransferNotice'; // S13.5
import { useI18n } from '../i18n/I18nProvider';
import { opErrorMessage } from './file-op-messages';
import { Splitter } from './Splitter';
import { persistedLayout } from './layout';
import { EDITOR_SHARE, FILES_WIDTH, MAX_SESSION_TABS } from '../../shared/session';
import { AboutDialog, useAboutRequests } from './AboutDialog'; // S28.1
import { aiBridge } from '../ai/inline-status'; // S32.1
import { toggleInlineAi } from '../ai/useInlineAiState'; // S32.1

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
  const { t } = useI18n(); // S13.4: splitter labels
  const [doc, dispatch] = useReducer(documentReducer, INITIAL_DOCUMENT_STATE);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [copyNotice, setCopyNotice] = useState<SaveCopyNotice | null>(null);
  /** A window close was refused because a save failed: offer "close without saving" (S10.6). */
  const [closeRefused, setCloseRefused] = useState(false);
  /** Paths being renamed, moved or trashed: their tabs are read-only until the operation ends (S08 + S10). */
  const [lockedPaths, setLockedPaths] = useState<readonly string[]>([]);
  // S20.2: the create wizard; a created project's entry page to open, and its preview to start (trusted template).
  const [wizardOpen, setWizardOpen] = useState(false);
  const [pendingEntry, setPendingEntry] = useState<{ projectId: string; relPath: string } | null>(null);
  const [autoPreview, setAutoPreview] = useState<string | null>(null);
  // S21.3: the local-history window, opened for a file (the active tab) or for the whole project.
  const [historyFor, setHistoryFor] = useState<{ relPath: string | null } | null>(null);
  const aboutOpen = useAboutRequests(); // S28.1: opened by openAbout() (menus: S24)
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
  // --- S13.1: persisted settings (app data) ---
  const [settingsNotice, setSettingsNotice] = useState<SettingsSnapshot | null>(null);
  const settingsLoaded = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void bridge?.settings?.get().then((result) => {
      if (cancelled || !result.ok) return;
      settingsLoaded.current = true;
      setFontSize(result.value.settings.editorFontSize);
      if (result.value.notice) setSettingsNotice(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);
  useEffect(() => {
    // The code font size (zoom) is remembered once the stored value has been applied.
    if (settingsLoaded.current) void bridge?.settings?.update({ editorFontSize: fontSize });
  }, [bridge, fontSize]);
  // --- end S13.1 ---
  // --- S13.2: "set as entry page" writes .noobide/project.json (the only file NoobIDE writes into a project) ---
  const [entryNotice, setEntryNotice] = useState<EntryNoticeState | null>(null);
  const extraMenuItems = useCallback(
    (entry: TreeEntry): ExtraMenuItem[] => {
      const project = docRef.current.project;
      const api = bridge?.projectConfig;
      if (!project || !api || entry.kind !== 'file' || entry.unportable || !isEntryPath(entry.relPath)) return [];
      const run = () =>
        void api
          .setEntry({ projectId: project.projectId, entry: entry.relPath })
          .then((result) =>
            setEntryNotice(
              result.ok
                ? { relPath: entry.relPath, error: null }
                : { relPath: entry.relPath, error: result.code === 'invalid-existing' ? 'invalid-existing' : 'failed' },
            ),
          );
      return [{ id: 'set-entry', label: 'files.setEntry', run }];
    },
    [bridge],
  );
  // --- end S13.2 ---
  useProjectScripts(bridge, doc.project); // S18.4
  const staticProblems = useStaticProblems(doc.project?.projectId ?? null, doc.tabs); // S19.1
  const runtimeProblems = useRuntimeProblems(bridge); // S17.1
  const problemsView = useMemo(
    () => buildView(doc.project?.projectId ?? null, staticProblems.records, runtimeProblems.records),
    [doc.project?.projectId, staticProblems.records, runtimeProblems.records],
  );
  // --- S23: walkthrough (detects each step from real state) and the glossary ---
  const walkthroughProblems = useMemo(
    () => [...staticProblems.records, ...runtimeProblems.records],
    [staticProblems.records, runtimeProblems.records],
  );
  const walkthrough = useWalkthrough({
    bridge,
    project: doc.project,
    openTabs: doc.tabs.map((tab) => tab.relPath),
    problems: walkthroughProblems,
    savedFiles: savedFiles.current,
  });
  const walkthroughRef = useRef(walkthrough);
  walkthroughRef.current = walkthrough;
  const [glossaryFor, setGlossaryFor] = useState<{ term: string | null } | null>(null);
  // --- end S23 ---

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
  // --- S13 command menu ---
  // S13.3: closing a project saves every file first (a failed save keeps it open), then main stops its watcher,
  // preview and server; the welcome screen with the recent projects shows again.
  const closeProject = useCallback(async () => {
    const project = docRef.current.project;
    const lifecycle = bridge?.lifecycle;
    if (!project || !lifecycle || !(await saveAll())) return;
    const result = await lifecycle.closeProject({ projectId: project.projectId });
    if (!result.ok && result.code !== 'unknown-project') return;
    if (docRef.current.project?.projectId !== project.projectId) return;
    closeProjectFiles();
    setCopyNotice(null);
    dispatch({ type: 'projectClosed' });
  }, [bridge, saveAll]);
  // --- end S13 (the command menu is derived from the S24.1 command registry below) ---

  const openFolder = useCallback(async () => {
    if (!bridge || !(await saveAll())) return;
    const result = await bridge.workspace.openFolder();
    if (!result.ok) dispatch({ type: 'projectOpenFailed', code: result.code });
    else if (result.value) {
      // Edits typed while the dialog was open are saved too; a failure keeps the current project.
      if (!(await saveAll())) return;
      closeProjectFiles();
      setCopyNotice(null);
      dispatch({ type: 'projectOpened', project: result.value });
    }
  }, [bridge, saveAll]);

  const openFile = useCallback(
    async (relPath: string, options: { readonly quiet?: boolean } = {}) => {
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
      } else if (!options.quiet) {
        // S13.4: a file from the last session that is gone now is simply not reopened (quiet).
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

  /**
   * An edit of an open file's text, wherever it came from (typing in the editor, a history restore, a one-click fix
   * applied to a background tab): the save pipeline gets the text, the recovery journal records it (S12) and a
   * "changed on disk" notice is dismissed. The disk text going in during an S11 reload is not the user's edit.
   */
  const recordEdit = useCallback((relPath: string | undefined, text: string) => {
    const saver = saverOf(relPath);
    if (!relPath || !saver) return;
    if (reloading.current.has(relPath)) return; // S11: the disk text going in is not an edit of the user's
    if (docRef.current.tabs.find((tab) => tab.relPath === relPath)?.diskNotice) {
      dispatch({ type: 'diskNoticeDismissed', relPath });
    }
    saver.edit(text);
    tabJournals.current.get(relPath)?.edited(saver.state.revision, () => saver.text); // S12
  }, []);
  const onChange = useCallback((uri: string, text: string) => recordEdit(relPathOfUri(uri), text), [recordEdit]);

  // --- S11: external changes (watcher → re-read → compare hashes → reload / conflict / deleted) ---
  /** Puts a disk version into a tab's buffer: the model (one undoable edit, cursor kept), the saver and the tab. */
  const applyDiskText = useCallback(async (relPath: string, content: FileContent, notice: boolean) => {
    const tab = docRef.current.tabs.find((open) => open.relPath === relPath);
    const saver = saverOf(relPath);
    if (!tab || !saver) return;
    const { reloadModelText } = await editorModels();
    if (saverOf(relPath) !== saver) return;
    reloading.current.add(relPath);
    let text: string;
    try {
      text = reloadModelText(tab.uri, content.text, content.eol) ?? content.text.replace(/\r?\n/g, content.eol);
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
        if (!saver || !disk || !saver.state.conflict || saver.state.deleted) return;
        // Overwrite exactly the disk version the user compared; if it changed again, the conflict comes back.
        knownDisk.current.set(relPath, disk.version);
        dispatch({ type: 'conflictCleared', relPath });
        await saver.keepMine();
      },
      takeDisk: async (relPath) => {
        const saver = saverOf(relPath);
        const disk = docRef.current.tabs.find((tab) => tab.relPath === relPath)?.conflictDisk;
        if (!saver || !disk || !saver.state.conflict || saver.state.deleted) return;
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

  // The preview's "rename to … .html" for a page saved without its ending: same path as a rename in the Files panel
  // (unsaved edits saved first, open tabs follow, an existing name is never replaced).
  const renamePage = useCallback(
    async (from: string, to: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
      const projectId = docRef.current.project?.projectId;
      const name = to.split('/').pop() ?? to;
      if (!bridge || !projectId) return { ok: false, reason: t('op.generic') };
      if (!(await fileOps.beforeChange(from))) return { ok: false, reason: t('op.saveFirstFailed') };
      try {
        const result = await bridge.workspace.renameEntry({ projectId, from, to });
        if (!result.ok) {
          fileOps.cancelled?.(from);
          return { ok: false, reason: opErrorMessage(t, result.code, result.message, name) };
        }
        fileOps.afterChange({ type: 'renamed', from, to });
        return { ok: true };
      } catch {
        fileOps.cancelled?.(from);
        return { ok: false, reason: t('op.generic') };
      }
    },
    [bridge, fileOps, t],
  );

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

  // --- S20.2: a project created by the wizard (or opened from the recent list) becomes the current project ---
  const projectCreated = useCallback(
    async (created: CreatedProject) => {
      setWizardOpen(false);
      if (!(await adoptProject(created.project))) return;
      walkthroughRef.current.projectCreated(); // S23: the first project starts the walkthrough
      setPendingEntry({ projectId: created.project.projectId, relPath: created.entry });
      setAutoPreview(created.project.projectId);
    },
    [adoptProject],
  );

  // The entry page opens once the new project is the current one (openFile reads the project from state).
  useEffect(() => {
    if (pendingEntry && doc.project?.projectId === pendingEntry.projectId) {
      setPendingEntry(null);
      void openFile(pendingEntry.relPath);
    }
  }, [pendingEntry, doc.project, openFile]);
  const recentProjects = useMemo(() => recentProjectsSource(bridge), [bridge]);
  // --- end S20.2 ---

  // --- S21.3: local history. A restore never writes the file behind the editor's back: the version becomes the
  // content of the file's tab (one undo step) and is saved through that tab's save pipeline. ---
  const historyCurrentText = useCallback(
    async (relPath: string): Promise<string | null> => {
      const open = saverOf(relPath);
      if (open) return open.text;
      const project = docRef.current.project;
      if (!bridge || !project) return null;
      const result = await bridge.workspace.readFile({ projectId: project.projectId, relPath });
      if (result.ok) return result.value.text;
      if (result.code === 'not-found') return null;
      // Any other failure: no comparison at all rather than a misleading one (the dialog explains).
      throw new Error(result.code);
    },
    [bridge],
  );

  const restoreVersion = useCallback(
    async (relPath: string, text: string): Promise<HistoryRestoreOutcome> => {
      const project = docRef.current.project;
      if (!bridge || !project) return 'failed';
      // Every step below waits; the project must still be the same one afterwards.
      const same = () => docRef.current.project?.projectId === project.projectId;
      await openFile(relPath); // opens the tab (or shows it) through the normal editor path
      if (!same()) return 'failed';
      dispatch({ type: 'activate', relPath });
      // The tab appears in state with the next render.
      const tab = await eventually(() => docRef.current.tabs.find((open) => open.relPath === relPath));
      const saver = saverOf(relPath);
      if (!saver || !tab || !same()) return 'failed';
      if (tab.content.readOnly) return 'read-only';
      // 1. Edits not on disk yet are saved first (they become a version through the save itself).
      if (!(await saver.save())) return 'save-failed';
      if (!same()) return 'failed';
      // 2. What is on disk now is kept as a version (reason "before restore").
      const kept = await bridge.history.beforeRestore({ projectId: project.projectId, relPath });
      if (!kept.ok || !same() || saver !== saverOf(relPath)) return 'failed';
      // 3. The version becomes the editor content as one undoable edit, then goes through the save pipeline.
      const applied = await import('../editor/editor-models').then((m) => m.replaceModelText(tab.uri, text));
      if (applied === null || saver !== saverOf(relPath)) return 'failed';
      // The editor reports the edit only for the model it shows; a background tab's edit is recorded here (journal).
      if (saver.text !== applied) recordEdit(relPath, applied);
      if (!(await saver.save())) return 'save-failed';
      walkthroughRef.current.historyRestored(); // S23: the "recover" step
      return 'restored';
    },
    [bridge, openFile, recordEdit],
  );
  // The history window belongs to one project: it closes when the project changes.
  const historyProjectId = doc.project?.projectId;
  useEffect(() => setHistoryFor(null), [historyProjectId]);
  // --- end S21.3 ---

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

  // --- S17.2: Go to code. Opens the file (if needed), then the editor moves to the reported place and takes focus. ---
  const [pendingGoTo, setPendingGoTo] = useState<{ file: string; line: number; column?: number } | null>(null);
  const goTo = useCallback(
    (target: { file: string; line: number; column?: number }) => {
      setPendingGoTo(target);
      if (narrow) dispatchLayout({ type: 'showNarrowView', view: 'code' }); // the code must be visible
      void openFile(target.file);
    },
    [openFile, narrow],
  );
  useEffect(() => {
    if (!pendingGoTo) return;
    const tab = doc.tabs.find((open) => open.relPath === pendingGoTo.file);
    if (!tab || doc.active !== tab.relPath) return;
    requestReveal({
      uri: tab.uri,
      line: pendingGoTo.line,
      ...(pendingGoTo.column !== undefined ? { column: pendingGoTo.column } : {}),
      focus: true,
    });
    setPendingGoTo(null);
  }, [pendingGoTo, doc.tabs, doc.active]);
  // A file that could not be opened ends the request (its error is shown by the editor pane).
  useEffect(() => {
    if (pendingGoTo && doc.docError?.relPath === pendingGoTo.file) setPendingGoTo(null);
  }, [pendingGoTo, doc.docError]);
  // --- end S17.2 ---

  // --- S22.4/S22.5: problem card explained with the facts of its location; one-click fix of a misspelled name, as
  // an ordinary editor edit saved through the file's own save pipeline (problems/fix-host.ts). ---
  const fixHost = useMemo(
    () =>
      createFixHost({
        async showFile(relPath) {
          const project = docRef.current.project;
          if (!project) return null;
          await openFile(relPath);
          if (docRef.current.project?.projectId !== project.projectId) return null;
          dispatch({ type: 'activate', relPath });
          const tab = await eventually(() => docRef.current.tabs.find((open) => open.relPath === relPath));
          return tab ? { uri: tab.uri, readOnly: Boolean(tab.content.readOnly) } : null;
        },
        saverOf: (relPath) => saverOf(relPath),
        recordEdit,
        uriOf: (relPath) => docRef.current.tabs.find((tab) => tab.relPath === relPath)?.uri,
        savedFiles: savedFiles.current,
      }),
    [openFile, recordEdit],
  );
  const previewLoads = usePreviewLoads(bridge);
  const problemFix = useProblemFix(fixHost, runtimeProblems.records, previewLoads);
  // A fix belongs to its project: another project starts without one.
  const clearFix = problemFix.clear;
  useEffect(() => clearFix(), [doc.project?.projectId, clearFix]);
  const uriOfFile = useCallback(
    (relPath: string) => docRef.current.tabs.find((tab) => tab.relPath === relPath)?.uri,
    [],
  );
  // --- end S22.4/S22.5 ---

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

  // --- S24.1: command registry. Shortcuts (⌘S / Ctrl+S everywhere in the window, Ctrl+Tab, ⌘/Ctrl with + − 0 for
  // the code font, …), the in-window menu and its hints all come from src/shared/commands. ---
  const theme = useThemeChoice();
  const switchTab = (step: 1 | -1) => {
    const next = cycleTab(docRef.current, step);
    if (next) dispatch({ type: 'activate', relPath: next });
  };
  const commandContext: CommandContext = {
    hasProject: doc.project !== null,
    hasActiveTab: doc.active !== null,
    modalOpen: wizardOpen || historyFor !== null || aboutOpen.open || glossaryFor !== null,
    theme: theme.choice, // S24.4
  };
  const commandHandlers: CommandHandlers = {
    'new-project': bridge?.createProject ? () => setWizardOpen(true) : undefined,
    'open-folder': bridge ? () => void openFolder() : undefined,
    save: saveActive,
    'close-tab': () => {
      const active = docRef.current.active;
      if (active !== null) void closeTab(active);
    },
    'close-project': bridge?.lifecycle ? () => void closeProject() : undefined,
    'show-history': bridge?.history ? () => setHistoryFor({ relPath: docRef.current.active }) : undefined,
    'toggle-files': () => dispatchLayout({ type: 'toggleFiles', narrow }),
    'toggle-problems': () => dispatchLayout({ type: 'toggleProblems' }),
    'zoom-in': () => setFontSize((size) => zoomFontSize(size, 1)),
    'zoom-out': () => setFontSize((size) => zoomFontSize(size, -1)),
    'zoom-reset': () => setFontSize((size) => zoomFontSize(size, 0)),
    'next-tab': () => switchTab(1),
    'previous-tab': () => switchTab(-1),
    'open-logs': bridge?.logs ? () => void bridge.logs?.openFolder() : undefined,
    // S24.4: the theme choice is persisted in the app settings by the ThemeProvider.
    'theme-system': () => theme.setChoice('system'),
    'theme-light': () => theme.setChoice('light'),
    'theme-dark': () => theme.setChoice('dark'),
    // S24.3: keyboard route between the regions (Tab indents inside the code editor).
    'focus-next-region': () => void focusRegion(1),
    'focus-previous-region': () => void focusRegion(-1),
    about: () => openAbout(), // S28.1
    // S23: onboarding help
    'help-walkthrough': () => walkthroughRef.current.open(),
    'help-glossary': () => setGlossaryFor({ term: null }),
    // S32.1: AI ghost-text suggestions on / off (offered only when the AI bridge exists)
    'toggle-inline-ai': aiBridge() ? () => toggleInlineAi(docRef.current.project?.projectId ?? null) : undefined,
    ...PREVIEW_COMMAND_HANDLERS, // S15.4: preview toolbar commands (forwarded to the preview pane)
  };
  const commands = useCommands(platform, commandContext, commandHandlers);
  const menuItems = useAppMenuItems(platform, commandContext, commandHandlers, commands.run);
  // --- end S24.1 ---

  // --- S13.4: session restore. On a normal start main reopens the last project (crash recovery takes precedence: it
  // reports recovery-pending and the recovery dialog offers the unsaved buffers instead); its tabs, the visible tab
  // and the layout sizes come back. Tabs and layout are saved shortly after every change. ---
  const [restoredFrom, setRestoredFrom] = useState<string | null>(null);
  const layoutReady = useRef(false);
  const restoreRequested = useRef(false);
  useEffect(() => {
    const api = bridge?.session;
    if (!api || restoreRequested.current) {
      layoutReady.current = true;
      return;
    }
    restoreRequested.current = true;
    void api.restore().then(async (result) => {
      layoutReady.current = true;
      if (!result.ok) return;
      if (result.value.layout) dispatchLayout({ type: 'restoreLayout', layout: result.value.layout });
      const restored = result.value.project;
      if (restored && !docRef.current.project && (await adoptProject(restored))) setRestoredFrom(restored.rootPath);
    });
  }, [bridge, adoptProject]);

  const restoringTabs = useRef(false);
  const projectIdForTabs = doc.project?.projectId;
  useEffect(() => {
    const api = bridge?.session;
    if (!api || !projectIdForTabs) return undefined;
    let cancelled = false;
    restoringTabs.current = true;
    void api
      .tabs({ projectId: projectIdForTabs })
      .then(async (result) => {
        if (cancelled || !result.ok || !result.value) return;
        for (const relPath of result.value.tabs) {
          if (cancelled) return;
          await openFile(relPath, { quiet: true });
        }
        const active = result.value.active;
        if (!cancelled && active && savers.current.has(active)) dispatch({ type: 'activate', relPath: active });
      })
      .finally(() => {
        if (!cancelled) restoringTabs.current = false;
      });
    return () => {
      cancelled = true;
      restoringTabs.current = false;
    };
  }, [bridge, projectIdForTabs, openFile]);

  const tabPaths = doc.tabs.map((tab) => tab.relPath).slice(0, MAX_SESSION_TABS);
  const tabsKey = tabPaths.join('\n');
  const activeTabPath = doc.active !== null && tabPaths.includes(doc.active) ? doc.active : null;
  useEffect(() => {
    const api = bridge?.session;
    if (!api || !projectIdForTabs || restoringTabs.current) return undefined;
    const tabs = tabsKey === '' ? [] : tabsKey.split('\n');
    const timer = setTimeout(
      () => void api.saveTabs({ projectId: projectIdForTabs, tabs, active: activeTabPath }),
      300,
    );
    return () => clearTimeout(timer);
  }, [bridge, projectIdForTabs, tabsKey, activeTabPath]);

  const layoutKey = JSON.stringify(persistedLayout(layout));
  useEffect(() => {
    const api = bridge?.session;
    if (!api || !layoutReady.current) return undefined;
    const timer = setTimeout(() => void api.saveLayout(JSON.parse(layoutKey)), 300);
    return () => clearTimeout(timer);
  }, [bridge, layoutKey]);
  // --- end S13.4 ---

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
        menuItems={menuItems}
      />
      <div
        className="workbench-middle"
        style={
          {
            '--files-width': `${layout.filesWidth}px`,
            '--editor-grow': layout.editorShare,
            '--preview-grow': 1 - layout.editorShare,
          } as CSSProperties
        }
      >
        <Rail
          onShowHistory={project && bridge?.history ? () => setHistoryFor({ relPath: doc.active }) : undefined}
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
          extraMenuItems={extraMenuItems}
        />
        {!narrow && visible.files && (
          <Splitter
            label={t('layout.resizeFiles')}
            testId="splitter-files"
            value={layout.filesWidth}
            aria={{
              now: layout.filesWidth,
              min: FILES_WIDTH.min,
              max: FILES_WIDTH.max,
              text: `${layout.filesWidth}px`,
            }}
            step={16}
            dragValue={(start, dx) => start + dx}
            onChange={(width) => dispatchLayout({ type: 'resizeFiles', width })}
          />
        )}
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
          onShowHistory={bridge?.history ? (relPath) => setHistoryFor({ relPath }) : undefined}
          welcome={
            <WelcomeScreen
              onCreate={bridge?.createProject ? () => setWizardOpen(true) : undefined}
              onOpenFolder={bridge ? () => void openFolder() : undefined}
              recent={recentProjects}
              onOpenRecent={(opened) => void adoptProject(opened)}
            />
          }
        />
        {!narrow && (
          <Splitter
            label={t('layout.resizeEditor')}
            testId="splitter-editor"
            value={layout.editorShare}
            aria={{
              now: Math.round(layout.editorShare * 100),
              min: EDITOR_SHARE.min * 100,
              max: EDITOR_SHARE.max * 100,
              text: `${Math.round(layout.editorShare * 100)}%`,
            }}
            step={0.05}
            dragValue={(start, dx) => {
              const editor = document.querySelector('[data-testid="region-editor"]')?.getBoundingClientRect();
              const preview = document.querySelector('[data-testid="region-preview"]')?.getBoundingClientRect();
              const total = (editor?.width ?? 0) + (preview?.width ?? 0);
              return total > 0 ? start + dx / total : start;
            }}
            onChange={(share) => dispatchLayout({ type: 'resizeEditor', share })}
          />
        )}
        {/* S04.3 isolated preview (hidden under the narrow-layout files overlay so the native view cannot cover it);
            S10.5: a failed save shows "preview not updated" — refreshes come only from confirmed writes in main. */}
        <PreviewPane
          hidden={!visible.preview}
          covered={
            (narrow && visible.files) || wizardOpen || historyFor !== null || aboutOpen.open || glossaryFor !== null
          }
          projectId={project?.projectId ?? null}
          saveFailed={doc.tabs.some((tab) => saveStatus(tab.save) === 'failed')}
          autoStartProjectId={autoPreview}
          onRenamePage={renamePage}
        />
      </div>
      {/* S23: walkthrough strip / final task card (in the layout flow: never covers the editor or the preview) */}
      <WalkthroughPanel
        view={walkthrough.view}
        onNext={walkthrough.next}
        onBack={walkthrough.back}
        onClose={walkthrough.close}
        onStartTask={walkthrough.startTask}
        onCloseTask={walkthrough.closeTask}
        onTerm={(term) => setGlossaryFor({ term })}
      />
      {/* S17.1: problems panel in the status strip (never opens or takes focus by itself) */}
      <ProblemsPanel
        open={visible.problemsPanel}
        onToggle={() => dispatchLayout({ type: 'toggleProblems' })}
        projectOpen={project !== null}
        view={problemsView}
        onClearResolved={runtimeProblems.clearResolved}
        renderDetails={(record) => (
          <ProblemDetails
            record={record}
            uriOf={uriOfFile}
            onGoTo={goTo}
            onFix={problemFix.apply}
            fixBusy={problemFix.fix?.phase === 'applying' || problemFix.fix?.phase === 'undoing'}
          />
        )}
        fixCard={
          problemFix.fix && (
            <FixCard fix={problemFix.fix} serial={problemFix.serial} actions={problemFix} onGoTo={goTo} />
          )
        }
      />
      {/* S13.1: the settings file was unusable and was backed up */}
      {settingsNotice && <SettingsNotice snapshot={settingsNotice} onDismiss={() => setSettingsNotice(null)} />}
      {entryNotice && <EntryNotice state={entryNotice} onDismiss={() => setEntryNotice(null)} />}
      {restoredFrom && project?.rootPath === restoredFrom && (
        <SessionNotice rootPath={restoredFrom} onDismiss={() => setRestoredFrom(null)} />
      )}
      {/* S13.5: what would break on the other system (report only, nothing is renamed) */}
      <TransferNotice api={bridge?.portability} projectId={project?.projectId ?? null} />
      {/* S12: crash-recovery prompt and journal health */}
      <RecoveryDialog
        bridge={bridge}
        health={journals.health}
        onProjectOpened={adoptProject}
        onRestore={restoreRecovered}
        onCleared={rejournal}
      />
      {/* S21.3/S21.4: local history */}
      {historyFor && project && bridge?.history && (
        <HistoryDialog
          api={bridge.history}
          project={project}
          initialRelPath={historyFor.relPath}
          currentText={historyCurrentText}
          onRestore={restoreVersion}
          onRestoredDeleted={(relPath) => void openFile(relPath)}
          onClose={() => setHistoryFor(null)}
        />
      )}
      {/* S23.4: terminology glossary */}
      {glossaryFor && <GlossaryDialog initialTerm={glossaryFor.term} onClose={() => setGlossaryFor(null)} />}
      {/* S20.2: create-project wizard */}
      {wizardOpen && bridge?.createProject && (
        <CreateProjectDialog
          api={bridge.createProject}
          onCreated={(created) => void projectCreated(created)}
          onCancel={() => setWizardOpen(false)}
        />
      )}
      {aboutOpen.open && <AboutDialog onClose={aboutOpen.close} />}
    </div>
  );
}
