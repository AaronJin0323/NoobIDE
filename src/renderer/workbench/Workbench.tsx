import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { isMac } from '../../platform/labels';
import type { FileContent, OpenedProject } from '../../shared/ipc/contract';
import { useMediaQuery } from '../theme/useMediaQuery';
import { TopBar } from './TopBar';
import { Rail } from './Rail';
import { FilesPanel } from './FilesPanel';
import { EditorPane, type SaveCopyNotice } from './EditorPane';
import { PreviewPane } from './PreviewPane';
import { ProblemsPanel } from './ProblemsPanel';
import { INITIAL_LAYOUT, NARROW_QUERY, layoutReducer, visibleRegions } from './layout';
import { INITIAL_DOCUMENT_STATE, activeSaveStatus, activeTab, cycleTab, documentReducer } from './document-state';
import { DocumentSaver, saveEvery } from './save-controller';
import { createSavedFileEvents } from './saved-file-events';
import { DEFAULT_FONT_SIZE, zoomFontSize } from './zoom';

const releaseModel = (uri: string) => void import('../editor/editor-models').then((m) => m.releaseModel(uri));
const releaseFileModels = () => void import('../editor/editor-models').then((m) => m.releaseFileModels());

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

  const saverOf = (relPath: string | null | undefined) => (relPath ? savers.current.get(relPath) : undefined);
  const relPathOfUri = (uri: string) => docRef.current.tabs.find((tab) => tab.uri === uri)?.relPath;

  const createSaver = useCallback(
    (project: OpenedProject, relPath: string, content: FileContent) => {
      const saver = new DocumentSaver({
        initialText: content.text,
        async write(text) {
          if (!bridge) return { ok: false, code: 'write-failed', message: 'no bridge' };
          const result = await bridge.workspace.writeFile({
            projectId: project.projectId,
            relPath,
            text,
            bom: content.bom,
          });
          return result.ok ? { ok: true } : { ok: false, code: result.code, message: result.message };
        },
        onState: (save) => dispatch({ type: 'saveState', relPath, save }),
      });
      saver.onSaved(({ revision }) => savedFiles.current.emit({ relPath, uri: content.uri, revision }));
      return saver;
    },
    [bridge],
  );

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
    for (const saver of savers.current.values()) saver.dispose();
    savers.current.clear();
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

  const closeTab = useCallback(async (relPath: string) => {
    const saver = saverOf(relPath);
    const tab = docRef.current.tabs.find((open) => open.relPath === relPath);
    if (!saver || !tab) return;
    // Never drops edits: unsaved text is written first; a failed write keeps the tab open with its banner.
    if (!(await saver.save())) {
      dispatch({ type: 'activate', relPath });
      return;
    }
    // Order matters: the saver goes before the model is discarded (cleared), so that change reaches no saver.
    saver.dispose();
    savers.current.delete(relPath);
    dispatch({ type: 'closed', relPath });
    releaseModel(tab.uri);
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
    if (relPath) saverOf(relPath)?.edit(text);
  }, []);
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
          onCloseDiscarding={bridge && closeRefused ? () => void bridge.app.closeDiscarding() : undefined}
        />
        <PreviewPane hidden={!visible.preview} />
      </div>
      <ProblemsPanel open={visible.problemsPanel} onToggle={() => dispatchLayout({ type: 'toggleProblems' })} />
    </div>
  );
}
