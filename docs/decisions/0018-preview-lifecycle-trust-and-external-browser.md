# 0018 — Preview lifecycle, trust, refresh and the external-browser grant

- **Status:** accepted
- **Date:** 2026-10-15
- **Feature:** S14.1–S14.6, S15.4

## Context

PLAN §8 asks for an explicit preview lifecycle (stopped, starting, running, refreshing, unresponsive, failed),
consent before an opened folder's scripts run, separate storage per project with a way to clear it, and a server
that never outlives its project. PLAN §3 asks for automatic refresh after a successful save and for "open in an
external browser". Decision 0009 left two things open: how runtime records are attributed to a page load (needed by
S16.3), and how an external browser can reach a server that requires a header only the preview session adds.

## Options considered

1. **State as ad-hoc fields in the preview manager** (as before) vs **a pure state machine**. The ad-hoc version had
   transition rules spread over event handlers and could not be unit-tested without Electron.
2. **Trust in `.noobide/project.json`** vs **trust in app data**. A project file is shared with the folder (copied,
   zipped, downloaded), so a downloaded project could declare itself trusted. App data stays on this machine.
3. **Refresh on every save** vs **refresh after a save and a typing pause**. With autosave every second, refreshing
   on each save reloads the page under the user's fingers and wipes what they typed into it.
4. **External browser**: (a) drop the token check for a while — any local program could read the project;
   (b) put the token in the URL — it would end up in browser history and could be replayed; (c) a **one-time grant**
   that sets an HttpOnly, SameSite=Strict cookie (chosen).
5. **One server per open project, owned by the window that started it** vs a global server pool. The workbench
   opens one project per window; a registry keyed by project id with an owner check is the smallest thing that keeps
   servers from leaking across switches, closes and windows.

## Decision

- **State machine** (`src/preview/state-machine.ts`, pure). `PreviewManager` feeds it events and publishes the result
  as `PreviewStatus`. Events that do not apply are ignored (same object returned, nothing sent).
- **Generation** (interface for S16 runtime diagnostics): `PreviewStatus.generation` is a page-load counter. It
  increases by 1 on every Start, on every refresh (automatic, toolbar or ⌘R/Ctrl+R command) and on every main-frame
  navigation the page makes itself while running (link, form, `location.href`). It never decreases and is not reset by
  Stop, so it is unique per app run: a record captured during generation N belongs to exactly one page load, and any
  record with a lower generation than `getStatus().generation` is stale. The initial load and Chromium's error page
  after a failed load do not add a generation. Read it in main with `preview.getStatus().generation`; the workbench
  receives it in every `status` event and the e2e hook (`debugInfo().generation`).
- **Trust (S14.4)**: `<userData>/preview.json` holds SHA-256 hashes of trusted real project roots (no path text, at
  most 500, oldest forgotten first). `preview:start` carries `trigger: 'user' | 'auto'` (absent = user). An `auto`
  start of an untrusted folder is refused with `not-trusted` before anything runs; a `user` start records trust.
  Projects created from built-in templates are trusted at creation (main, create-project handler). The workbench
  offers an `auto` start once per opened project and otherwise shows the consent explanation with "Start preview".
- **Refresh mode (S14.2)**: stored by the S13.2 module as `preview.autoRefresh` (absent = automatic, `false` =
  manual); `src/preview/project-options.ts` is the only mapping, so a later schema change to `preview.refresh` is
  local. Automatic: `RefreshScheduler` refreshes after a confirmed save once no key was typed in the code editor for
  400 ms (the workbench reports typing, throttled to one message per 150 ms). Manual: the status gets
  `outdated: true` and the pill says "saved changes not shown" until the next refresh. The note "refreshing clears
  the page's state" is shown on the first refresh and remembered in `preview.json` once dismissed.
- **Entry page (S14.3)**: the toolbar lists the project's `.html`/`.htm` pages (breadth-first, ignored names as in the
  file tree, links not followed, bounded) and writes the choice through the S13.2 module (`index.html` = no entry).
