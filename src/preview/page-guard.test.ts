import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CONSOLE_LIMIT, LIMITER_SOURCE_URL, PAGE_GUARD_SOURCE, parseLimiterSummary } from './page-guard';

/** Runs the page guard in a fresh realm with a fake console and clock, like a new preview document. */
function realm() {
  const printed: { method: string; args: unknown[] }[] = [];
  const nativeLog = function log(...args: unknown[]) {
    printed.push({ method: 'log', args });
  };
  const nativeError = function error(...args: unknown[]) {
    printed.push({ method: 'error', args });
  };
  const nativeWarn = function warn(...args: unknown[]) {
    printed.push({ method: 'warn', args });
  };
  const nativeInfo = function info(...args: unknown[]) {
    printed.push({ method: 'info', args });
  };
  const nativeTime = function time() {};
  let now = 1_000_000;
  const timers: (() => void)[] = [];
  const context: Record<string, unknown> = {
    console: { log: nativeLog, error: nativeError, warn: nativeWarn, info: nativeInfo, time: nativeTime },
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    alert: () => {
      throw new Error('a dialog must never open');
    },
    print: () => {
      throw new Error('print must never open');
    },
  };
  context.globalThis = context;
  runInNewContext(
    `Date.now = () => globalThis.__now(); ${PAGE_GUARD_SOURCE}`,
    Object.assign(context, { __now: () => now }),
  );
  return {
    context,
    console: context.console as Record<'log' | 'error' | 'warn' | 'info' | 'time', (...a: unknown[]) => void>,
    printed,
    natives: { nativeLog, nativeError, nativeTime },
    advance: (ms: number) => {
      now += ms;
    },
    runTimers: () => timers.splice(0).forEach((t) => t()),
  };
}

describe('page guard: console rate limit (S05.7, decision 0016)', () => {
  it('hands out the native method under the limit, so Chromium keeps the caller’s file and line', () => {
    const r = realm();
    expect(r.console.log).toBe(r.natives.nativeLog);
    expect(r.console.error).toBe(r.natives.nativeError);
    r.console.log('hello', 1);
    expect(r.printed).toEqual([{ method: 'log', args: ['hello', 1] }]);
  });

  it('suppresses messages above the limit and reports the count once per window', () => {
    const r = realm();
    for (let i = 0; i < CONSOLE_LIMIT + 250; i += 1) r.console.log(i);
    expect(r.printed.filter((p) => p.method === 'log')).toHaveLength(CONSOLE_LIMIT);
    // Still inside the window: nothing reported yet; the next window starts with a summary.
    expect(r.printed.some((p) => p.method === 'warn')).toBe(false);
    r.advance(1_000);
    r.console.log('next window');
    const warn = r.printed.find((p) => p.method === 'warn');
    expect(warn?.args[0]).toMatch(/^NoobIDE: 250 console messages were not shown/);
    expect(parseLimiterSummary(String(warn?.args[0]), LIMITER_SOURCE_URL)).toBe(250);
    expect(r.printed.at(-1)).toEqual({ method: 'log', args: ['next window'] });
  });

  it('reports suppressed messages after the page stops logging (timer)', () => {
    const r = realm();
    for (let i = 0; i < CONSOLE_LIMIT + 3; i += 1) r.console.error(i);
    r.runTimers();
    expect(r.printed.filter((p) => p.method === 'warn').map((p) => p.args[0])).toEqual([
      expect.stringMatching(/^NoobIDE: 3 console/),
    ]);
  });

  it('limits console methods the page assigns itself (logging libraries)', () => {
    const r = realm();
    const mine: unknown[] = [];
    r.console.log = (...a: unknown[]) => mine.push(a);
    for (let i = 0; i < CONSOLE_LIMIT + 10; i += 1) r.console.log(i);
    expect(mine).toHaveLength(CONSOLE_LIMIT);
  });

  it('leaves silent methods alone and keeps console methods configurable', () => {
    const r = realm();
    expect(Object.getOwnPropertyDescriptor(r.console, 'time')?.value).toBe(r.natives.nativeTime);
    expect(typeof Object.getOwnPropertyDescriptor(r.console, 'log')?.get).toBe('function');
    expect(Object.getOwnPropertyDescriptor(r.console, 'log')?.configurable).toBe(true);
  });

  it('reports alert() in the console instead of a dialog, and print() does nothing', () => {
    const r = realm();
    (r.context.alert as (m: string) => void)('你好');
    (r.context.print as () => void)();
    expect(r.printed).toEqual([{ method: 'info', args: ['alert:', '你好'] }]);
  });

  it('recognises only summaries from the guard itself', () => {
    expect(parseLimiterSummary('NoobIDE: 12 console messages were not shown (x)', LIMITER_SOURCE_URL)).toBe(12);
    expect(
      parseLimiterSummary('NoobIDE: 12 console messages were not shown (x)', 'http://127.0.0.1:1/a.js'),
    ).toBeNull();
    expect(parseLimiterSummary('hello', LIMITER_SOURCE_URL)).toBeNull();
  });
});
