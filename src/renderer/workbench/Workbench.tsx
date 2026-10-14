import { useCallback, useEffect, useReducer, useRef } from 'react';
import { isMac } from '../../platform/labels';
import { useMediaQuery } from '../theme/useMediaQuery';
import { TopBar } from './TopBar';
import { Rail } from './Rail';
import { FilesPanel } from './FilesPanel';
import { EditorPane } from './EditorPane';
import { PreviewPane } from './PreviewPane';
import { ProblemsPanel } from './ProblemsPanel';
import { INITIAL_LAYOUT, NARROW_QUERY, layoutReducer, visibleRegions } from './layout';
import { INITIAL_DOCUMENT_STATE, documentReducer, saveState } from './document-state';
// S12: crash-recovery journal
import { useJournal } from '../recovery/useJournal';
import { newBufferId } from '../recovery/journal-scheduler';
import { RecoveryDialog, type RestoreOutcome } from '../recovery/RecoveryDialog';
import type { OpenedProject } from '../../shared/ipc/contract';
import type { RecoveredEntry } from '../../shared/ipc/recovery-contract';

/**
 * The five workbench regions of PLAN §3 in the 2026-10-14 prototype layout (S30.3), now backed by real files
 * (S03.3, S03.4): open a folder, open a file into Monaco, save with Ctrl/Cmd+S through the typed bridge.
 * One file at a time until tabs (S09); autosave and the full save pipeline arrive in S10.
 */
