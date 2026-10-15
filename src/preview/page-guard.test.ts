import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  CONSOLE_BURST,
  CONSOLE_LIMIT,
  LIMITER_SOURCE_URL,
  WORKER_CONSOLE_BURST,
  WORKER_CONSOLE_LIMIT,
  pageGuardSource,
  parseLimiterSummary,
} from './page-guard';

const NONCE = '0123456789abcdef';
const PAGE_URL = 'http://127.0.0.1:5173/js/app.js';
const METHODS = ['log', 'error', 'warn', 'info', 'debug', 'trace', 'time', 'groupEnd', 'countReset', 'createTask'];

interface Printed {
  method: string;
  args: unknown[];
  /** The stack frame that called the native method (Chromium's message location). */
  caller: string;
}

/**
 * A fresh realm with fake native console methods, a fake clock and a minimal event target, then the page guard —
 * like a new preview document. `prelude` runs before the guard (what the browser provides); `strings: false` is a
 * Content Security Policy without 'unsafe-eval'.
 */
function realm(options: { prelude?: string; strings?: boolean; worker?: boolean; frames?: number } = {}) {
  const printed: Printed[] = [];
  const natives: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of METHODS) {
    natives[method] = {
      [method](...args: unknown[]) {
        const frames = (new Error().stack ?? '').split('\n').slice(2);
        printed.push({ method, args, caller: (frames[0] ?? '').trim() });
        return method === 'createTask' ? { run: (fn: () => unknown) => fn() } : undefined;
      },
    }[method] as (...args: unknown[]) => unknown;
  }
  const nativeContext = function context() {
    return { log: natives.log, warn: natives.warn };
  };
  let now = 1_000_000;
  const timers: (() => void)[] = [];
  const console: Record<string, unknown> = { ...natives, context: nativeContext };
  const sandbox: Record<string, unknown> = {
    console,
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
    __now: () => now,
  };
  const context = createContext(sandbox, { codeGeneration: { strings: options.strings ?? true, wasm: false } });
  runInContext(
    `Date.now = () => globalThis.__now();
    class Event {
      constructor(type, target) { this.type = type; this._target = target; this.defaultPrevented = false; }
      get target() { return this._target; }
      preventDefault() { this.defaultPrevented = true; }
    }
    globalThis.Event = Event;
    const listeners = [];
    globalThis.addEventListener = (type, fn, capture) => { listeners.push({ type, fn, capture }); };
    globalThis.__dispatch = (type, target = globalThis) => {
      const e = new Event(type, target);
      for (const l of listeners) if (l.type === type) l.fn(e);
      return e.defaultPrevented;
    };
    globalThis.__listeners = listeners;
    class Navigator { vibrate(pattern) { globalThis.__vibrated = (globalThis.__vibrated || 0) + 1; return true; } }
    globalThis.Navigator = Navigator;
    globalThis.navigator = new Navigator();
    globalThis.CSS = { paintWorklet: { addModule() {} }, supports() { return true; } };
    class BaseAudioContext {}
    Object.defineProperty(BaseAudioContext.prototype, 'audioWorklet', { get() { return {}; }, configurable: true });
    globalThis.BaseAudioContext = BaseAudioContext;
    if (!${options.worker ? 'true' : 'false'}) {
      // A window: \`top\` and \`length\` accessors and indexed child windows, like Chromium's WindowProxy.
      const childWindow = () => {
        const w = {};
        Object.defineProperty(w, 'length', { get: () => 0 });
        return w;
      };
      const kids = Array.from({ length: ${options.frames ?? 0} }, childWindow);
      Object.defineProperty(globalThis, 'top', { get() { return globalThis; }, configurable: false });
      Object.defineProperty(globalThis, 'length', { get() { return this === globalThis ? kids.length : 0; }, configurable: true });
      kids.forEach((k, i) => Object.defineProperty(globalThis, i, { get: () => k }));
      globalThis.__addFrames = (n) => { for (let i = 0; i < n; i += 1) { const k = childWindow(); Object.defineProperty(globalThis, kids.length, { get: () => k }); kids.push(k); } };
    }
    ${options.prelude ?? ''}`,
    context,
  );
  runInContext(pageGuardSource(NONCE), context, { filename: LIMITER_SOURCE_URL });
  /** Runs page code as the script at PAGE_URL (or `url`). */
  const page = <T = unknown>(code: string, url = PAGE_URL): T => runInContext(code, context, { filename: url }) as T;
  return {
    page,
    console: console as Record<'log' | 'error' | 'warn' | 'info' | 'context', (...a: unknown[]) => unknown> &
      Record<string, ((...a: unknown[]) => unknown) | undefined>,
    natives,
    nativeContext,
    printed,
    logs: () => printed.filter((p) => p.method !== 'warn' || !String(p.args[0]).startsWith('NoobIDE:')),
    summaries: () => printed.filter((p) => p.method === 'warn' && String(p.args[0]).startsWith('NoobIDE:')),
    advance: (ms: number) => {
      now += ms;
    },
    runTimers: () => timers.splice(0).forEach((t) => t()),
  };
}

