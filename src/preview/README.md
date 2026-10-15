# src/preview — static server and preview lifecycle

Loopback-only static server confined to the project root (realpath checks, GET/HEAD only, Host check), preview
state machine, WebContentsView creation with sandboxing and per-project partitions (PLAN §8).

Modules (S14, S15.4 — see docs/decisions/0018):

- `state-machine.ts` — pure preview state machine and the page-load **generation** (`PreviewStatus.generation`: +1 on
  every Start, refresh and page-initiated navigation; never decreases; records with a lower generation are stale).
- `server-registry.ts` — at most one loopback server per open project, owned by `{ projectId, windowId }`; released on
  project switch/close; `not-owner` for other windows.
- `refresh-scheduler.ts` — automatic refresh after a confirmed save and a typing pause.
- `entry-pages.ts`, `project-options.ts` — entry page picker and refresh mode (stored via the S13.2 project.json
  module).
- `static-server.ts` — also issues one-time external-browser grants (HttpOnly SameSite=Strict cookie).
