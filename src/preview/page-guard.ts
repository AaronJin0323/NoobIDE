/**
 * A small script installed into every document, dedicated worker and worklet of the preview before the page's
 * own scripts (S05.7, S05.5; docs/decisions/0016). It is not a preload: it runs in the page's own main world with
 * the page's own permissions, is installed by main through the DevTools protocol
 * (`Page.addScriptToEvaluateOnNewDocument`, and `Runtime.evaluate` in paused workers and worklets), and gives the
 * page nothing it did not have.
 *
 * 1. Console rate limit. Chromium sends every console message of a page to the browser (main) process; a page
 *    logging in a tight loop would keep main — and with it all keyboard and mouse input of the IDE — busy. The
 *    guard
 *    takes every console method away from the page and puts a limiter function in its place; the native methods live
 *    only in this closure, so no reference the page can keep, bind, copy from a descriptor or reach through a
 *    prototype or `console.context()` is ever a native console method (decision 0016, second amendment). The
 *    limiter (a token bucket: CONSOLE_BURST at once, CONSOLE_LIMIT per CONSOLE_WINDOW_MS on average, shared by all
 *    documents of the page's frame tree; workers and worklets have a small bucket each) calls the native method or
 *    nothing. Uncaught errors, `reportError()` and unhandled rejections become console messages
 *    too: above the limit their events are cancelled, so Chromium does not report them; `navigator.vibrate()` (a
 *    console error per blocked call) is limited the same way. Suppressed messages are summarised at most once per
 *    window with a console warning from LIMITER_SOURCE_URL, which main turns into the IDE's "N messages dropped".
 * 2. Caller location. Chromium attributes a console message to the JavaScript frame that called the native method.
 *    So that a message keeps the page's own file and line (S05.4), the limiter reads its caller's location (V8's
 *    structured stack trace, with the page's own `Error.prepareStackTrace` set aside meanwhile) and calls the native
 *    method from a tiny call stub compiled (indirect `eval`) with that URL as its `//# sourceURL` and the call
 *    placed on that line and column. The stub is the same text for every page and only calls the function it is
 *    given (no free variables); its compiled source text is checked before use, so a Trusted Types default policy
 *    that rewrites it is ignored. Stubs are cached per call site. If the page's Content Security Policy forbids
 *    `eval`, the guard calls the native method itself (main records such messages without a file and line).
 * 3. `alert()` is reported in the console instead of opening a dialog (dialogs are disabled for the preview by
 *    `disableDialogs`, which is the actual protection: no page can block the IDE with a modal dialog). `print()`
 *    does nothing. `CSS.paintWorklet` (and the layout/animation worklets) and `audioWorklet` are removed: Chromium
 *    runs paint worklets in global scopes the DevTools protocol cannot reach, and an audio worklet's uncaught errors
 *    cannot be cancelled; both reach main unlimited.
 *
 * How a page can observe it: console methods, `alert`, `print` and `navigator.vibrate` are ordinary functions whose
 * source text is the guard's (not `[native code]`); stack traces taken inside a console call (`console.trace`, an
 * argument's `toString`) show frames of LIMITER_SOURCE_URL and a stub at the caller's line; above the limit console
 * calls do nothing and `error`/`unhandledrejection` events arrive with `defaultPrevented` set; `console.context()`
 * returns a plain object; `CSS.paintWorklet` and `audioWorklet` are missing; the share of a frame shrinks as the page
 * adds frames; the summary warning appears in its console. Nothing is added to the page's global scope.
 */

export const CONSOLE_LIMIT = 200;
export const CONSOLE_WINDOW_MS = 1_000;
/**
 * At most this many messages at once (token bucket capacity): main takes them in one go, so a burst costs main
 * BURST × its per-message cost (~20–30 µs on an M3 Pro, ~0.6 ms on a loaded Windows CI runner) however slow it is.
 */
