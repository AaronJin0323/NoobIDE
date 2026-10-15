import { describe, expect, it } from 'vitest';
import type { PreviewState } from '../shared/ipc/preview-contract';
import { INITIAL_MACHINE, isLive, transition, type PreviewMachine, type PreviewMachineEvent } from './state-machine';

/** S14.1: the preview state machine as a pure module. */

const run = (events: PreviewMachineEvent[], from: PreviewMachine = INITIAL_MACHINE): PreviewMachine =>
  events.reduce(transition, from);

const at = (state: PreviewState, extra: Partial<PreviewMachine> = {}): PreviewMachine => ({
  state,
  generation: 5,
  ...extra,
});

describe('preview state machine (S14.1)', () => {
  it('starts stopped at generation 0', () => {
    expect(INITIAL_MACHINE).toEqual({ state: 'stopped', generation: 0 });
  });

  it('runs the normal life: start → running → refresh → running → stop', () => {
    const states: string[] = [];
    let m = INITIAL_MACHINE;
    for (const e of [
      { type: 'start' },
      { type: 'navigate' }, // the initial loadURL: same page load
      { type: 'load-finished' },
      { type: 'refresh' },
      { type: 'navigate' }, // Chromium's navigation event of that refresh: same page load
      { type: 'load-finished' },
      { type: 'stop' },
    ] as PreviewMachineEvent[]) {
      m = transition(m, e);
      states.push(`${m.state}#${m.generation}`);
    }
    expect(states).toEqual([
      'starting#1',
      'starting#1',
      'running#1',
      'refreshing#2',
      'refreshing#2',
      'running#2',
      'stopped#2',
    ]);
  });

  it('the generation increases on every start, refresh and page-initiated navigation, never on stop', () => {
    const m = run([
      { type: 'start' },
      { type: 'load-finished' },
      { type: 'navigate' }, // a link click
      { type: 'load-finished' },
      { type: 'stop' },
      { type: 'start' },
    ]);
    expect(m).toEqual({ state: 'starting', generation: 3 });
  });

  it.each<[PreviewState, PreviewMachineEvent, PreviewState, string?]>([
    ['starting', { type: 'server-failed' }, 'failed', 'server-failed'],
    ['starting', { type: 'load-failed' }, 'failed', 'load-failed'],
    ['refreshing', { type: 'load-failed' }, 'failed', 'load-failed'],
    ['running', { type: 'load-failed' }, 'failed', 'load-failed'],
    ['running', { type: 'crashed' }, 'failed', 'crashed'],
    ['unresponsive', { type: 'crashed' }, 'failed', 'crashed'],
    ['starting', { type: 'unresponsive' }, 'unresponsive'],
    ['running', { type: 'unresponsive' }, 'unresponsive'],
    ['refreshing', { type: 'unresponsive' }, 'unresponsive'],
    ['failed', { type: 'start' }, 'starting'],
    ['unresponsive', { type: 'stop' }, 'stopped'],
    ['failed', { type: 'stop' }, 'stopped'],
  ])('%s + %o → %s', (from, event, to, failure) => {
    const next = transition(at(from), event);
    expect(next.state).toBe(to);
    expect(next.failure).toBe(failure);
  });

  it.each<[PreviewState, PreviewMachineEvent]>([
    ['stopped', { type: 'refresh' }],
    ['stopped', { type: 'load-finished' }],
    ['stopped', { type: 'crashed' }],
    ['stopped', { type: 'unresponsive' }],
    ['stopped', { type: 'stop' }],
    ['running', { type: 'server-failed' }],
    ['running', { type: 'load-finished' }],
    ['unresponsive', { type: 'refresh' }], // a hung page cannot reload itself: Stop
    ['unresponsive', { type: 'unresponsive' }],
    ['unresponsive', { type: 'load-failed' }],
    ['failed', { type: 'unresponsive' }],
    ['failed', { type: 'navigate' }],
    ['unresponsive', { type: 'navigate' }],
    ['failed', { type: 'responsive', loading: false }],
    ['running', { type: 'responsive', loading: false }],
  ])('ignores %s + %o', (from, event) => {
    const m = at(from);
    expect(transition(m, event)).toBe(m);
  });

  it('refresh is offered after a failed load, not after a crash', () => {
    expect(transition(at('failed', { failure: 'load-failed' }), { type: 'refresh' })).toEqual({
      state: 'refreshing',
      generation: 6,
    });
    const crashed = at('failed', { failure: 'crashed' });
    expect(transition(crashed, { type: 'refresh' })).toBe(crashed);
  });

  it('an unresponsive page that answers again returns to where it was, or to running once loaded', () => {
    const hungWhileRunning = run([{ type: 'unresponsive' }], at('running'));
    expect(transition(hungWhileRunning, { type: 'responsive', loading: true }).state).toBe('running');
    const hungWhileStarting = run([{ type: 'unresponsive' }], at('starting'));
    expect(transition(hungWhileStarting, { type: 'responsive', loading: true }).state).toBe('starting');
    expect(transition(hungWhileStarting, { type: 'responsive', loading: false }).state).toBe('running');
    // The generation is untouched by hangs.
    expect(transition(hungWhileStarting, { type: 'responsive', loading: false }).generation).toBe(5);
  });

  it('failure is only present in the failed state', () => {
    const failed = transition(at('starting'), { type: 'server-failed' });
    expect(transition(failed, { type: 'start' })).not.toHaveProperty('failure');
    expect(transition(failed, { type: 'stop' })).not.toHaveProperty('failure');
  });

  it('isLive covers the states with a view', () => {
    expect(
      (['stopped', 'starting', 'running', 'refreshing', 'unresponsive', 'failed'] as const).filter(isLive),
    ).toEqual(['starting', 'running', 'refreshing', 'unresponsive']);
  });
});
