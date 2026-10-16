import { describe, expect, it } from 'vitest';
import { createTypingReporter } from './typing-reporter';

/** S14.2: editor keystrokes reach main throttled, and the last keystroke of a burst is always reported. */

function harness(intervalMs = 150) {
  let now = 1_000;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const reports: number[] = [];
  const reporter = createTypingReporter(() => reports.push(now), intervalMs, {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
  });
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.fn();
    }
    now = until;
  };
  return { reporter, reports, advance, pending: () => timers.length };
}

describe('createTypingReporter', () => {
  it('reports the first keystroke at once', () => {
    const h = harness();
    h.reporter.key();
    expect(h.reports).toEqual([1_000]);
    expect(h.pending()).toBe(0);
  });

  it('throttles a burst to one report per interval and still reports its last keystroke', () => {
    const h = harness();
    h.reporter.key(); // 1000: reported
    h.advance(50);
    h.reporter.key(); // 1050: covered by the trailing report at 1150
    h.advance(50);
    h.reporter.key(); // 1100: same trailing report
    expect(h.reports).toEqual([1_000]);
    h.advance(100);
    expect(h.reports).toEqual([1_000, 1_150]);
    h.advance(1_000);
    expect(h.reports).toEqual([1_000, 1_150]);
  });

  it('keys 100 ms apart: main never hears less recently than one interval before the last key', () => {
    const h = harness();
    const keys: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      keys.push(1_000 + i * 100);
      h.reporter.key();
      h.advance(100);
    }
    h.advance(1_000);
    const lastKey = keys[keys.length - 1]!;
    const lastReport = h.reports[h.reports.length - 1]!;
    expect(lastReport).toBeGreaterThanOrEqual(lastKey);
    expect(lastReport - lastKey).toBeLessThanOrEqual(150);
    for (let i = 1; i < h.reports.length; i += 1) expect(h.reports[i]! - h.reports[i - 1]!).toBeGreaterThanOrEqual(150);
  });

  it('dispose drops a pending trailing report', () => {
    const h = harness();
    h.reporter.key();
    h.advance(10);
    h.reporter.key();
    h.reporter.dispose();
    h.advance(1_000);
    expect(h.reports).toEqual([1_000]);
  });
});
