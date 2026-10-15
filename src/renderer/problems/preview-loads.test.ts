import { describe, expect, it } from 'vitest';
import { LOAD_SETTLE_MS, PreviewLoadCounter, type PreviewLoads } from './usePreviewLoads';

function counter() {
  const seen: PreviewLoads[] = [];
  const pending: { callback: () => void; ms: number }[] = [];
  const c = new PreviewLoadCounter((loads) => seen.push(loads), {
    set: (callback, ms) => {
      const entry = { callback, ms };
      pending.push(entry);
      return entry;
    },
    clear: (handle) => {
      const i = pending.indexOf(handle as (typeof pending)[number]);
      if (i >= 0) pending.splice(i, 1);
    },
  });
  const settle = () => pending.splice(0).forEach((p) => p.callback());
  return { c, seen, pending, settle };
}

describe('preview loads (S22.5)', () => {
  it('a load counts as completed a moment after it reached running, numbered by when it started', () => {
    const { c, seen, pending, settle } = counter();
    c.status('starting');
    expect(seen.at(-1)).toEqual({ started: 1, completed: 0 });
    c.status('running');
    expect(pending[0]?.ms).toBe(LOAD_SETTLE_MS);
    expect(seen.at(-1)).toEqual({ started: 1, completed: 0 });
    settle();
    expect(seen.at(-1)).toEqual({ started: 1, completed: 1 });
    c.status('running'); // a repeated status is not another load
    expect(pending).toHaveLength(0);
  });

  it('a refresh that starts before the previous load settled supersedes it; a failed load never completes', () => {
    const { c, seen, settle } = counter();
    c.status('starting');
    c.status('running');
    c.status('refreshing'); // cancels the pending completion of load 1
    c.status('running');
    settle();
    expect(seen.at(-1)).toEqual({ started: 2, completed: 2 });
    c.status('refreshing');
    c.status('failed');
    settle();
    expect(seen.at(-1)).toEqual({ started: 3, completed: 2 });
  });
});