export function Workbench() {
  const bridge = window.noobide;
  const platform = bridge?.platform ?? 'other';
  const [layout, dispatchLayout] = useReducer(layoutReducer, INITIAL_LAYOUT);
  const [doc, dispatch] = useReducer(documentReducer, INITIAL_DOCUMENT_STATE);
  const narrow = useMediaQuery(NARROW_QUERY);
  const visible = visibleRegions(layout, narrow);

  // Async handlers read the latest state and text without being re-created on every keystroke.
  const docRef = useRef(doc);
  docRef.current = doc;
  const textRef = useRef('');
  // Edit and save revisions are counted synchronously with each change, not read from the last render: the text
  // a save writes and the revision it records must always match, or a save could skip or mislabel the newest edit.
  const editsRef = useRef({ revision: 0, saved: 0 });
  const unsaved = () => docRef.current.doc !== null && editsRef.current.revision !== editsRef.current.saved;
  const savingRef = useRef<Promise<boolean> | null>(null);
  // S12: unsaved buffers are journaled to app data until saved (independent of undo, autosave and history).
  const { scheduler: journal, health: journalHealth } = useJournal(bridge);

  const save = useCallback(async (): Promise<boolean> => {
    const current = docRef.current;
    if (!bridge || !current.project || !current.doc) return true;
    if (savingRef.current) await savingRef.current;
    if (!unsaved()) return true;
    const revision = editsRef.current.revision;
    const request = {
      projectId: current.project.projectId,
      relPath: current.doc.relPath,
      text: textRef.current,
      bom: current.doc.content.bom,
    };
    dispatch({ type: 'saveStarted' });
    const pending = bridge.workspace.writeFile(request).then((result) => {
      if (result.ok) {
        editsRef.current.saved = Math.max(editsRef.current.saved, revision);
        journal.saved(revision); // S12
        dispatch({ type: 'saveSucceeded', revision });
      } else dispatch({ type: 'saveFailed', code: result.code, message: result.message });
      return result.ok;
    });
    savingRef.current = pending;
    try {
      return await pending;
    } finally {
      savingRef.current = null;
    }
  }, [bridge, journal]);

  /** Never drops edits: unsaved text is saved first, and a failed save cancels the switch. */
  const saveBeforeLeaving = useCallback(async () => !unsaved() || (await save()), [save]);

  const openFolder = useCallback(async () => {
    if (!bridge || !(await saveBeforeLeaving())) return;
    const result = await bridge.workspace.openFolder();
    if (!result.ok) dispatch({ type: 'projectOpenFailed' });
    else if (result.value) {
      editsRef.current = { revision: 0, saved: 0 };
      journal.begin(null); // S12
      dispatch({ type: 'projectOpened', project: result.value });
    }
  }, [bridge, journal, saveBeforeLeaving]);

  const openFile = useCallback(
    async (relPath: string) => {
      const project = docRef.current.project;
      if (!bridge || !project || docRef.current.doc?.relPath === relPath) return;
      if (!(await saveBeforeLeaving())) return;
      const result = await bridge.workspace.readFile({ projectId: project.projectId, relPath });
      if (result.ok) {
        textRef.current = result.value.text;
        editsRef.current = { revision: 0, saved: 0 };
        // S12: a fresh buffer id per load, so this buffer never overwrites another run's crash copy.
        const { bom } = result.value;
        journal.begin({ projectId: project.projectId, relPath, bufferId: newBufferId(), bom, baseRevision: 0 });
        dispatch({ type: 'docLoaded', relPath, content: result.value });
      } else {
        editsRef.current = { revision: 0, saved: 0 };
        journal.begin(null); // S12
        dispatch({ type: 'docFailed', relPath, code: result.code });
      }
    },
    [bridge, journal, saveBeforeLeaving],
  );

  // --- S12: restore after an abnormal termination (RecoveryDialog) ---
  const adoptProject = useCallback(
    async (project: OpenedProject) => {
      if (!(await saveBeforeLeaving())) return false;
      editsRef.current = { revision: 0, saved: 0 };
      journal.begin(null);
      dispatch({ type: 'projectOpened', project });
      return true;
    },
    [journal, saveBeforeLeaving],
  );

  /** Opens the file with the recovered text as unsaved edits; it reaches the disk only when the user saves. */
  const restoreRecovered = useCallback(
    async (project: OpenedProject, entry: RecoveredEntry): Promise<RestoreOutcome> => {
      if (!entry.disk || docRef.current.project?.projectId !== project.projectId) return 'failed';
      // Never save on the user's behalf here: unsaved edits (e.g. a copy restored a moment ago) stay unsaved until
      // the user saves them; the dialog asks for that first.
      if (savingRef.current) await savingRef.current;
      if (unsaved()) return 'save-first';
      textRef.current = entry.text;
      editsRef.current = { revision: 1, saved: 0 };
      // Continue the crashed buffer's journal record so the first save removes it (journal revision = entry's).
      const { relPath, bufferId, bom } = entry;
      journal.begin({ projectId: project.projectId, relPath, bufferId, bom, baseRevision: entry.revision - 1 });
      dispatch({ type: 'docLoaded', relPath, content: { ...entry.disk, text: entry.text, bom } });
      dispatch({ type: 'edited' });
      return 'restored';
    },
    [journal],
  );

  /** The journal was cleared: unsaved edits still open in the editor are journaled again right away. */
  const rejournal = useCallback(() => {
    if (unsaved()) journal.resend(editsRef.current.revision, () => textRef.current);
  }, [journal]);
  // --- end S12 ---

  const onChange = useCallback(
    (text: string) => {
      textRef.current = text;
      editsRef.current.revision += 1;
      journal.edited(editsRef.current.revision, () => textRef.current); // S12
      dispatch({ type: 'edited' });
    },
    [journal],
  );

  // Ctrl+S / ⌘S also works when focus is outside the editor (Monaco handles it while the editor is focused).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = isMac(platform) ? event.metaKey : event.ctrlKey;
      if (modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [platform, save]);

  const project = doc.project;
  return (
    <div className={narrow ? 'workbench narrow' : 'workbench'}>
      <TopBar
        platform={platform}
        project={project}
        save={saveState(doc)}
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
          activeRelPath={doc.doc?.relPath ?? null}
          openFailed={doc.openFailed}
          onOpenFolder={bridge ? () => void openFolder() : undefined}
          onOpenFile={(relPath) => void openFile(relPath)}
        />
        <EditorPane hidden={!visible.editor} state={doc} onChange={onChange} onSave={() => void save()} />
        {/* S04.3: isolated preview; hidden under the narrow-layout files overlay so the native view cannot cover it. */}
        <PreviewPane
          hidden={!visible.preview}
          covered={narrow && visible.files}
          projectId={project?.projectId ?? null}
        />
      </div>
      <ProblemsPanel open={visible.problemsPanel} onToggle={() => dispatchLayout({ type: 'toggleProblems' })} />
      {/* S12: crash-recovery prompt and journal health */}
      <RecoveryDialog
        bridge={bridge}
        health={journalHealth}
        onProjectOpened={adoptProject}
        onRestore={restoreRecovered}
        onCleared={rejournal}
      />
    </div>
  );
}
