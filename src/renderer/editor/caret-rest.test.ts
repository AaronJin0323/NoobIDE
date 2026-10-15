import { describe, expect, it } from 'vitest';
import { CARET_REST_AFTER_MS, CaretRest } from './caret-rest';

function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  return {
    setTimeout: (callback: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle: unknown) => void pending.delete(handle as number),
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now && pending.has(id)) {
          pending.delete(id);
          timer.callback();
        }
      }
    },
    get pending() {
      return pending.size;
    },
  };
}

describe('CaretRest', () => {
  it('blinks at first and turns solid after the pause (10 s by default)', () => {
    const timers = fakeTimers();
    const calls: boolean[] = [];
    const rest = new CaretRest({ setBlinking: (b) => calls.push(b), ...timers });
    expect(rest.isBlinking).toBe(true);
    timers.advance(CARET_REST_AFTER_MS - 1);
    expect(calls).toEqual([]);
    timers.advance(1);
    expect(calls).toEqual([false]);
    expect(rest.isBlinking).toBe(false);
  });

  it('activity restarts the pause and makes a resting caret blink again', () => {
    const timers = fakeTimers();
    const calls: boolean[] = [];
    const rest = new CaretRest({ setBlinking: (b) => calls.push(b), restAfterMs: 100, ...timers });
    timers.advance(90);
    rest.activity(); // still blinking: no option change, only a new pause
    timers.advance(90);
    expect(calls).toEqual([]);
    timers.advance(10);
    expect(calls).toEqual([false]);
    rest.activity();
    expect(calls).toEqual([false, true]);
    timers.advance(100);
    expect(calls).toEqual([false, true, false]);
  });

  it('does nothing after dispose and leaves no timer behind', () => {
    const timers = fakeTimers();
    const calls: boolean[] = [];
    const rest = new CaretRest({ setBlinking: (b) => calls.push(b), restAfterMs: 100, ...timers });
    rest.dispose();
    expect(timers.pending).toBe(0);
    rest.activity();
    timers.advance(1000);
    expect(calls).toEqual([]);
  });
});
