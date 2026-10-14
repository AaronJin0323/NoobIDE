import { describe, expect, it } from 'vitest';
import type { PreviewLogEntry, PreviewStatus } from '../../shared/ipc/preview-contract';
import {
  EMPTY_LOG,
  MAX_VISIBLE_LOG_ENTRIES,
  STOPPED,
  actionsFor,
  appendLogBatch,
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