export const CONSOLE_BURST = 100;
/** The budget of one dedicated worker or worklet (each has its own; main caps how many run, preview-manager.ts). */
export const WORKER_CONSOLE_LIMIT = 50;
export const WORKER_CONSOLE_BURST = 20;
/**
 * How many dedicated workers and worklets of one preview may run (with the guard) at once; main leaves further ones
 * paused, so they never start (preview-manager.ts). Together with the page's own budget this bounds what main must
 * take in one go: about CONSOLE_BURST + MAX_GUARDED_SCOPES × WORKER_CONSOLE_BURST messages.
 */
export const MAX_GUARDED_SCOPES = 8;
export const LIMITER_SOURCE_URL = 'noobide-preview://page-guard.js';
const SUMMARY_PREFIX = 'NoobIDE: ';

/** Console methods that only return an object (no output); everything else that is a function is limited. */
const UNLIMITED_METHODS = ['createTask'];
/**
 * Call stubs: at most this many cached per document, and lines/columns within these bounds get an exact location
 * (larger columns are reported at column 1 of the right line, larger lines without a file and line).
 */
const STUB_CACHE = 512;
const STUB_MAX_LINE = 20_000;
const STUB_MAX_COLUMN = 400;

/**
 * The guard's source for one preview. `nonce` (hex) is part of every summary message, so a page cannot forge
 * summaries: it sits in a closure the page cannot read (no function the page can reach contains it).
 */
