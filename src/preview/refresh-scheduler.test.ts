import { describe, expect, it } from 'vitest';
import { RefreshScheduler } from './refresh-scheduler';

/** S14.2: automatic refresh after a successful save and a typing pause. */

function harness(quietMs = 400) {
  let now = 1_000;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  let refreshes = 0;
  const scheduler = new RefreshScheduler({
    quietMs,
    refresh: () => void (refreshes += 1),
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
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.fn();
    }
    now = end;
  };
  return { scheduler, advance, refreshes: () => refreshes, pendingTimers: () => timers.length };
}

describe('refresh scheduler (S14.2)', () => {
  it('a save after a typing pause refreshes at once', () => {
    const h = harness();
    h.scheduler.typing();
    h.advance(500);
    h.scheduler.saved();
    expect(h.refreshes()).toBe(1);
    expect(h.scheduler.waiting).toBe(false);
  });

  it('a save without any typing refreshes at once', () => {
    const h = harness();
    h.scheduler.saved();
    expect(h.refreshes()).toBe(1);
  });

  it('a save while the user is typing waits for the pause', () => {
    const h = harness();
    h.scheduler.typing();
    h.advance(100);
    h.scheduler.saved(); // autosave mid-typing
    expect(h.refreshes()).toBe(0);
    for (let i = 0; i < 10; i += 1) {
      h.advance(150);
      h.scheduler.typing(); // still typing
    }
    expect(h.refreshes()).toBe(0);
    h.advance(399);
    expect(h.refreshes()).toBe(0);
    h.advance(1);
    expect(h.refreshes()).toBe(1);
  });

  it('several saves during one burst of typing give one refresh', () => {
    const h = harness();
    h.scheduler.typing();
    h.scheduler.saved();
    h.advance(200);
    h.scheduler.typing();
    h.scheduler.saved();
    h.advance(1_000);
    expect(h.refreshes()).toBe(1);
  });

  it('typing alone never refreshes', () => {
    const h = harness();
    h.scheduler.typing();
    h.advance(5_000);
    expect(h.refreshes()).toBe(0);
    expect(h.pendingTimers()).toBe(0);
  });

  it('cancel drops a pending refresh (preview stopped or switched)', () => {
    const h = harness();
    h.scheduler.typing();
    h.scheduler.saved();
    h.scheduler.cancel();
    h.advance(5_000);
    expect(h.refreshes()).toBe(0);
  });
});
