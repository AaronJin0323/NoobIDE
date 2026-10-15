# 0017 — Runtime capture adapter: main-side store, commit-based generations, referrer as initiator

- **Status:** accepted
- **Date:** 2026-10-15
- **Feature:** S16.2, S16.3, S16.4, S16.5, S16.6 (builds on 0010)

## Context

Decision 0010 captures raw preview records with webContents/session events (no CDP, no preload in the page). S16
needs them as `ProblemRecord`s with project paths, attributed to page loads, bounded under floods, and honest about
errors whose location is not in the project. The Problems panel (S17.1) already feature-detects
`window.noobide.problems` and otherwise rebuilds records from the preview event stream in the renderer.

## Decision

1. **Where:** a pure adapter `src/diagnostics/runtime-capture.ts` (`RuntimeCapture`) owns a `ProblemStore`. The main
   process wires it through `src/main/problems-bridge.ts`; `PreviewManager` reports into it via an optional
   `PreviewCaptureHook` (`sessionStarted`, `navigationStarted`, `navigationCommitted`, `entry`, `sessionEnded`).
   `entry` sees every raw record after the S05.3 flood guard (and after any in-page limiter), before the LogBuffer
   batching. The workbench reads it through `window.noobide.problems` (`list`, `onChanged`, `clearResolved`;
   `src/shared/ipc/problems-contract.ts`), sender-checked like every other channel; change notifications go only
   to the window that started the preview, coalesced to one per 150 ms.
2. **Generations (S16.3):** a new preview start is a new session id; a committed cross-document main-frame
   navigation (`did-navigate`: first load, refresh, save-triggered reload) is a new generation. Messages that the
   old document sends while the next load is still in flight stay with the old generation; only a failed request
   for the new document itself (`resourceType: mainFrame`) is attributed to the pending one. A record is `stale`
   when its latest occurrence is not in the current session+generation; the dedupe key ignores generations, so the
   same error after a refresh raises the count and clears `stale`. If the preview lifecycle (S14) later owns a
   generation counter, it can drive the same hook calls.
3. **Initiator (S16.4):** the request's `referrer` (from `webRequest`) is the initiator: Chromium sets it to the
   stylesheet for `url(...)`, to the importing module for `import`, and to the page for `<img>`, `<script>` and
   `fetch()`. A directory URL (`/`, `pages/`) is attributed to its `index.html`. Known limit: a `fetch()` from a
   classic script names the page, not the script.
4. **Volume (S16.5):** the store's token bucket is per source, so a console flood cannot starve the runtime error
   that follows it (it already could not evict it: per-source capacity).
5. **Cross-origin (S16.6):** Chromium's console record for an error inside a script from another website carries
   the real message and that script's URL — only the page's own `window.onerror` sees "Script error.". Such a
   record has no project file and keeps `data.scriptUrl`; the cross-origin rule explains, with certainty, that the
   error is in that script (not in the project), that the page itself only gets "Script error.", and offers no
   "Go to code". A genuinely opaque "Script error." keeps code `cross-origin-script-error`.
6. **No misleading file:** an error Chromium reports against an HTML page without a line (an unresolvable bare
   module import such as `import x from 'lodash'`) claims no file; the module-import rule names the specifier.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- Unit: `src/diagnostics/runtime-capture.test.ts`, `src/main/problems-bridge.test.ts`, `store.test.ts`.
- e2e: `tests/e2e/runtime-problems.spec.ts` on fixtures `预览 运行时`, `预览 错误洪水`, `预览 跨域` (the test serves
  the "other website" with `protocol.handle` on the preview partition, so no network is used). Verified on macOS
  arm64; Windows x64 runs the same suite (primary dev machine, CI S06).
- Not available from these events: columns and stacks for exceptions, and the line of a failed `import` (only its
  file, as initiator). CDP (`Runtime.exceptionThrown`) would add them; revisit if the explanation rules need them.