/** Every native method that can print (createTask only returns a task object and stays). */
const ALL_NATIVES = (r: ReturnType<typeof realm>) => [
  ...Object.entries(r.natives)
    .filter(([name]) => name !== 'createTask')
    .map(([, fn]) => fn),
  r.nativeContext,
];

describe('page guard: no native console method is ever reachable (S05.7, decision 0016)', () => {
  it('replaces every printing console method; createTask stays', () => {
    const r = realm();
    for (const method of METHODS.filter((m) => m !== 'createTask')) {
      expect(r.console[method]).not.toBe(r.natives[method]);
      expect(typeof r.console[method]).toBe('function');
      expect(r.console[method]?.name).toBe(method);
      const d = Object.getOwnPropertyDescriptor(r.console, method);
      expect(d?.writable).toBe(true);
      expect(d?.configurable).toBe(true);
    }
    expect(r.console.createTask).toBe(r.natives.createTask);
  });

  it('a reference saved before the limit is limited too (page)', () => {
    const r = realm();
    const calls = r.page<number>(`
      const log = console.log;
      let n = 0;
      for (let i = 0; i < 10000; i += 1) { log('saved ' + i); n += 1; }
      n`);
    expect(calls).toBe(10_000);
    expect(r.logs()).toHaveLength(CONSOLE_BURST);
  });

  it('descriptors, call/apply/bind, Reflect.apply and prototype lookups only find the limited function', () => {
    const r = realm();
    const found = r.page<unknown[]>(`
      const fromDescriptor = Object.getOwnPropertyDescriptor(console, 'log').value;
      const proto = Object.getPrototypeOf(console);
      const all = Object.getOwnPropertyDescriptors(console);
      [fromDescriptor, proto && proto.log, ...Object.values(all).map((d) => d.value || d.get), console.log.bind(console)]`);
    for (const native of ALL_NATIVES(r)) expect(found).not.toContain(native);
    r.page(`
      const log = Object.getOwnPropertyDescriptor(console, 'log').value;
      const bound = Function.prototype.bind.call(console.log, console, 'bound');
      for (let i = 0; i < 3000; i += 1) {
        log.call(console, 'call');
        Function.prototype.apply.call(console.error, console, ['apply']);
        Reflect.apply(console.warn, console, ['reflect']);
        bound();
        console['info']('computed');
      }`);
    expect(r.logs()).toHaveLength(CONSOLE_BURST);
  });

  it('console.context() hands out limited methods only', () => {
    const r = realm();
    const ctx = r.page<Record<string, unknown>>(
      `const ctx = console.context('x'); for (let i = 0; i < 1000; i += 1) ctx.log(i); ctx`,
    );
    expect(Object.values(ctx)).not.toContain(r.natives.log);
    expect(Object.values(ctx)).not.toContain(r.natives.warn);
    expect(r.logs()).toHaveLength(CONSOLE_BURST);
  });

  it('a console method the page assigns can only reach the limited one (logging libraries)', () => {
    const r = realm();
    r.page(`
      const original = console.log;
      const lines = [];
      console.log = (...a) => { lines.push(a); original('[lib]', ...a); };
      for (let i = 0; i < 1000; i += 1) console.log(i);`);
    expect(r.logs()).toHaveLength(CONSOLE_BURST);
  });

  it('a stack-trace hook of the page never sees the guard’s functions or a native method', () => {
    const r = realm();
    const seen = r.page<unknown[]>(`
      const seen = [];
      Error.prepareStackTrace = (e, sites) => { for (const s of sites) seen.push(s.getFunction(), s.getThis()); return 'x'; };
      console.log({ toString() { return String(new Error().stack); } });
      console.log('second');
      seen`);
    for (const native of ALL_NATIVES(r)) expect(seen).not.toContain(native);
    expect(r.logs()).toHaveLength(2);
    // The page's hook is back in place afterwards.
    expect(r.page<string>(`String(new Error().stack)`)).toBe('x');
  });

  it('a page that freezes Error still gets limited output', () => {
    const r = realm();
    r.page(`Object.preventExtensions(Error); for (let i = 0; i < 500; i += 1) console.log(i);`);
    expect(r.logs()).toHaveLength(CONSOLE_BURST);
  });

  it('a page that blocks stack traces still gets limited output (without a location)', () => {
    const r = realm();
    r.page(`
      Object.defineProperty(Error, 'prepareStackTrace', { value: () => 'locked', configurable: false });
      for (let i = 0; i < 500; i += 1) console.log(i);`);
    expect(r.logs()).toHaveLength(CONSOLE_BURST);
    expect(r.logs()[0]?.caller).toContain(LIMITER_SOURCE_URL);
  });

  it('a rewritten eval (Trusted Types default policy) never receives a native method', () => {
    const r = realm({
      prelude: `const realEval = globalThis.eval;
        globalThis.__leaked = [];
        globalThis.eval = (src) => realEval('(function (R, f, t, a) { globalThis.__leaked.push(f); return R(f, t, a); })');`,
    });
    r.page(`console.log('one'); console.error('two');`);
    expect(r.page<unknown[]>(`globalThis.__leaked`)).toEqual([]);
    expect(r.logs().map((p) => p.args[0])).toEqual(['one', 'two']);
  });
});