export function pageGuardSource(nonce: string): string {
  if (!/^[0-9a-f]{8,64}$/.test(nonce)) throw new Error('invalid page guard nonce');
  return `(() => {
  'use strict';
  const LIMIT = ${CONSOLE_LIMIT};
  const WINDOW_MS = ${CONSOLE_WINDOW_MS};
  const BURST = ${CONSOLE_BURST};
  const WORKER_LIMIT = ${WORKER_CONSOLE_LIMIT};
  const WORKER_BURST = ${WORKER_CONSOLE_BURST};
  const MAX_DOCUMENTS = 1000;
  const RECOUNT_MS = 100;
  const OWN_URL = ${JSON.stringify(LIMITER_SOURCE_URL)};
  const UNLIMITED = ${JSON.stringify(UNLIMITED_METHODS)};
  const STUB_CACHE = ${STUB_CACHE};
  const MAX_LINE = ${STUB_MAX_LINE};
  const MAX_COLUMN = ${STUB_MAX_COLUMN};
  const g = globalThis;
  const c = g.console;
  if (!c) return;
  // Everything the guard uses later is taken now, before any page script runs: the page may replace any global or
  // prototype method afterwards.
  const R = Reflect.apply;
  const define = Object.defineProperty;
  const describe = Object.getOwnPropertyDescriptor;
  const ownNames = Object.getOwnPropertyNames;
  const getProto = Object.getPrototypeOf;
  const setProto = Object.setPrototypeOf;
  const now = Date.now;
  const later = typeof g.setTimeout === 'function' ? g.setTimeout : null;
  const evaluate = g.eval;
  const fnText = Function.prototype.toString;
  const repeat = String.prototype.repeat;
  const has = Set.prototype.has;
  const exec = RegExp.prototype.exec;
  const NativeError = g.Error;
  const captureStack = NativeError.captureStackTrace;
  const MapGet = Map.prototype.get;
  const MapSet = Map.prototype.set;
  const MapClear = Map.prototype.clear;
  const EventProto = typeof g.Event === 'function' ? g.Event.prototype : null;
  const eventTarget = EventProto ? describe(EventProto, 'target').get : null;
  const cancel = EventProto ? EventProto.preventDefault : null;
  const listen = typeof g.addEventListener === 'function' ? g.addEventListener : null;
  const nativeWarn = c.warn;
  const nativeInfo = c.info;
  const unlimited = new Set(UNLIMITED);
  const URL_OK = /^[!-~]{1,2048}$/;
  const STUB_HEAD = "function (R, f, t, a) {'use strict';";

  // --- limit ---------------------------------------------------------------------------------------------------
  // A token bucket: LIMIT messages per WINDOW_MS on average, at most BURST at once (what main has to take in one go).
  // The budget belongs to the whole page, not to one realm: a document shares it with every other document of its
  // frame tree (counted from \`top\` through the cross-origin-readable \`length\` and indexed child windows, which a
  // page cannot fake), so a page with many iframes gets no more than one. Workers and worklets (no frame tree; main
  // limits how many run) get the smaller WORKER_BURST / WORKER_LIMIT each.
  const lengthOf = (() => {
    const d = describe(g, 'length');
    return d && typeof d.get === 'function' ? d.get : null;
  })();
  const topOf = (() => {
    const d = describe(g, 'top');
    return d && typeof d.get === 'function' ? d.get : null;
  })();
  const inFrameTree = lengthOf !== null && topOf !== null;
  const countDocuments = () => {
    let top = null;
    try {
      top = R(topOf, g, []);
    } catch {
      return 1;
    }
    let n = 0;
    const visit = (w, depth) => {
      n += 1;
      if (n >= MAX_DOCUMENTS || depth > 64) return;
      let length = 0;
      try {
        length = R(lengthOf, w, []);
      } catch {
        return;
      }
      if (typeof length !== 'number') return;
      for (let i = 0; i < length && n < MAX_DOCUMENTS; i += 1) {
        let child = null;
        try {
          child = w[i];
        } catch {
          child = null;
        }
        if (child) visit(child, depth + 1);
      }
    };
    if (top) visit(top, 0);
    return n > 0 ? n : 1;
  };
  let documents = inFrameTree ? countDocuments() : 1;
  let counted = now();
  const share = () => (inFrameTree ? 1 / documents : 1);
  const burst = () => (inFrameTree ? BURST : WORKER_BURST) * share();
  const rate = () => (inFrameTree ? LIMIT : WORKER_LIMIT) * share();
  let tokens = burst() > 1 ? burst() : 1;
  let refilled = counted;
  let lastReport = refilled;
  let suppressed = 0;
  let timer = 0;
  // Refills the bucket (recounting the frame tree now and then) and takes \`weight\` tokens if there are enough.
  const take = (t, weight) => {
    if (inFrameTree && (t - counted >= RECOUNT_MS || t < counted)) {
      documents = countDocuments();
      counted = t;
    }
    const elapsed = t - refilled;
    refilled = t;
    if (elapsed > 0) tokens = tokens + (elapsed * rate()) / WINDOW_MS;
    // Each realm can hold at least one token (with more than BURST documents the page's burst is one per document).
    const most = burst() > 1 ? burst() : 1;
    if (tokens > most) tokens = most;
    if (tokens < weight) return false;
    tokens -= weight;
    return true;
  };
  // The summary is a console message too and takes a token: with many frames it waits for its turn.
  const report = () => {
    timer = 0;
    if (suppressed === 0) return;
    const t = now();
    if (!take(t, 1)) {
      if (later) timer = R(later, g, [report, WINDOW_MS]);
      return;
    }
    lastReport = t;
    const n = suppressed;
    suppressed = 0;
    R(nativeWarn, c, ['${SUMMARY_PREFIX}' + n + ' console messages were not shown (more than ' + LIMIT + ' per second). [${nonce}]']);
  };
  const admit = (weight = 1) => {
    const t = now();
    if (suppressed > 0 && t - lastReport >= WINDOW_MS) report();
    if (take(t, weight)) return true;
    suppressed += weight;
    if (!timer && later) timer = R(later, g, [report, WINDOW_MS]);
    return false;
  };

  // --- caller location -----------------------------------------------------------------------------------------
  const keepSites = (_error, sites) => sites;
  let siteUrl = null;
  let siteLine = null;
  let siteColumn = null;
  const sitesHere = () => {
    const saved = describe(NativeError, 'prepareStackTrace');
    if (saved) setProto(saved, null); // restored below without consulting Object.prototype
    if (saved && !saved.configurable) return null;
    try {
      define(NativeError, 'prepareStackTrace', { __proto__: null, value: keepSites, writable: true, configurable: true });
      const holder = { __proto__: null };
      R(captureStack, NativeError, [holder]);
      const sites = holder.stack;
      return sites && typeof sites === 'object' ? sites : null;
    } catch {
      return null;
    } finally {
      try {
        if (saved) define(NativeError, 'prepareStackTrace', saved);
        else delete NativeError.prepareStackTrace;
      } catch {
        // the page made Error non-extensible: nothing was changed
      }
    }
  };
  {
    const sites = sitesHere();
    const proto = sites && sites.length > 0 ? getProto(sites[0]) : null;
    if (proto) {
      siteUrl = proto.getScriptNameOrSourceURL;
      siteLine = proto.getLineNumber;
      siteColumn = proto.getColumnNumber;
    }
  }
  // The first frame below the guard that belongs to a script (builtins such as Array.prototype.forEach have no
  // line), as [url or '', line, column]; null when unknown.
  const callerOf = () => {
    if (typeof siteUrl !== 'function' || typeof siteLine !== 'function' || typeof siteColumn !== 'function') return null;
    const sites = sitesHere();
    if (!sites) return null;
    const n = sites.length;
    for (let i = 0; i < n && i < 64; i += 1) {
      const site = sites[i];
      const line = R(siteLine, site, []);
      if (typeof line !== 'number' || !(line >= 1)) continue;
      const url = R(siteUrl, site, []);
      if (url === OWN_URL) continue;
      const column = R(siteColumn, site, []);
      return [typeof url === 'string' ? url : '', line, typeof column === 'number' && column >= 1 ? column : 1];
    }
    return null;
  };

  // --- call stubs ----------------------------------------------------------------------------------------------
  // A stub is 'function (R, f, t, a) {...R(f, t, a);}' with the call at the caller's line and column and the
  // caller's URL as sourceURL: Chromium then reports the caller's file and line for the message.
  const stubs = new Map();
  let stubCount = 0;
  let stubsOff = evaluate === undefined || typeof evaluate !== 'function';
  const stubFor = (url, line, column) => {
    if (stubsOff) return null;
    const known = url !== '' && R(exec, URL_OK, [url]) !== null;
    if (!known) url = '';
    if (line > MAX_LINE) return null;
    if (column > MAX_COLUMN) column = 1;
    const key = url + '\\n' + line + '\\n' + column;
    const cached = R(MapGet, stubs, [key]);
    if (cached !== undefined) return cached;
    let body = STUB_HEAD;
    if (line > 1) {
      body += R(repeat, '\\n', [line - 1]) + R(repeat, ' ', [column - 1]);
    } else if (column - 1 > STUB_HEAD.length) {
      body += R(repeat, ' ', [column - 1 - STUB_HEAD.length]);
    }
    body += 'R(f, t, a);}';
    let stub = null;
    try {
      stub = (0, evaluate)('(' + body + ')' + (url ? '\\n//# sourceURL=' + url : ''));
    } catch {
      stubsOff = true; // eval is refused (Content Security Policy): from now on the guard calls directly
      return null;
    }
    // A Trusted Types default policy can rewrite the text eval compiles: use only the exact stub.
    if (typeof stub !== 'function' || R(fnText, stub, []) !== body) {
      stubsOff = true;
      return null;
    }
    if (stubCount >= STUB_CACHE) {
      R(MapClear, stubs, []);
      stubCount = 0;
    }
    R(MapSet, stubs, [key, stub]);
    stubCount += 1;
    return stub;
  };
  const send = (native, self, args) => {
    const caller = callerOf();
    const stub = caller ? stubFor(caller[0], caller[1], caller[2]) : null;
    if (stub) return R(stub, undefined, [R, native, self, args]);
    return R(native, self, args);
  };

  // --- console -------------------------------------------------------------------------------------------------
  const limited = (name, native, self) => {
    const holder = {
      [name](...args) {
        if (!admit()) return undefined;
        return send(native, self, args);
      },
    };
    return holder[name];
  };
  const nativeContext = typeof c.context === 'function' ? c.context : null;
  for (const name of ownNames(c)) {
    if (R(has, unlimited, [name])) continue;
    const d = describe(c, name);
    if (!d || typeof d.value !== 'function' || !d.configurable) continue;
    let value;
    if (name === 'context' && nativeContext) {
      // console.context() returns an object with its own console methods: hand out limited ones only.
      const holder = {
        context(...args) {
          const ctx = R(nativeContext, c, args);
          const out = {};
          if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return out;
          const keys = ownNames(ctx);
          for (let i = 0; i < keys.length; i += 1) {
            const key = keys[i];
            const kd = describe(ctx, key);
            if (!kd || typeof kd.value !== 'function' || R(has, unlimited, [key])) continue;
            const value = limited(key, kd.value, ctx);
            define(out, key, { __proto__: null, value, writable: true, enumerable: true, configurable: true });
          }
          return out;
        },
      };
      value = holder.context;
    } else {
      value = limited(name, d.value, c);
    }
    define(c, name, { value, writable: d.writable, enumerable: d.enumerable, configurable: true });
  }

  // --- errors --------------------------------------------------------------------------------------------------
  // Uncaught errors, reportError() and unhandled rejections are console messages as well. The guard's capturing
  // listeners on the global object are the first to run; above the limit they cancel the event, so Chromium does
  // not report it. (Resource load errors only pass the global object in the capture phase and are not touched.)
  if (listen && eventTarget && typeof cancel === 'function') {
    // A worker's uncaught error is reported twice (by the worker and by its Worker object in the parent).
    const weight = typeof g.importScripts === 'function' ? 2 : 1;
    const onError = (event) => {
      if (R(eventTarget, event, []) !== g) return;
      if (!admit(weight)) R(cancel, event, []);
    };
    R(listen, g, ['error', onError, true]);
    R(listen, g, ['unhandledrejection', onError, true]);
  }

  // --- other calls Chromium answers with a console message each time -------------------------------------------
  // navigator.vibrate() without a user gesture logs "Blocked call to navigator.vibrate" on every call.
  const NavigatorCtor = g.Navigator;
  const navProto = typeof NavigatorCtor === 'function' ? NavigatorCtor.prototype : null;
  const vibrateDesc = navProto ? describe(navProto, 'vibrate') : undefined;
  if (vibrateDesc && typeof vibrateDesc.value === 'function' && vibrateDesc.configurable) {
    const nativeVibrate = vibrateDesc.value;
    const holder = {
      vibrate(...args) {
        if (!admit()) return false;
        return send(nativeVibrate, this, args);
      },
    };
    define(navProto, 'vibrate', { value: holder.vibrate, writable: true, enumerable: vibrateDesc.enumerable, configurable: true });
  }

  // --- audio worklets ------------------------------------------------------------------------------------------
  // An AudioWorklet's console is limited (main installs the guard there), but its global scope is no event target:
  // uncaught errors and rejections of its message handlers cannot be cancelled and reach main unlimited.
  const BaseAudio = g.BaseAudioContext;
  const audioProto = typeof BaseAudio === 'function' ? BaseAudio.prototype : null;
  const audioDesc = audioProto ? describe(audioProto, 'audioWorklet') : undefined;
  if (audioDesc && audioDesc.configurable) delete audioProto.audioWorklet;

  // --- CSS worklets ---------------------------------------------------------------------------------------------
  // Chromium runs CSS paint worklets in global scopes that are not reachable over the DevTools protocol (no guard),
  // and their console messages reach main like the page's: the Houdini worklet entry points are removed.
  const css = g.CSS;
  if (css && (typeof css === 'object' || typeof css === 'function')) {
    for (const name of ['paintWorklet', 'layoutWorklet', 'animationWorklet']) {
      const d = describe(css, name);
      if (d && d.configurable) delete css[name];
    }
  }

  // --- dialogs -------------------------------------------------------------------------------------------------
  const alertDesc = describe(g, 'alert');
  if (alertDesc && alertDesc.configurable && typeof nativeInfo === 'function') {
    const holder = {
      alert(...args) {
        if (!admit()) return undefined;
        send(nativeInfo, c, args.length > 0 ? ['alert:', args[0]] : ['alert:']);
        return undefined;
      },
    };
    define(g, 'alert', { value: holder.alert, writable: true, enumerable: alertDesc.enumerable, configurable: true });
  }
  const printDesc = describe(g, 'print');
  if (printDesc && printDesc.configurable) {
    const holder = { print() {} };
    define(g, 'print', { value: holder.print, writable: true, enumerable: printDesc.enumerable, configurable: true });
  }
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
