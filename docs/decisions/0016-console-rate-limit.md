# 0016 — Console rate limit inside the page, installed over the DevTools protocol

- **Status:** accepted
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
  `noobide-preview://page-guard.js` and whose text starts with `NoobIDE: <n> console messages were not shown`. Main
  (`preview-manager.ts`) recognises it by source and text, does not show it as a message and adds `n` to the
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
  limit (`const log = console.log`) can call it without limit; shared workers are not auto-attached from the page
  (service workers are refused, 0015). Main's flood guard still bounds what reaches the workbench,
  but a deliberately bypassing page can stall main as before 0016; Stop always works.
- An object logged with `console.log` is counted once per method read, not per argument.
- Windows x64: run the same e2e on the dev machine (harness/MANUAL-CHECKS.md#S05.5-windows).
