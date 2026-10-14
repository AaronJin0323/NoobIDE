import { describe, expect, it } from 'vitest';
import { DEFAULT_WALKTHROUGH, WALKTHROUGH_STEPS, type WalkthroughState } from '../../shared/walkthrough';
import {
  INITIAL_MODEL,
  STEP_ANCHORS,
  firstOpenStep,
  panelView,
  walkthroughReducer,
  type ModelState,
  type WalkthroughAction,
} from './walkthrough-model';

const run = (state: WalkthroughState, ...actions: WalkthroughAction[]): ModelState =>
  actions.reduce(walkthroughReducer, walkthroughReducer(INITIAL_MODEL, { type: 'loaded', state }));

describe('walkthrough engine (S23.1)', () => {
  it('does nothing and shows nothing until the stored state is loaded', () => {
    expect(walkthroughReducer(INITIAL_MODEL, { type: 'open' })).toBe(INITIAL_MODEL);
    expect(panelView(INITIAL_MODEL)).toEqual({ kind: 'hidden' });
    expect(panelView(run(DEFAULT_WALKTHROUGH))).toEqual({ kind: 'hidden' });
  });

  it('opens at the first step not done yet and walks the journey with Next and Back', () => {
    const opened = run({ ...DEFAULT_WALKTHROUGH, completed: ['create'] }, { type: 'open' });
    expect(panelView(opened)).toEqual({ kind: 'step', step: 'files', done: false, index: 1 });
    const two = run(opened.value, { type: 'next' }, { type: 'next' });
    expect(two.value.step).toBe('style');
    expect(run(two.value, { type: 'back' }).value.step).toBe('heading');
    expect(run({ ...DEFAULT_WALKTHROUGH, status: 'active' }, { type: 'back' }).value.step).toBe('create');
  });

  it('every step can be skipped: Next moves on without marking the step done', () => {
    const skipped = run({ ...DEFAULT_WALKTHROUGH, status: 'active', step: 'heading' }, { type: 'next' });
    expect(skipped.value.step).toBe('style');
    expect(skipped.value.completed).toEqual([]);
  });

  it('a step is done only when detected; detection is kept when the user moves around', () => {
    const state = run(
      { ...DEFAULT_WALKTHROUGH, status: 'active', step: 'heading' },
      { type: 'detected', step: 'heading' },
    );
    expect(panelView(state)).toMatchObject({ step: 'heading', done: true });
    const later = run(state.value, { type: 'next' }, { type: 'back' });
    expect(panelView(later)).toMatchObject({ step: 'heading', done: true });
  });

  it('the baseline belongs to the current step and is reset when the step changes', () => {
    const active = { ...DEFAULT_WALKTHROUGH, status: 'active' as const, step: 'heading' as const };
    const withBaseline = run(active, { type: 'baseline', step: 'heading', baseline: '你好，我是小雨' });
    expect(withBaseline.value.baseline).toBe('你好，我是小雨');
    // a late baseline for another step is ignored; a second one does not replace the first
    expect(run(withBaseline.value, { type: 'baseline', step: 'style', baseline: 'x' }).value.baseline).toBe(
      '你好，我是小雨',
    );
    expect(run(withBaseline.value, { type: 'baseline', step: 'heading', baseline: 'y' }).value.baseline).toBe(
      '你好，我是小雨',
    );
    expect(run(withBaseline.value, { type: 'next' }).value.baseline).toBeNull();
  });

  it('closing skips the walkthrough; Help opens it again where the user left off', () => {
    const closed = run(
      { ...DEFAULT_WALKTHROUGH, status: 'active', step: 'style', completed: ['create', 'files', 'heading'] },
      { type: 'close' },
    );
    expect(closed.value.status).toBe('closed');
    expect(panelView(closed)).toEqual({ kind: 'hidden' });
    const revisited = run(closed.value, { type: 'open' });
    expect(panelView(revisited)).toEqual({ kind: 'step', step: 'style', done: false, index: 3 });
  });

  it('a revisit after everything was done starts again from the first step', () => {
    const all = { ...DEFAULT_WALKTHROUGH, status: 'closed' as const, completed: [...WALKTHROUGH_STEPS] };
    expect(firstOpenStep(all)).toBeNull();
    expect(panelView(run(all, { type: 'open' }))).toEqual({ kind: 'step', step: 'create', done: true, index: 0 });
  });

  it('Next on the last step finishes and offers the final task', () => {
    const finished = run({ ...DEFAULT_WALKTHROUGH, status: 'active', step: 'reopen' }, { type: 'next' });
    expect(finished.value.status).toBe('finished');
    expect(panelView(finished)).toEqual({ kind: 'task-offer' });
  });

  it('every step has an anchor', () => {
    for (const step of WALKTHROUGH_STEPS) expect(STEP_ANCHORS[step]).toMatch(/^\[data-testid=/);
  });
});

describe('final task state (S23.3)', () => {
  const finished: WalkthroughState = { ...DEFAULT_WALKTHROUGH, status: 'finished', completed: [...WALKTHROUGH_STEPS] };

  it('starts, captures a baseline once, and is done only when detected', () => {
    const started = run(finished, { type: 'taskOpen' });
    expect(panelView(started)).toEqual({ kind: 'task', done: false });
    const based = run(started.value, { type: 'taskBaseline', baseline: 'a' }, { type: 'taskBaseline', baseline: 'b' });
    expect(based.value.taskBaseline).toBe('a');
    const done = run(based.value, { type: 'taskDone' });
    expect(panelView(done)).toEqual({ kind: 'task', done: true });
    const dismissed = run(done.value, { type: 'taskClose' });
    expect(dismissed.value).toMatchObject({ status: 'closed', task: 'done' });
    expect(panelView(dismissed)).toEqual({ kind: 'hidden' });
  });

  it('declining the offer or stopping the task hides the card; "done" is never set without detection', () => {
    expect(run(finished, { type: 'taskClose' }).value).toMatchObject({ status: 'closed', task: 'closed' });
    expect(run(finished, { type: 'taskDone' }).value.task).toBe('not-started');
    const stopped = run(finished, { type: 'taskOpen' }, { type: 'taskClose' });
    expect(stopped.value).toMatchObject({ task: 'closed', taskBaseline: null });
  });
});