describe('page guard: rate limit and summaries', () => {
  it('allows a burst of CONSOLE_BURST, then CONSOLE_LIMIT per second', () => {
    const r = realm();
    for (let i = 0; i < CONSOLE_BURST + 50; i += 1) r.console.log(i);
    expect(r.logs()).toHaveLength(CONSOLE_BURST);
    r.advance(1_000);
    r.runTimers(); // the summary of the 50 (it takes a token too)
    expect(r.summaries()).toHaveLength(1);
    // A steady CONSOLE_LIMIT per second all gets through.
    const step = 1_000 / CONSOLE_LIMIT;
    for (let i = 0; i < 3 * CONSOLE_LIMIT; i += 1) {
      r.advance(step);
      r.console.log('steady', i);
    }
    expect(r.logs().filter((p) => p.args[0] === 'steady')).toHaveLength(3 * CONSOLE_LIMIT);
    // A long pause refills to the burst size only.
    r.advance(60_000);
    const before = r.logs().length;
    for (let i = 0; i < 1_000; i += 1) r.console.log(i);
    expect(r.logs().length - before).toBe(CONSOLE_BURST);
  });

  it('reports suppressed messages once per second, inline in a loop and by timer', () => {
    const r = realm();
    for (let i = 0; i < CONSOLE_BURST + 250; i += 1) r.console.log(i);
    expect(r.summaries()).toHaveLength(0);
    r.advance(1_000);
    r.console.log('next window');
    expect(r.summaries()).toHaveLength(1);
    const text = String(r.summaries()[0]?.args[0]);
    expect(text).toMatch(/^NoobIDE: 250 console messages were not shown/);
    expect(parseLimiterSummary(text, LIMITER_SOURCE_URL, NONCE)).toBe(250);
    expect(r.summaries()[0]?.caller).toContain(LIMITER_SOURCE_URL);
    for (let i = 0; i < 1_000; i += 1) r.console.error(i);
    r.advance(1_000);
    r.runTimers();
    expect(r.summaries()).toHaveLength(2);
  });

  it('all documents of a page share one budget, however many iframes it creates', () => {
    const r = realm({ frames: 9 });
    for (let i = 0; i < 1_000; i += 1) r.console.log(i);
    expect(r.logs()).toHaveLength(CONSOLE_BURST / 10);
    // More frames later (counted again after 100 ms): the share shrinks, but every document may hold one message.
    r.page(`__addFrames(990)`);
    r.advance(10_000); // 1000 documents share 200 per second: 0.2 per second each, at most 1 held
    for (let i = 0; i < 1_000; i += 1) r.console.log(i);
    // That one token goes to the summary of what was suppressed before.
    expect(r.logs()).toHaveLength(CONSOLE_BURST / 10);
    expect(r.summaries()).toHaveLength(1);
  });

  it('a summary waits for a token too (many realms cannot flood main with summaries)', () => {
    const r = realm({ frames: 999 });
    for (let i = 0; i < 50; i += 1) r.console.log(i);
    expect(r.logs()).toHaveLength(1);
    r.advance(1_000);
    r.runTimers();
    // One token per ~5 s for this document (200/s shared by 1000): the summary is not sent yet.
    expect(r.summaries()).toHaveLength(0);
    r.advance(5_000);
    r.runTimers();
    expect(r.summaries()).toHaveLength(1);
    expect(parseLimiterSummary(String(r.summaries()[0]?.args[0]), LIMITER_SOURCE_URL, NONCE)).toBe(49);
  });

  it('a worker or worklet (no frame tree) has its own smaller budget', () => {
    const r = realm({ worker: true });
    for (let i = 0; i < 1_000; i += 1) r.console.log(i);
    expect(r.logs()).toHaveLength(WORKER_CONSOLE_BURST);
    r.advance(1_000);
    for (let i = 0; i < 1_000; i += 1) r.console.log(i);
    // The refilled bucket pays for the summary first.
    expect(r.logs()).toHaveLength(WORKER_CONSOLE_BURST + WORKER_CONSOLE_BURST - 1);
    expect(r.summaries()).toHaveLength(1);
    expect(WORKER_CONSOLE_LIMIT).toBeLessThan(CONSOLE_LIMIT);
  });

  it('cancels uncaught errors and unhandled rejections above the limit, only for the global object', () => {
    const r = realm();
    const cancelled = r.page<boolean[]>(`
      const out = [];
      for (let i = 0; i < 300; i += 1) out.push(__dispatch(i % 2 ? 'error' : 'unhandledrejection'));
      out`);
    expect(cancelled.filter((c) => !c)).toHaveLength(CONSOLE_BURST);
    expect(cancelled.slice(CONSOLE_BURST).every((c) => c)).toBe(true);
    // An element's load error (only passes the global object while capturing) is not counted or cancelled.
    expect(r.page<boolean>(`__dispatch('error', {})`)).toBe(false);
    expect(r.page<{ capture: boolean }[]>(`__listeners`).every((l) => l.capture)).toBe(true);
  });

  it('limits navigator.vibrate (Chromium logs every blocked call)', () => {
    const r = realm();
    r.page(`for (let i = 0; i < 1000; i += 1) navigator.vibrate(5)`);
    expect(r.page<number>(`globalThis.__vibrated`)).toBe(CONSOLE_BURST);
  });
});

