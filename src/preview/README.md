# src/preview — static server and preview lifecycle

Loopback-only static server confined to the project root (realpath checks, GET/HEAD only, Host check), preview
state machine, WebContentsView creation with sandboxing and per-project partitions (PLAN §8).

Network and page guards (decisions 0015, 0016): `preview-proxy.ts` + `address-policy.ts` — every request of the
preview session goes through a SOCKS5 proxy in main that allows only the project server (`127.0.0.1:<port>`) and
public internet addresses, deciding on the resolved address; `page-guard.ts` — a script installed over the DevTools
protocol before page scripts (pages, iframes, workers) that rate-limits the console and reports `alert()`.

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
