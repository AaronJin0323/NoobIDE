import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { NoobideApi, OpenedProject } from '../../shared/ipc/contract';
import type { ProblemRecord } from '../../shared/problem';
import { DEFAULT_WALKTHROUGH, type WalkthroughState, type WalkthroughStepId } from '../../shared/walkthrough';
import type { SavedFileEvents } from '../workbench/saved-file-events';
import {
  STEP_FILES,
  TASK_FILES,
  fileStepDone,
  misspelledNameReported,
  roleFilesOpened,
  taskDone,
  taskSignature,
} from './detect';
import { INITIAL_MODEL, panelView, walkthroughReducer, type ModelState, type PanelView } from './walkthrough-model';

export interface WalkthroughInputs {
  readonly bridge: NoobideApi | undefined;
  readonly project: OpenedProject | null;
  /** Relative paths of the open tabs. */
  readonly openTabs: readonly string[];
  /** Static and runtime problems of the open project. */
  readonly problems: readonly ProblemRecord[];
  /** Confirmed writes (S10.5): detection reads the file from disk after each one. */
  readonly savedFiles: SavedFileEvents;
}

export interface WalkthroughHandle {
  readonly view: PanelView;
  readonly state: WalkthroughState;
  open(): void;
  next(): void;
  back(): void;
  close(): void;
  startTask(): void;
  closeTask(): void;
  /** The wizard created a project: a walkthrough that never ran starts at "meet the files". */
  projectCreated(): void;
  /** A local-history restore finished (the "recover" step). */
  historyRestored(): void;
}

/**
 * The walkthrough engine wired to the workbench (S23.1). Loads the stored progress once, saves every change, and
 * detects the current step's completion from real state: the open project and tabs, the problems list, the files on
 * disk after each confirmed save, a finished history restore, and a new app run for the "reopen" step.
 */
export function useWalkthrough({
  bridge,
  project,
  openTabs,
  problems,
  savedFiles,
}: WalkthroughInputs): WalkthroughHandle {
  const [model, dispatch] = useReducer(walkthroughReducer, INITIAL_MODEL);
  const modelRef = useRef<ModelState>(model);
  modelRef.current = model;
  const problemsRef = useRef(problems);
  problemsRef.current = problems;
  const projectRef = useRef(project);
  projectRef.current = project;
  /** Stored as "active on the reopen step" when this run started: the app was closed and opened again. */
  const reopenedRun = useRef(false);
  const api = bridge?.walkthrough;

  // Load once.
  useEffect(() => {
    let cancelled = false;
    if (!api) {
      dispatch({ type: 'loaded', state: DEFAULT_WALKTHROUGH });
      return undefined;
    }
    void api.get().then((result) => {
      if (cancelled) return;
      const state = result.ok ? result.value : DEFAULT_WALKTHROUGH;
      reopenedRun.current = state.status === 'active' && state.step === 'reopen';
      dispatch({ type: 'loaded', state });
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Save every change after the load.
  const saved = useRef<string | null>(null);
  useEffect(() => {
    if (!model.loaded) return;
    const json = JSON.stringify(model.value);
    if (saved.current === null) {
      saved.current = json; // what was just loaded
      return;
    }
    if (json === saved.current) return;
    saved.current = json;
    void api?.save(model.value);
  }, [api, model]);

  const state = model.value;
  const active = model.loaded && state.status === 'active';
  const step = state.step;
  const projectId = project?.projectId ?? null;

  const readText = useCallback(
    async (relPath: string): Promise<string | null> => {
      const current = projectRef.current;
      if (!bridge || !current) return null;
      const result = await bridge.workspace.readFile({ projectId: current.projectId, relPath });
      if (result.ok) return result.value.text;
      return result.code === 'not-found' ? '' : null;
    },
    [bridge],
  );

  // ── Detection from state ──
  const detect = (id: WalkthroughStepId) => dispatch({ type: 'detected', step: id });
  useEffect(() => {
    if (active && step === 'create' && projectId) detect('create');
  }, [active, step, projectId]);
  const tabsKey = openTabs.join('\n');
  useEffect(() => {
    if (active && step === 'files' && roleFilesOpened(tabsKey.split('\n'))) detect('files');
  }, [active, step, tabsKey]);
  useEffect(() => {
    if (active && step === 'error' && misspelledNameReported(problems)) detect('error');
  }, [active, step, problems]);
  useEffect(() => {
    if (active && step === 'reopen' && projectId && reopenedRun.current) detect('reopen');
  }, [active, step, projectId]);

  // ── Baselines: what a file step (or the final task) starts from, read from disk ──
  const needsBaseline = active && STEP_FILES[step] !== undefined && state.baseline === null && projectId !== null;
  useEffect(() => {
    const watched = STEP_FILES[step];
    if (!needsBaseline || !watched) return undefined;
    let cancelled = false;
    void readText(watched.file).then((text) => {
      if (!cancelled && text !== null) dispatch({ type: 'baseline', step, baseline: watched.signature(text) });
    });
    return () => {
      cancelled = true;
    };
  }, [needsBaseline, step, projectId, readText]);

  const readTask = useCallback(async () => {
    const [html, css] = await Promise.all(TASK_FILES.map((file) => readText(file)));
    return html === null || css === null || html === undefined || css === undefined ? null : taskSignature(html, css);
  }, [readText]);
  const needsTaskBaseline =
    model.loaded && state.task === 'active' && state.taskBaseline === null && projectId !== null;
  useEffect(() => {
    if (!needsTaskBaseline) return undefined;
    let cancelled = false;
    void readTask().then((signature) => {
      if (!cancelled && signature !== null) dispatch({ type: 'taskBaseline', baseline: signature });
    });
    return () => {
      cancelled = true;
    };
  }, [needsTaskBaseline, projectId, readTask]);

  // ── After each confirmed save: compare the file on disk with the baseline ──
  useEffect(
    () =>
      savedFiles.subscribe(({ relPath }) => {
        const { loaded, value } = modelRef.current;
        if (!loaded) return;
        const watched = STEP_FILES[value.step];
        if (value.status === 'active' && watched?.file === relPath && value.baseline !== null) {
          const { step: id, baseline } = value;
          void readText(relPath).then((text) => {
            if (text === null) return;
            const now = modelRef.current.value;
            if (now.step !== id || now.baseline !== baseline) return;
            if (fileStepDone(id, baseline, watched.signature(text), problemsRef.current)) detect(id);
          });
        }
        if (
          value.task === 'active' &&
          value.taskBaseline !== null &&
          (TASK_FILES as readonly string[]).includes(relPath)
        ) {
          const baseline = value.taskBaseline;
          void readTask().then((signature) => {
            if (
              signature !== null &&
              modelRef.current.value.taskBaseline === baseline &&
              taskDone(baseline, signature)
            ) {
              dispatch({ type: 'taskDone' });
            }
          });
        }
      }),
    [savedFiles, readText, readTask],
  );

  return {
    view: panelView(model),
    state,
    open: () => dispatch({ type: 'open' }),
    next: () => dispatch({ type: 'next' }),
    back: () => dispatch({ type: 'back' }),
    close: () => dispatch({ type: 'close' }),
    startTask: () => dispatch({ type: 'taskOpen' }),
    closeTask: () => dispatch({ type: 'taskClose' }),
    projectCreated: () => dispatch({ type: 'projectCreated' }),
    historyRestored: () => {
      const { value } = modelRef.current;
      if (value.status === 'active' && value.step === 'restore') detect('restore');
    },
  };
}
