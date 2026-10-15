# 0016 — Console rate limit inside the page, installed over the DevTools protocol

- **Status:** accepted; amended twice (bounding a bypass; no unthrottled console method, 2026-10-15)
- **Date:** 2026-10-15
- **Feature:** S05.7 (unblocks S05.3); amends 0010

## Context

Chromium reports every console message of a page to the browser process; Electron turns each into a main-process
event. A page logging in a tight loop (fixture `预览 日志洪水`, hundreds of thousands of messages per second)
stalled the main thread — which carries all keyboard and mouse input of the IDE — for 3–5 s on Windows and 8–9 s on
an M3 Pro, even with 0010's listener-detaching flood guard, because most of the per-message work happens whether or
not a listener is attached. The limit therefore has to act **before** a message leaves the page. Constraints: no
preload in the preview (0009), messages below the limit must keep the page's own file and line (S05.4 records and
problem cards depend on them), the user's DevTools must keep working.

## Options considered

1. **Main-side throttling only** (0010's guard). Measured insufficient (above).
2. **Inject a `<script>` into served HTML** from the static server. Changes the user's files as the page sees them,
   misses documents not served as HTML (`about:blank`/`srcdoc` iframes), and shows up in "view source".
3. **Preload / `session.registerPreloadScript`.** Breaks the "no preload" isolation invariant.
4. **Wrapping console methods** in JavaScript. The wrapper becomes the top stack frame, so Chromium reports the
   wrapper's location instead of the user's file and line.
5. **Getter-based console methods installed with CDP `Page.addScriptToEvaluateOnNewDocument` (chosen).**

## Decision

- `src/preview/page-guard.ts` holds the script (`PAGE_GUARD_SOURCE`, plain JS, unit-tested in a `vm` realm). Each
  printing console method becomes an accessor: reading `console.log` counts one message and returns the **original
  native function** while the document is under **1,000 messages per 1 s window**, and a no-op function above it.
  The page calls the native function directly, so Chromium records the page's call site — file and line are
  unchanged (S05.4 e2e still passes; the flood e2e checks `index.html:18`). Methods assigned by the page (logging
  libraries) are kept and limited the same way. Silent methods (`time`, `groupEnd`, …) are untouched.
- Suppressed messages are summarised once per window with one `console.warn` whose source is
  `noobide-preview://page-guard.js` and whose text starts with `NoobIDE: <n> console messages were not shown` and
  ends with a random per-preview nonce (`[<hex>]`, kept in the guard's closure; the accessors' source text does not
  contain it, so a page cannot forge summaries). Main (`preview-manager.ts`) recognises it by source, text and
  nonce, ignores implausible counts (> 10⁹), does not show it as a message and adds `n` to the
  workbench's "N messages dropped" count (`LogBuffer.addDropped`), which is localised there.
- Installation (`installPageGuard` in preview-manager.ts): the fresh view first loads `about:blank` (on a view that
  never navigated, protocol commands never answer — the 0010 spike's hang), then `webContents.debugger.attach`,
  `Page.enable` (required: without it the script is accepted but never evaluated; `Page.disable` would drop it) and
  `Page.addScriptToEvaluateOnNewDocument`. The script then runs before page scripts in every new document and frame
  of the page's renderer, including refreshes and same-origin iframes. `Target.setAutoAttach` (paused on start,
  flattened, recursive) extends it to dedicated workers (`Runtime.evaluate` of the same script before the worker's
  own script — a worker's console reaches main too: unguarded, a 3 s worker flood stalled main 8.9 s) and to
  out-of-process iframes; a child target is always resumed, even when injecting fails. Best effort with a 5 s
  timeout; if the debugger detaches it is re-attached. The same script reports `alert(text)` as
  `console.info('alert:', text)` (a bound native, so it keeps the call site) and makes `print()` a no-op (dialogs themselves are disabled, 0015).
- Main's flood guard remains as a backstop, re-tuned to 3,000 messages per second (three limiter windows) so it
  only acts when the limiter was bypassed.
- **DevTools coexistence:** Chromium allows several protocol clients. The user's DevTools (opened from the preview)
  attaches next to our session; records keep arriving with DevTools open (S05.4 e2e). Our session only enables the
  Page domain and target auto-attach (no Runtime/Log events), so it does not receive console traffic itself. DevTools shows the accessor
  properties and the summary warning, and the limited messages are missing there too — the limit applies to the
  page, not to one viewer.
- **How a page can observe the limiter:** `Object.getOwnPropertyDescriptor(console, 'log')` is an accessor (`get` /
  `set`) instead of a data property; `window.alert` / `window.print` are accessors; reading `console.log` above the
  limit returns a different (no-op) function; the summary warning appears in its own console. Nothing is added to
  the page's global scope.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- Measured on MacBook Pro M3 Pro, macOS 27.2 arm64 (e2e `tests/e2e/preview-isolation.spec.ts`, flood test): the
  fixture now logs ~80 million calls in 6 s (most are no-ops), the longest main-thread stall during the flood is
  16–23 ms (was 8–9 s), a 3 s flood from a dedicated worker 16 ms, 20/20 keystrokes land with ≤ 1 ms latency, workbench timer lag ≤ 4 ms, and the console shows
  ≤ 200 lines plus "N messages dropped". S05.3's "IDE input stays responsive" is therefore met.
- Limits (documented, adversarial only): a page that stores a reference to a native console method while under the
  limit (`const log = console.log`, or a logging library that binds console methods at load time) can call it
  without limit; shared workers are not auto-attached from the page (service workers are refused, 0015). Main's
  flood guard still bounds what reaches the workbench, but such a page stalls main as before 0016 — measured in the
  flood e2e: a 2 s loop through a cached `console.log` stalls main for ~2.1 s (logged, not asserted below 200 ms);
  Stop always works. A main-side remedy would have to stop such a page (preview lifecycle, S14) — not done here.
- The limiter counts property reads, not calls: `typeof console.log` or spreading `console` counts too. Above the
  limit the read returns the no-op, so a library that binds `console.x` at that moment keeps a no-op, and
  `console.log === saved` is false above the limit.
- If installing the guard fails or times out (5 s), the preview still starts; `debugInfo().pageGuarded` is false
  (the flood e2e asserts it is true).
- Windows x64: run the same e2e on the dev machine (harness/MANUAL-CHECKS.md#S05.5-windows).

## Amendment (2026-10-15): bounding a page that bypasses the limiter

**Context.** The residual above (a cached native console method in a loop) stalled main 1.3–2.1 s, and the first
Windows CI run measured 356 ms for the (limited) worker flood. Measured on the M3 Pro: once messages reach main,
each costs ~20–30 µs of main-thread time whether or not a listener is attached (Electron builds an event per
message), and a page produces them faster than main consumes them, so the stall grows with the number of messages
main sees before anything stops the page.

**Options.** (a) Detach/reattach the listener (0010): does not remove Electron's per-message cost and stops
detection. (b) Drop at the protocol level: Chromium has no protocol switch that keeps console messages from being
sent to the browser process. (c) Stop the page through the lifecycle (crash the renderer): bounds main but destroys
the page the beginner is working on. (d) **Stop the running script (chosen)** with `Runtime.terminateExecution`
over the guard's existing protocol session — the page itself, its same-process frames, and every auto-attached
dedicated worker and out-of-process iframe — and detect sooner.

**Decision.**

- Main's flood guard (`preview-manager.ts`): above `FLOOD_LIMIT` messages per 1 s window it calls
  `stopRunawayScripts` (one request in flight, each answer awaited at most 250 ms), shows the localised notice
  "the running script was stopped" once per page load (`notice.kind: 'console-flood-stopped'`, never dropped by
  the log batch), and only counts the rest of the window. A further stop needs another `CONSOLE_LIMIT` messages
  after the previous stop was answered (the backlog arrives before the answer), so a page that went quiet is not
  stopped again. The page stays loaded; its timers and events keep running; a `setInterval` flood is stopped tick by
  tick.
- The in-page limit drops from 1,000 to **200 messages per second** per document/worker (the console shows at most
  200 lines of a burst anyway), and `FLOOD_LIMIT` is 4 × 200 = 800 (two documents' windows back to back): measured,
  the page is stopped within 0–1 ms of detection and main sees ~2,400 messages in total instead of ~10,000.
- Workers: dedicated workers are auto-attached child sessions (tracked from `Target.attachedToTarget` /
  `detachedFromTarget`) and are terminated with the page.

**Consequences.** Measured on MacBook Pro M3 Pro, macOS 27.2 arm64, e2e flood test (`preview-isolation.spec.ts`):
cached `console.log` loop in the page — stopped, longest main stall 26–72 ms (was 1,462–2,100 ms); the same in a
dedicated worker — stopped, 44–58 ms; limited page flood 8–31 ms; limited worker flood 4–14 ms. With all 12 cores
busy (12 spinning threads): 72 / 44 / 27 / 38 ms. The test now asserts < 200 ms for both bypass cases, that the
script was stopped, that the page still answers, and that the notice is shown. Limits: `Runtime.terminateExecution`
on a target that is idle at that moment ends its next script run instead (only after a page bypassed the limit);
shared workers are still not attached (0015 refuses service workers); a page that keeps re-flooding from timers is
stopped each time, costing main at most ~`FLOOD_LIMIT` messages per round. Windows x64: the same e2e (CI S06).

## Second amendment (2026-10-15): no page can hold an unthrottled console method

**Context.** The first amendment bounded a page that bypassed the limiter by stopping its script from main. That
stop is after the fact: main must first take in `FLOOD_LIMIT` messages and the backlog behind them, so its stall is
proportional to main's per-message cost. On the Windows CI runner (~0.6 ms per message) it failed: run 38695944850,
cached `console.log` loop in the page — stop sent 71 ms into the window, answered at 918 ms (13,948 messages queued),
the loop still ran to its end (5,965 ms), longest main stall 3,514 ms. The bypass itself — the getter handing out the
**native** method while under the limit, so `const log = console.log` kept an unlimited one — had to go.

**Options.**

- (a) **Never expose a native method (chosen).** The page only ever sees the guard's limiter functions; the caller's
  location is recovered in the limiter.
- (b) Suppress Chromium's console events (Runtime/Log domain settings) and report every record through a bounded
  channel the guard controls (`Runtime.addBinding`). Not possible: no protocol setting stops the renderer from sending
  console messages to the browser process (the cost is there whether or not anybody listens, see above); a binding
  is a page-visible global that must be hidden in every realm; DevTools would show every message at the guard's
  location.
- (c) Keep the getter and rely on main's stop — measured insufficient on a slow main.

**Decision.**

- `page-guard.ts` replaces every function-valued console method (all but `createTask`, which prints nothing; also
  `time`, `groupEnd`, `countReset`…, which do print warnings) with a limiter function held in a data property
  (writable, configurable, like the native one). The native methods exist only in the guard's closure. Descriptor
  values, `call`/`apply`/`bind`, `Reflect.apply`, prototype lookups and saved references all yield the limiter;
  `console.context()` returns a plain object of limiters. A console method the page assigns can only call limiters.
- **Rate:** a token bucket per document/worker/worklet — `CONSOLE_BURST` = 100 messages at once,
  `CONSOLE_LIMIT` = 200 per second on average (was: 200 per 1 s window, i.e. bursts of 200). The burst is what main
  must take in one go; at 0.6 ms per message 100 cost 60 ms. Summaries are reported at most once per second (inline
  in a busy loop, by timer otherwise), unchanged in form and nonce.
- **Attribution (S05.4):** for an admitted call the limiter reads its caller's location from V8's structured stack
  trace (`Error.captureStackTrace` with the guard's own `prepareStackTrace` set for that moment and the page's
  restored after; builtin frames such as `Array.prototype.forEach` are skipped, as Chromium does) and calls the native
  method from a **call stub**: `function (R, f, t, a) {'use strict'; … R(f, t, a);}` compiled with indirect `eval`
  with the call on the caller's line and column and `//# sourceURL=<caller URL>`. Chromium then records the
  caller's file and line, exactly as before (S05.4 e2e: errors.js:1/:3, the flood fixture's index.html:18, and the new
  `js/console.js` lines 3–7 for a saved reference, `forEach(console.info)`, `call`, `bind` and `alert`). The stub has
  no free variables; URLs that are not printable ASCII are not put into it (no line terminator can reach the source);
  its compiled source text is compared before use (a Trusted Types default policy that rewrites eval input never
  gets a native method); stubs are cached per call site (≤ 512 per document, lines ≤ 20,000, columns ≤ 400).
  Without `eval` (a page CSP without `'unsafe-eval'`) the guard calls the native method itself — still limited —
  and main records those messages without file and line (measured: no refusal message reaches main).
- **Other message sources the guard closes:** uncaught errors, `reportError()` and unhandled rejections (capturing
  listeners on the global object registered before any page script; above the limit the event is cancelled so
  Chromium does not report it; a worker's error weighs 2 because Chromium reports it twice); `navigator.vibrate()`
  (a console error per blocked call); `CSS.paintWorklet` / `layoutWorklet` / `animationWorklet` are removed (paint
  worklet scopes run where the protocol cannot inject: measured 1.8 M unlimited messages and a 9–16 s main stall).
- **Reach:** documents and same-process frames (also an iframe's initial `about:blank`, `srcdoc`, `data:`,
  `javascript:` URLs) via `Page.addScriptToEvaluateOnNewDocument`; out-of-process iframes, dedicated workers (nested
  too) and **worklets** (AudioWorklet — measured unlimited before) via auto-attach, paused until the guard ran. A
  worker or worklet the guard could not be installed in is **not resumed** (fails closed). Chromium's
  `IsolateSandboxedIframes` is switched off for the app (`DISABLED_CHROMIUM_FEATURES`): a sandboxed `srcdoc` iframe
  in its own process started its scripts before the protocol could install anything (it does not wait for the
  debugger; measured 1 M messages, 4–5 s stall); in the page's process it gets the guard like any frame. The preview
  as a whole is still its own sandboxed process apart from the IDE. Shared workers' console is not sent to main
  (measured 0 messages); service workers are refused (0015) and only resumed.
- Main's flood guard and `Runtime.terminateExecution` stay as **defence in depth** for output the limiter cannot see;
  its stall bound depends on main's speed, the limiter's does not.

**Trade-offs.** `console.log.toString()` is not `[native code]`; stack traces inside a console call show guard and
stub frames; in DevTools a message's location link opens the stub (blank lines and the call at the right line)
instead of the file; `console.time`/`groupEnd` count against the budget; 101+ lines printed at once lose the rest to
"N messages dropped" (was 201+); CSS paint worklets are unavailable in the preview; error events above the limit
arrive `defaultPrevented`. DevTools coexistence is otherwise unchanged (the user's DevTools sees the same limited
stream; the S05.4 coexistence e2e passes).

**Measurements** (MacBook Pro M3 Pro, macOS 27.2 arm64; e2e flood test `preview-isolation.spec.ts`; each bypass
loop runs 1.5 s, all ran to their end — nothing had to be stopped — and 400–403 messages reached main):

| case                                                | normal                                    | 12 cores busy  | main +0.6 ms/message |
| --------------------------------------------------- | ----------------------------------------- | -------------- | -------------------- |
| limited flood fixture (6 s) / worker flood (3 s)    | 3–4 / 3 ms                                | 13 / 13 ms     | —                    |
| saved `console.log` in the page                     | 2 ms                                      | 16 ms          | 27–35 ms             |
| descriptor value, call, apply, bind, Reflect.apply  | 2–3 ms                                    | 15 ms          | —                    |
| `console.context()` / prototype                     | 2–3 ms                                    | 3 ms           | —                    |
| new iframe's console (initial about:blank)          | 3 ms                                      | 3 ms           | —                    |
| sandboxed `srcdoc` iframe                           | 3–4 ms                                    | 14 ms          | 48–61 ms             |
| dedicated worker / nested worker                    | 3–4 ms                                    | 15 ms          | 57–58 / 32–36 ms     |
| AudioWorklet                                        | 3–4 ms                                    | 19 ms          | —                    |
| `reportError` + rejections                          | 2–3 ms                                    | 17 ms          | —                    |
| backstop (isolated-world flood, not page-reachable) | stopped after 198–242 ms, stall 88–121 ms | 252 ms, 139 ms | —                    |

Asserted: result `finished`, ≤ `CONSOLE_BURST + 1.5 × CONSOLE_LIMIT + 10` messages, stall < 200 ms (also with
the 0.6 ms/message slow main); the backstop is asserted to stop the isolated-world flood and show the notice, its
stall only logged. Before this amendment the same probe measured, without a guard in reach: AudioWorklet 1.0 M
messages / 5.6 s stall, paint worklet 1.8 M / 9–16 s, sandboxed srcdoc iframe 1.0 M / 4–5 s; with the old getter a
saved reference was unlimited (Windows CI above). Remaining residuals (backstop only): Chromium-generated warnings
other than the ones above (e.g. a future per-call intervention), and a page whose CSP forbids `eval` loses file and
line for its console messages. Windows x64: the same e2e on CI (S06).