describe('page guard: caller location (S05.4)', () => {
  it('the native method is called from a stub at the caller’s URL, line and column', () => {
    const r = realm();
    r.page(`// line 1
// line 2
  console.error('three');
[1].forEach((x) => console.log('four', x));
const b = console.warn.bind(console, 'five'); b();`);
    const at = (text: string) => r.logs().find((p) => p.args.includes(text))?.caller ?? '';
    // V8's position of a method call is the method name's (`error`), for Chromium as for the stub.
    expect(at('three')).toContain(`${PAGE_URL}:3:11`);
    expect(at('four')).toContain(`${PAGE_URL}:4:28`);
    expect(at('five')).toContain(`${PAGE_URL}:5:47`);
  });

  it('a function passed to a builtin is attributed to the caller of the builtin', () => {
    const r = realm();
    r.page(`\n\n['x'].forEach(console.log);`);
    expect(r.logs()[0]?.caller).toContain(`${PAGE_URL}:3:7`);
  });

  it('line 1 and Chinese file names keep their line; unusual URLs are not put into the stub', () => {
    const r = realm();
    const url = 'http://127.0.0.1:5173/%E4%B8%AD%E6%96%87/%E9%A1%B5.js';
    r.page(`console.log('first line')`, url);
    expect(r.logs()[0]?.caller).toContain(`${url}:1:`);
    r.page(`\nconsole.log('odd')`, 'http://x/a b c.js');
    const odd = r.logs()[1]?.caller ?? '';
    expect(odd).not.toContain('a b');
    expect(odd).toMatch(/<anonymous>:2:9\)$/);
  });

  it('reuses one stub per call site', () => {
    const r = realm();
    r.page(`for (let i = 0; i < 5; i += 1) console.log(i);`);
    expect(new Set(r.logs().map((p) => p.caller)).size).toBe(1);
  });

  it('without eval (Content Security Policy) the guard calls the native method itself', () => {
    const r = realm({ strings: false });
    r.page(`\nconsole.log('csp');`);
    expect(r.logs()[0]?.args).toEqual(['csp']);
    expect(r.logs()[0]?.caller).toContain(LIMITER_SOURCE_URL);
    for (let i = 0; i < 1000; i += 1) r.console.log(i);
    expect(r.logs()).toHaveLength(CONSOLE_BURST);
  });
});

