/**
 * A small script installed into every document of the preview before the page's own scripts (S05.7, S05.5;
 * docs/decisions/0016). It is not a preload: it runs in the page's own main world with the page's own permissions,
 * is installed by main through the DevTools protocol (`Page.addScriptToEvaluateOnNewDocument`), and gives the page
 * nothing it did not have.
 *
 * 1. Console rate limit. Chromium sends every console message to the browser (main) process; a page logging in a
 *    tight loop would keep main — and with it all keyboard and mouse input of the IDE — busy for seconds. Each
 *    console method becomes an accessor property: reading `console.log` counts one message and returns the original
 *    native function while the page is under CONSOLE_LIMIT messages per CONSOLE_WINDOW_MS, and a function that does
 *    nothing above it. Because the native function is called directly by the page's code, Chromium still records the
 *    page's own file and line as the message location. Assigning a console method (libraries that wrap console) is
 *    kept and limited the same way. Suppressed messages are summarised once per window with a console warning from
 *    LIMITER_SOURCE_URL, which main turns into the IDE's "N messages dropped" count.
 * 2. `alert()` is reported in the console instead of opening a dialog (dialogs are disabled for the preview by
 *    `disableDialogs`, which is the actual protection: no page can block the IDE with a modal dialog). The bound
 *    native `console.info` keeps the page's call site as the location. `print()` does nothing.
 *
 * How a page can observe it: `Object.getOwnPropertyDescriptor(console, 'log')` is an accessor, `alert` and `print`
 * are accessors on `window`, and the summary warning appears in its console (and in DevTools). A page that saves a
 * reference to a console method while under the limit can call it without limits; main's flood guard
 * (preview-manager.ts) still bounds what reaches the IDE in that case.
 */

export const CONSOLE_LIMIT = 1_000;
export const CONSOLE_WINDOW_MS = 1_000;
export const LIMITER_SOURCE_URL = 'noobide-preview://page-guard.js';
const SUMMARY_PREFIX = 'NoobIDE: ';

/** Console methods that never print anything; they are left alone. */
const SILENT_METHODS = ['time', 'profile', 'profileEnd', 'timeStamp', 'groupEnd', 'context', 'createTask'];

/**
 * The guard's source for one preview. `nonce` (hex) is part of every summary message, so a page cannot forge
 * summaries: it sits in a closure the page cannot read (the accessors' own source text does not contain it).
 */
export function pageGuardSource(nonce: string): string {
  if (!/^[0-9a-f]{8,64}$/.test(nonce)) throw new Error('invalid page guard nonce');
  return `(() => {
  'use strict';
  const LIMIT = ${CONSOLE_LIMIT};
  const WINDOW_MS = ${CONSOLE_WINDOW_MS};
  const SILENT = new Set(${JSON.stringify(SILENT_METHODS)});
  const c = globalThis.console;
  if (!c) return;
  const now = Date.now;
  const later = globalThis.setTimeout;
  const apply = Reflect.apply;
  const define = Object.defineProperty;
  const describe = Object.getOwnPropertyDescriptor;
  const bind = Function.prototype.bind;
  const nativeWarn = c.warn;
  const nativeInfo = c.info;
  const ignore = function () {};
  let windowStart = 0;
  let used = 0;
  let suppressed = 0;
  let timer = 0;
  const report = () => {
    timer = 0;
    if (suppressed === 0) return;
    const n = suppressed;
    suppressed = 0;
    apply(nativeWarn, c, ['${SUMMARY_PREFIX}' + n + ' console messages were not shown (more than ' + LIMIT + ' per second). [${nonce}]']);
  };
  const admit = () => {
    const t = now();
    if (t - windowStart >= WINDOW_MS) {
      windowStart = t;
      used = 0;
      if (suppressed > 0) report();
    }
    if (used < LIMIT) {
      used += 1;
      return true;
    }
    suppressed += 1;
    if (!timer && typeof later === 'function') timer = later(report, WINDOW_MS);
    return false;
  };
  const limit = (target, name, value, enumerable) => {
    let current = value;
    define(target, name, {
      configurable: true,
      enumerable,
      get() { return admit() ? current : ignore; },
      set(v) { current = v; },
    });
  };
  for (const name of Object.getOwnPropertyNames(c)) {
    if (SILENT.has(name)) continue;
    const d = describe(c, name);
    if (!d || typeof d.value !== 'function' || !d.configurable) continue;
    limit(c, name, d.value, d.enumerable);
  }
  const w = globalThis;
  const alertDesc = describe(w, 'alert');
  if (alertDesc && alertDesc.configurable && typeof nativeInfo === 'function') {
    limit(w, 'alert', apply(bind, nativeInfo, [c, 'alert:']), alertDesc.enumerable);
  }
  const printDesc = describe(w, 'print');
  if (printDesc && printDesc.configurable) limit(w, 'print', ignore, printDesc.enumerable);
})();
//# sourceURL=${LIMITER_SOURCE_URL}
`;
}

/** Upper bound for one summary (one window of a few seconds at most); larger claims are not believed. */
const MAX_SUMMARY = 1_000_000_000;

/**
 * The number of messages a limiter summary reports, or null when the console message is not a genuine summary of
 * this preview's guard (wrong source, wrong nonce, implausible count).
 */
export function parseLimiterSummary(message: string, sourceId: string, nonce: string): number | null {
  if (sourceId !== LIMITER_SOURCE_URL || !message.startsWith(SUMMARY_PREFIX)) return null;
  const match = /^NoobIDE: (\d{1,10}) console messages were not shown .*\[([0-9a-f]+)\]$/.exec(message);
  if (!match || match[2] !== nonce) return null;
  const n = Number(match[1]);
  return n > 0 && n <= MAX_SUMMARY ? n : null;
}
