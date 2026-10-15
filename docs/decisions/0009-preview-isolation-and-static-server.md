# 0009 — Preview isolation and the loopback static server

- **Status:** accepted; network policy amended by 0015 (resolved-address proxy, dialogs, beforeunload, service
  workers)
- **Date:** 2026-10-14
- **Feature:** S04.1, S04.3, S05.1, S05.2, S05.5

## Context

PLAN §8 requires that the user's page runs with none of the IDE's permissions, that the project is served only from
loopback and only from inside the project, and that a hung page can always be stopped. A random port is not access
control: any local program or any browser tab could otherwise read the project (or more) from the server.

## Options considered

1. **Custom protocol (`protocol.handle`) per partition** instead of HTTP. No port at all, but ES modules, `fetch`,
   service workers, relative URLs and "open in external browser" behave differently from a real web server, and
   beginners' pages should behave as they will when published.
2. **Loopback HTTP server, ownership by a secret path prefix** (`/<token>/index.html`). Breaks root-absolute URLs
   (`/css/style.css`), which beginners use.
3. **Loopback HTTP server, ownership by a request header added by the preview session** (chosen).

## Decision

- `src/preview/static-server.ts`: Node `http` (no dependency), bound to `127.0.0.1` on a free port (the project's
  previous port is reused when free, so the page keeps its origin and therefore its localStorage), GET/HEAD only.
  Every request must have `Host: 127.0.0.1:<port>` (DNS rebinding) and the per-server 256-bit secret in
  `X-NoobIDE-Preview`, compared in constant time. Requests the browser marks `Sec-Fetch-Site: cross-site|same-site`
  are refused. Only the preview's own session adds the header (`webRequest.onBeforeSendHeaders` limited to the
  server origin), so other programs and browsers get 403 even if they know the port.
- `src/preview/request-path.ts`: two layers — a pure parser that rejects traversal (also percent-encoded), backslashes,
  NUL, `:` (drive letters, NTFS alternate data streams), Windows reserved characters and device names, empty segments
  and dotfiles; then the OS realpath (follows links and junctions, expands 8.3 short names such as `GIT~1`) must stay
  inside the real root and contain no dot segment. Files are served from one open handle: small files are read whole
  and closed at once, because Windows refuses to rename over an open file and the IDE's atomic save must not fail.
- `src/preview/preview-manager.ts`: one `WebContentsView` with **no preload**, `sandbox`, `contextIsolation`,
  `nodeIntegration: false`, `webSecurity`, and a persistent partition per project folder
  (`persist:noobide-preview-<sha256(root)>`, stored in app data). The preferences are asserted before creation.
  The session denies every permission and download. `window.open` is denied; top-level navigation and redirects off
  the server origin are blocked; `<webview>` is refused. Requests to `file:` and to every loopback address other than
  the server (`localhost`, `localhost.`, `127/8`, `0/8`, `[::1]`) are cancelled.
- Stop = `forcefullyCrashRenderer()` + `close()`: the only reliable way to end `while (true)`. Different sessions never
  share a renderer process, so a hung page never blocks the workbench renderer (e2e: pid check + typing).
- Hang detection: Chromium's `unresponsive` event needs pending input, so main also pings the page every second
  (`mainFrame.executeJavaScript('0')`); an answer missing for 3 s means `unresponsive`.
- An external project only runs after an explicit "Start preview" (PLAN §8).

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- ~~Known limit: a public DNS name that resolves to 127.0.0.1 (`*.nip.io`, `localtest.me`) cannot be recognised by
  hostname in `onBeforeRequest`.~~ Closed by 0015: every request of the preview session goes through a proxy that
  decides on the resolved address and connects to exactly that address.
- `Sec-Fetch-Site` refusal also blocks the user's own sandboxed (opaque-origin) iframes from loading project files.
- "Open in external browser" (S15) cannot reuse the header; it will need its own short-lived grant (for example a
  one-time token exchanged for a cookie).
- Verified on Windows x64 by `tests/integration/preview-server.test.ts`, `tests/e2e/preview.spec.ts` and
  `tests/e2e/preview-isolation.spec.ts`. The same suites must run on macOS arm64 (CI runner, S06) — see
  `harness/MANUAL-CHECKS.md#S04-S05-macos`.

## Amendment (2026-10-15, S25.4): permissions

Every permission request of the preview session is denied in main (`setPermissionRequestHandler`,
`setPermissionCheckHandler`, `setDevicePermissionHandler`, HID/serial/USB choosers cancelled, Bluetooth pairing
refused, `setDisplayMediaRequestHandler` shares nothing), so no OS prompt can appear. Web Bluetooth is switched off
for the preview (`disableBlinkFeatures: 'WebBluetooth'`, a required preview preference): on macOS
`navigator.bluetooth.requestDevice()` made Chromium open CoreBluetooth before any handler ran and the system killed
the whole IDE for a privacy violation (reproduced in the S25.4 e2e before the fix). The first denied request of each
kind per page load becomes a localised, non-blocking console notice (`src/preview/permission-policy.ts`). Verified by
`tests/e2e/preview-permissions.spec.ts` (fixture `预览 权限`) and `permission-policy.test.ts`.