describe('page guard: dialogs, worklets, nonce', () => {
  it('reports alert() in the console instead of a dialog, and print() does nothing', () => {
    const r = realm();
    r.page(`alert('你好'); print();`);
    expect(r.logs().map((p) => [p.method, p.args])).toEqual([['info', ['alert:', '你好']]]);
    expect(r.logs()[0]?.caller).toContain(`${PAGE_URL}:1:`);
  });

  it('removes the CSS and audio worklet entry points (their errors or scopes cannot be guarded)', () => {
    const r = realm();
    expect(r.page(`CSS.paintWorklet`)).toBeUndefined();
    expect(r.page(`'audioWorklet' in BaseAudioContext.prototype`)).toBe(false);
    expect(r.page(`typeof CSS.supports`)).toBe('function');
  });

  it('recognises only genuine summaries of this preview (source, nonce, plausible count)', () => {
    const msg = (n: string, nonce = NONCE) => `NoobIDE: ${n} console messages were not shown (x). [${nonce}]`;
    expect(parseLimiterSummary(msg('12'), LIMITER_SOURCE_URL, NONCE)).toBe(12);
    expect(parseLimiterSummary(msg('12'), 'http://127.0.0.1:1/a.js', NONCE)).toBeNull();
    // A page that fakes the source URL does not know the nonce.
    expect(parseLimiterSummary(msg('12', 'ffffffffffffffff'), LIMITER_SOURCE_URL, NONCE)).toBeNull();
    expect(parseLimiterSummary(msg('12').replace(/ \[.*\]$/, ''), LIMITER_SOURCE_URL, NONCE)).toBeNull();
    expect(parseLimiterSummary(msg('999999999999999'), LIMITER_SOURCE_URL, NONCE)).toBeNull();
    expect(parseLimiterSummary(msg('0'), LIMITER_SOURCE_URL, NONCE)).toBeNull();
    expect(parseLimiterSummary('hello', LIMITER_SOURCE_URL, NONCE)).toBeNull();
  });

  it('does not reveal the nonce through any function the page can reach', () => {
    const r = realm();
    const texts = r.page<string[]>(`[
      ...Object.values(console).map(String),
      String(console.context('x').log), String(alert), String(print), String(navigator.vibrate),
    ]`);
    for (const text of texts) expect(text).not.toContain(NONCE);
    expect(() => pageGuardSource('not hex!')).toThrow();
  });
});
