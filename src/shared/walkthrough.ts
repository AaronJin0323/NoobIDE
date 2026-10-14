/**
 * Onboarding walkthrough state (S23, PLAN §2). Pure TypeScript: main keeps it in app data (walkthrough.json, never
 * inside a project), the renderer drives it. The steps follow the PLAN §2 first-use journey; the final task (S23.3) is
 * a small unguided task offered after the last step.
 *
 * The state holds step ids, statuses and short "baseline" signatures of what a step started from (e.g. the heading
 * text when the heading step began) — never whole files. It is validated field by field on load: an invalid field
 * takes its default, so a damaged file can never break the app.
 */
export const WALKTHROUGH_VERSION = 1;

/** The PLAN §2 journey in order. */
export const WALKTHROUGH_STEPS = [
  'create',
  'files',
  'heading',
  'style',
  'interaction',
  'error',
  'restore',
  'reopen',
] as const;
export type WalkthroughStepId = (typeof WALKTHROUGH_STEPS)[number];

/**
 * `not-started`: never shown. `active`: the panel shows `step`. `closed`: the user closed (skipped) it; it can be
 * revisited from Help. `finished`: every step was reached; the final task may follow.
 */
export const WALKTHROUGH_STATUSES = ['not-started', 'active', 'closed', 'finished'] as const;
export type WalkthroughStatus = (typeof WALKTHROUGH_STATUSES)[number];

/** S23.3: the unguided task. `active`: the task card shows; `done`: completion was detected. */
export const FINAL_TASK_STATUSES = ['not-started', 'active', 'closed', 'done'] as const;
export type FinalTaskStatus = (typeof FINAL_TASK_STATUSES)[number];

/** Longest baseline signature kept (characters). Signatures are short summaries, never file contents. */
export const MAX_BASELINE_LENGTH = 4096;

export interface WalkthroughState {
  readonly version: typeof WALKTHROUGH_VERSION;
  readonly status: WalkthroughStatus;
  /** The step shown while active (the last one reached otherwise). */
  readonly step: WalkthroughStepId;
  /** Steps whose completion was detected, in the order of WALKTHROUGH_STEPS. */
  readonly completed: readonly WalkthroughStepId[];
  /** What the current step started from (see src/renderer/walkthrough/detect.ts), or null before it is captured. */
  readonly baseline: string | null;
  readonly task: FinalTaskStatus;
  /** What the final task started from, or null. */
  readonly taskBaseline: string | null;
}

export const DEFAULT_WALKTHROUGH: WalkthroughState = {
  version: WALKTHROUGH_VERSION,
  status: 'not-started',
  step: 'create',
  completed: [],
  baseline: null,
  task: 'not-started',
  taskBaseline: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const oneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === 'string' && (values as readonly string[]).includes(value);

export const isWalkthroughStep = oneOf(WALKTHROUGH_STEPS);
const isStatus = oneOf(WALKTHROUGH_STATUSES);
const isTaskStatus = oneOf(FINAL_TASK_STATUSES);
const isBaseline = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && value.length <= MAX_BASELINE_LENGTH);
const isCompleted = (value: unknown): value is WalkthroughStepId[] =>
  Array.isArray(value) &&
  value.length <= WALKTHROUGH_STEPS.length &&
  value.every(isWalkthroughStep) &&
  new Set(value).size === value.length;

/** Puts completed steps into journey order (and drops duplicates). */
export function orderSteps(steps: readonly WalkthroughStepId[]): WalkthroughStepId[] {
  return WALKTHROUGH_STEPS.filter((id) => steps.includes(id));
}

/**
 * Lenient load of a stored file: every invalid or missing field takes its default. A file from a newer NoobIDE or
 * not an object at all gives the defaults.
 */
export function loadWalkthroughState(raw: unknown): WalkthroughState {
  if (!isRecord(raw) || raw.version !== WALKTHROUGH_VERSION) return DEFAULT_WALKTHROUGH;
  const pick = <K extends keyof WalkthroughState>(key: K, valid: (value: unknown) => boolean): WalkthroughState[K] =>
    (valid(raw[key]) ? raw[key] : DEFAULT_WALKTHROUGH[key]) as WalkthroughState[K];
  return {
    version: WALKTHROUGH_VERSION,
    status: pick('status', isStatus),
    step: pick('step', isWalkthroughStep),
    completed: orderSteps(pick('completed', isCompleted)),
    baseline: pick('baseline', isBaseline),
    task: pick('task', isTaskStatus),
    taskBaseline: pick('taskBaseline', isBaseline),
  };
}

const KEYS = ['version', 'status', 'step', 'completed', 'baseline', 'task', 'taskBaseline'] as const;

/** Strict IPC check: exactly the known keys, each valid. Anything else is rejected (null). */
export function parseWalkthroughState(payload: unknown): WalkthroughState | null {
  if (!isRecord(payload)) return null;
  const keys = Object.keys(payload);
  if (keys.length !== KEYS.length || !KEYS.every((key) => Object.hasOwn(payload, key))) return null;
  const { version, status, step, completed, baseline, task, taskBaseline } = payload;
  if (
    version !== WALKTHROUGH_VERSION ||
    !isStatus(status) ||
    !isWalkthroughStep(step) ||
    !isCompleted(completed) ||
    !isBaseline(baseline) ||
    !isTaskStatus(task) ||
    !isBaseline(taskBaseline)
  ) {
    return null;
  }
  return { version, status, step, completed: orderSteps(completed), baseline, task, taskBaseline };
}
