# src/preview — static server and preview lifecycle

Loopback-only static server confined to the project root (realpath checks, GET/HEAD only, Host check), preview
state machine, WebContentsView creation with sandboxing and per-project partitions (PLAN §8).

Network and page guards (decisions 0015, 0016): `preview-proxy.ts` + `address-policy.ts` — every request of the
preview session goes through a SOCKS5 proxy in main that allows only the project server (`127.0.0.1:<port>`) and
public internet addresses, deciding on the resolved address; `page-guard.ts` — a script installed over the DevTools
protocol before page scripts (pages, iframes, workers, audio worklets) that replaces every console method with a
rate limiter (no native console method is reachable by the page; messages keep the caller's file and line through a
call stub) and reports `alert()`. Main's flood guard stops the running scripts (`Runtime.terminateExecution`) of a
page whose console output still exceeds it — defence in depth (decision 0016 and its amendments). `permission-policy.ts` (S25.4) — every permission request is
denied by the session; the first of each kind per page load is explained in the console.

Modules (S14, S15.4 — see docs/decisions/0018):

- `state-machine.ts` — pure preview state machine and the page-load **generation** (`PreviewStatus.generation`: +1 on
  every Start, refresh and page-initiated navigation; never decreases; records with a lower generation are stale).
- `server-registry.ts` — at most one loopback server per open project, owned by `{ projectId, windowId }`; released on
  project switch/close; `not-owner` for other windows.
- `refresh-scheduler.ts` — automatic refresh after a confirmed save and a typing pause.
- `entry-pages.ts`, `project-options.ts` — entry page picker and refresh mode (stored via the S13.2 project.json
  module).
- `static-server.ts` — also issues one-time external-browser grants (HttpOnly SameSite=Strict cookie).

Other modules (S04, S05, S15, S16 — decisions 0009, 0010, 0019):

- `static-server.ts`, `request-path.ts`, `mime.ts` — the loopback server, its path guard and content types (S04.1,
  S04.2).
- `preview-manager.ts`, `preview-options.ts` — the sandboxed `WebContentsView` per project (no preload, partition
  `persist:noobide-preview-<sha256(root)>`), watchdog, Stop, DevTools, clear data (S04.3, S05, S14.5).
- `request-policy.ts` — what the page may request and where it may navigate (S05.5).
- `view-sync.ts` — bounds, DPI rounding, overlays and focus between the workbench and the view (S15.1, S15.5).
- `log-buffer.ts`, `to-problem.ts` — bounded console/log buffer and raw records → problem inputs (S05.3, S16).
- `page-snapshot.ts` (S38.1, decision 0026) — a bounded snapshot of the shown page for the AI assistant: outline read
  in an isolated world over the page guard's protocol session, screenshot from `capturePage()`, all from main and
  within time budgets; nothing is added to the page.
- `css-swap.ts` (S54, decision 0040) — a save of only linked `.css` files replaces those stylesheets' text in place
  (`CSS.setStyleSheetText` over the page guard's protocol session, DOM domain borrowed from the element picker's
  counter); no page script, no DOM change, no navigation. Anything else (HTML/JS in the save, `@import`, an iframe, a
  syntax error, a failure) is the S14.2 full reload, and the status (`saveUpdate`) says which happened and why.
