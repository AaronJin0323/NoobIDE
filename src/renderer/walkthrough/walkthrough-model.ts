/**
 * The walkthrough engine's state machine (S23.1). Pure: the hook (useWalkthrough) feeds it user actions and detected
 * completions and persists the result through the walkthrough IPC.
 *
 * - Steps are anchored (STEP_ANCHORS: the element the panel points at) and run inside the real project.
 * - Every step can be skipped (Next works whether or not the step was detected as done) and the whole walkthrough can
 *   be closed; Help → Walkthrough revisits it at the first step not done yet, and any step can be revisited with Back.
 * - A step is marked done only when the hook detects it (never by pressing Next), so the progress shows what the
 *   user really did.
 */
import {
  DEFAULT_WALKTHROUGH,
  WALKTHROUGH_STEPS,
  orderSteps,
  type WalkthroughState,
  type WalkthroughStepId,
} from '../../shared/walkthrough';

export type WalkthroughAction =
  | { readonly type: 'loaded'; readonly state: WalkthroughState }
  /** Help → Walkthrough (or the first project created with the wizard). */
  | { readonly type: 'open' }
  | { readonly type: 'next' }
  | { readonly type: 'back' }
  /** Close the walkthrough (skip it); it can be revisited from Help. */
  | { readonly type: 'close' }
  | { readonly type: 'detected'; readonly step: WalkthroughStepId }
  | { readonly type: 'baseline'; readonly step: WalkthroughStepId; readonly baseline: string }
  // S23.3 final task
  | { readonly type: 'taskOpen' }
  | { readonly type: 'taskBaseline'; readonly baseline: string }
  | { readonly type: 'taskDone' }
  | { readonly type: 'taskClose' };

export interface ModelState {
  /** False until the stored state arrived: nothing is shown or saved before. */
  readonly loaded: boolean;
  readonly value: WalkthroughState;
}

export const INITIAL_MODEL: ModelState = { loaded: false, value: DEFAULT_WALKTHROUGH };

export const stepIndex = (step: WalkthroughStepId) => WALKTHROUGH_STEPS.indexOf(step);
export const isLastStep = (step: WalkthroughStepId) => stepIndex(step) === WALKTHROUGH_STEPS.length - 1;

/** The first step not detected as done yet (the place a revisit starts), or null when all are done. */
export function firstOpenStep(state: WalkthroughState): WalkthroughStepId | null {
  return WALKTHROUGH_STEPS.find((id) => !state.completed.includes(id)) ?? null;
}

const moveTo = (state: WalkthroughState, step: WalkthroughStepId): WalkthroughState =>
  step === state.step ? state : { ...state, step, baseline: null };

export function walkthroughReducer(model: ModelState, action: WalkthroughAction): ModelState {
  if (action.type === 'loaded') return { loaded: true, value: action.state };
  if (!model.loaded) return model;
  const state = model.value;
  const next = reduce(state, action);
  return next === state ? model : { loaded: true, value: next };
}

function reduce(state: WalkthroughState, action: WalkthroughAction): WalkthroughState {
  switch (action.type) {
    case 'open': {
      const step = firstOpenStep(state) ?? WALKTHROUGH_STEPS[0];
      return { ...moveTo(state, step), status: 'active' };
    }
    case 'next': {
      if (state.status !== 'active') return state;
      if (isLastStep(state.step)) {
        // Finishing offers the unguided final task (S23.3) unless it was done already.
        return { ...state, status: 'finished', baseline: null, task: state.task === 'done' ? 'done' : 'not-started' };
      }
      return moveTo(state, WALKTHROUGH_STEPS[stepIndex(state.step) + 1] as WalkthroughStepId);
    }
    case 'back': {
      if (state.status !== 'active' || stepIndex(state.step) === 0) return state;
      return moveTo(state, WALKTHROUGH_STEPS[stepIndex(state.step) - 1] as WalkthroughStepId);
    }
    case 'close':
      return state.status === 'active' ? { ...state, status: 'closed', baseline: null } : state;
    case 'detected':
      if (state.completed.includes(action.step)) return state;
      return { ...state, completed: orderSteps([...state.completed, action.step]) };
    case 'baseline':
      return state.status === 'active' && state.step === action.step && state.baseline === null
        ? { ...state, baseline: action.baseline }
        : state;
    case 'taskOpen':
      return {
        ...state,
        status: state.status === 'active' ? 'finished' : state.status,
        task: 'active',
        taskBaseline: null,
      };
    case 'taskBaseline':
      return state.task === 'active' && state.taskBaseline === null
        ? { ...state, taskBaseline: action.baseline }
        : state;
    case 'taskDone':
      return state.task === 'active' ? { ...state, task: 'done' } : state;
    case 'taskClose':
      // Declining the offer, stopping the task or closing the "done" card: the card goes away (a finished
      // walkthrough becomes closed, so nothing is shown until Help opens it again).
      if (state.task === 'closed' && state.status !== 'finished') return state;
      return {
        ...state,
        task: state.task === 'done' ? 'done' : 'closed',
        taskBaseline: null,
        status: state.status === 'finished' ? 'closed' : state.status,
      };
    default:
      return state;
  }
}

/** What the panel shows. */
export type PanelView =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'step'; readonly step: WalkthroughStepId; readonly done: boolean; readonly index: number }
  | { readonly kind: 'task-offer' }
  | { readonly kind: 'task'; readonly done: boolean };

export function panelView(model: ModelState): PanelView {
  if (!model.loaded) return { kind: 'hidden' };
  const state = model.value;
  if (state.status === 'active') {
    return {
      kind: 'step',
      step: state.step,
      done: state.completed.includes(state.step),
      index: stepIndex(state.step),
    };
  }
  if (state.task === 'active') return { kind: 'task', done: false };
  if (state.status === 'finished' && state.task === 'done') return { kind: 'task', done: true };
  if (state.status === 'finished' && state.task === 'not-started') return { kind: 'task-offer' };
  return { kind: 'hidden' };
}

/**
 * The element each step points at (a CSS selector inside the workbench). The panel outlines it and "Show me" moves
 * focus to it; the step's text also says where it is in words, so the highlight is never the only cue.
 */
export const STEP_ANCHORS: Readonly<Record<WalkthroughStepId, string>> = {
  create: '[data-testid="welcome-create"]',
  files: '[data-testid="file-tree"]',
  heading: '[data-testid="file-tree"] [data-path="index.html"]',
  style: '[data-testid="file-tree"] [data-path="style.css"]',
  interaction: '[data-testid="file-tree"] [data-path="script.js"]',
  error: '[data-testid="problems-toggle"]',
  restore: '[data-testid="rail-history"]',
  reopen: '[data-testid="project-path"]',
};
