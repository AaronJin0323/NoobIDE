import { describe, expect, it } from 'vitest';
import type { PreviewLogEntry, PreviewStatus } from '../../shared/ipc/preview-contract';
import {
  EMPTY_LOG,
  MAX_VISIBLE_LOG_ENTRIES,
  STOPPED,
  actionsFor,
  appendLogBatch,
  clearLog,
  nextGeneration,
  olderCount,
  visibleLog,
  previewNotUpdated,
  stageMessageKey,
  stateLabelKey,
  viewVisible,
} from './preview-model';

const ID = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';
const status = (state: PreviewStatus['state'], failure?: PreviewStatus['failure']): PreviewStatus => ({
  state,
  projectId: state === 'stopped' ? null : ID,
  ...(failure ? { failure } : {}),
});
const entry = (n: number): PreviewLogEntry => ({ source: 'console', level: 'info', message: `m${n}`, at: n });

describe('preview pane model (S04.3, S05.2, S05.3)', () => {
  it('has a label for every state', () => {
    for (const s of ['stopped', 'starting', 'running', 'refreshing', 'unresponsive', 'failed'] as const) {
      expect(stateLabelKey(s)).toMatch(/^preview\./);
    }
  });

  it('offers Stop in every live state and above all when unresponsive', () => {
    expect(actionsFor(status('unresponsive'), true)).toEqual({ start: false, stop: true, reload: false });
    expect(actionsFor(status('starting'), true)).toEqual({ start: false, stop: true, reload: false });
    expect(actionsFor(status('running'), true)).toEqual({ start: false, stop: true, reload: true });
    expect(actionsFor(STOPPED, true)).toEqual({ start: true, stop: false, reload: false });
    expect(actionsFor(STOPPED, false)).toEqual({ start: false, stop: false, reload: false });
    expect(actionsFor(status('failed', 'crashed'), true)).toEqual({ start: true, stop: true, reload: false });
    expect(actionsFor(status('failed', 'load-failed'), true)).toEqual({ start: true, stop: true, reload: true });
  });

  it('hides the native view while a message must be readable', () => {
    expect(viewVisible(status('running'), true)).toBe(true);
    expect(viewVisible(status('running'), false)).toBe(false);
    expect(viewVisible(status('unresponsive'), true)).toBe(false);
    expect(viewVisible(STOPPED, true)).toBe(false);
    expect(stageMessageKey(status('unresponsive'), true)).toBe('preview.unresponsiveDetail');
    expect(stageMessageKey(STOPPED, true)).toBe('preview.startHint');
    expect(stageMessageKey(STOPPED, false)).toBe('preview.hint');
  });

  it('says "preview not updated" while a save has failed and a page is shown (S10.5)', () => {
    expect(previewNotUpdated(status('running'), true)).toBe(true);
    expect(previewNotUpdated(status('refreshing'), true)).toBe(true);
    expect(previewNotUpdated(status('running'), false)).toBe(false);
    expect(previewNotUpdated(STOPPED, true)).toBe(false);
    expect(previewNotUpdated(status('unresponsive'), true)).toBe(false);
  });

  it('keeps the newest log entries and sums dropped counts', () => {
    let view = appendLogBatch(EMPTY_LOG, [entry(1), entry(2)], 0);
    view = appendLogBatch(view, [], 500);
    view = appendLogBatch(
      view,
      Array.from({ length: MAX_VISIBLE_LOG_ENTRIES }, (_, i) => entry(i + 3)),
      7,
    );
    expect(view.entries).toHaveLength(MAX_VISIBLE_LOG_ENTRIES);
    expect(view.entries[0]?.message).toBe('m3');
    expect(view.dropped).toBe(507);
  });
});

describe('console view model (S17.3)', () => {
  const line = (level: PreviewLogEntry['level'], message: string): PreviewLogEntry => ({
    source: 'console',
    level,
    message,
    at: 1,
  });

  it('attributes lines to the page load they came from; a refresh starts a new one', () => {
    let view = appendLogBatch(nextGeneration(EMPTY_LOG), [line('info', 'first load')], 0);
    view = nextGeneration(view);
    view = appendLogBatch(view, [line('error', 'second load')], 0);
    expect(view.entries.map((e) => `${e.generation}:${e.message}`)).toEqual(['1:first load', '2:second load']);
    expect(visibleLog(view, 'all', false).map((e) => e.message)).toEqual(['second load']);
    expect(visibleLog(view, 'all', true).map((e) => e.message)).toEqual(['first load', 'second load']);
    expect(olderCount(view)).toBe(1);
  });

  it('filters by level (info includes debug)', () => {
    const view = appendLogBatch(
      EMPTY_LOG,
      [line('debug', 'd'), line('info', 'i'), line('warning', 'w'), line('error', 'e')],
      0,
    );
    expect(visibleLog(view, 'error', false).map((e) => e.message)).toEqual(['e']);
    expect(visibleLog(view, 'warning', false).map((e) => e.message)).toEqual(['w']);
    expect(visibleLog(view, 'info', false).map((e) => e.message)).toEqual(['d', 'i']);
    expect(visibleLog(view, 'all', false)).toHaveLength(4);
  });

  it('clear empties the list and the dropped counters but keeps the page load', () => {
    let view = nextGeneration(nextGeneration(EMPTY_LOG));
    view = appendLogBatch(view, [line('info', 'x')], 7, true);
    expect(clearLog(view)).toEqual({ entries: [], dropped: 0, throttled: false, generation: 2 });
  });

  it('stays capped across page loads', () => {
    let view = EMPTY_LOG;
    for (let g = 0; g < 3; g += 1) {
      view = nextGeneration(view);
      view = appendLogBatch(
        view,
        Array.from({ length: MAX_VISIBLE_LOG_ENTRIES }, (_, i) => entry(i)),
        0,
      );
    }
    expect(view.entries).toHaveLength(MAX_VISIBLE_LOG_ENTRIES);
    expect(olderCount(view)).toBe(0);
  });
});