- **Storage (S14.5)**: unchanged partition per project (`persist:noobide-preview-<sha256(root)>`). "Clear preview
  data" clears that partition's storage and HTTP cache only, then reloads the page if it is showing.
- **Server lifecycle (S14.6)**: `ServerRegistry` holds at most one server per project, owned by
  `{ projectId, windowId }`. A second acquire by the owner returns the same server; one from another window is
  refused (`NotOwnerError`). Opening (switching to) a project releases every other project's server; closing a
  project releases its server. IPC: `stop`, `reload`, `setBounds`, `clearData`, `openExternal`, `devTools` are refused
  with `not-owner` when the sender window did not start the preview or names another project.
- **External browser (S15.4)**: `PreviewServer.grantExternal(path)` issues a 256-bit one-time token valid for 60 s
  (stored hashed, at most 16 pending). `GET /.noobide-grant/<token>` (a dot path, so it can never shadow a project
  file) is redeemed only for a top-level visit the user started (`Sec-Fetch-Site: none` or absent); it sets
  `noobide-preview-<port>=<cookie secret>; HttpOnly; SameSite=Strict; Path=/` and redirects to the page. That cookie
  is accepted instead of the header. Host, `Sec-Fetch-Site`, GET/HEAD, the realpath guard and dotfile denial still
  apply to every request. A new server has new secrets. The grant URL goes from main straight to
  `shell.openExternal`; it never reaches the renderer or a log.
- **Toolbar commands (S15.4)**: `preview-refresh` (⌘R / Ctrl+R), `preview-stop`, `preview-open-external`,
  `preview-devtools`, `preview-clear-data` are S24 registry commands; the first three are in the native View menu,
  DevTools and Clear preview data are under the pane's Advanced disclosure. Every toolbar element and notice is in
  the layout flow above the stage, so the native preview view never covers it.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- Cookies are not port-specific in browsers: another local web service on 127.0.0.1 that the user visits in the same
  browser receives the cookie, and a process that can bind a loopback port but cannot read the user's files (another
  OS account, a sandboxed app) could replay it outside a browser until the server stops. Web pages cannot use it
  (`Sec-Fetch-Site`, SameSite=Strict). Mitigations: the cookie has `Max-Age` 8 h and dies with the server's secrets
  on Stop/switch/close/quit. A per-server host name (`p<port>.localhost`) would scope it fully; not done in v1
  because Host checking and `*.localhost` resolution in every browser would need validating first.
- The registry counts acquires per owner (leases): overlapping starts of one project share one server, a superseded
  start only gives back its lease, and Stop / project switch / close / window close shut the server down at once.
  A failure while attaching the view releases the server and reports `server-failed`.
- Other preview IPC (`options`, `setRefreshMode`, `typing`, `clearData` with no live preview) is checked for the
  workbench sender and an open projectId (an unguessable id held by the window that opened it) but not for a specific
  window — intentional in v1, which opens one project per window.
- Opening in the external browser grants that browser profile access to the project until the server stops (Stop,
  project switch or close, app quit).
- Trust is per folder path: a moved or copied project asks again. Clearing app data forgets all trust.
- Only one embedded preview view exists at a time; a start from another window replaces it (its own server is
  separate), while stop/refresh/bounds from a non-owner window are refused.
- Verified on macOS arm64 by `src/preview/state-machine.test.ts`, `server-registry.test.ts`,
  `refresh-scheduler.test.ts`, `src/main/preview-ipc.test.ts`, `src/renderer/workbench/preview-toolbar.test.ts`,
  `tests/integration/preview-lifecycle.test.ts`, `preview-external.test.ts`, `preview-store.test.ts`,
  `preview-options.test.ts`, `entry-pages.test.ts` and `tests/e2e/preview-manager.spec.ts`. The same suites run on
  Windows x64 (dev machine / CI, S06).
