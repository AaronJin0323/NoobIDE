# 0005 — Workbench security baseline

- **Status:** accepted
- **Date:** 2026-10-14
- **Feature:** S02.2 (also S02.1, S02.4)

## Context

PLAN §8 and AGENTS.md require a restricted, isolated renderer and an offline-first workbench. The Electron security
checklist adds: sandbox every renderer, define a CSP, restrict navigation and new windows, deny permissions by
default, prefer a custom protocol over `file://`, and flip unneeded fuses. This decision covers the **trusted
workbench**; the user-page preview gets its own, stricter setup in S04 (no preload, per-project partition).

## Decision

1. **webPreferences** come from one pure factory, `src/main/window-options.ts`: `contextIsolation: true`,
   `nodeIntegration: false` (also in workers and subframes), `sandbox: true`, `webSecurity: true`,
   `allowRunningInsecureContent: false`, `webviewTag: false`, `navigateOnDragDrop: false`. A unit test pins every
   key, and main refuses to open the window if any required value is weakened (`insecurePreferences`).
2. **Custom protocol.** Production UI is served from `noobide://app/` (standard + secure scheme) by a GET/HEAD-only
   handler that resolves paths inside the renderer build directory and refuses traversal
   (`src/main/app-asset.ts`). Consequently the `GrantFileProtocolExtraPrivileges` fuse is off.
3. **CSP** (`src/main/csp.ts`) is sent as a response header: `default-src 'none'`, scripts and workers only from
   `'self'`, no `unsafe-eval`, no inline scripts, no remote origins, `object-src`/`frame-src`/`frame-ancestors`/
   `base-uri`/`form-action` `'none'`. `style-src` allows `'unsafe-inline'` because Monaco injects `<style>` at
   runtime. Development adds only what Vite's dev server needs (inline React-refresh preamble, HMR websocket).
4. **Runtime guards** (`src/main/harden.ts`): window-open denied, navigation/redirect away from the app origin
   prevented, `<webview>` attachment prevented, all permission requests and checks denied, and a **network guard**
   that cancels every http(s)/ws(s) request from the workbench session except the dev server in development. This
   makes "no CDN" structural rather than a convention; blocked requests are recorded as origin + type only.
5. **Fuses** at package time: RunAsNode off, NODE_OPTIONS off, `--inspect` CLI off, cookie encryption on, embedded
   ASAR integrity validation on, only load app from ASAR.
6. **Preload** is sandboxed and exposes only a frozen placeholder (`window.noobide.apiVersion`) until S03.1 adds the
   typed, validated IPC API.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- Because the inspect fuse is off, Playwright cannot attach to the _packaged_ binary. E2E runs the same production
  bundles with the stock Electron binary; the packaged binary is checked with the built-in self-test
  (`NOOBIDE_SELF_TEST=1`, `npm run selftest:packaged`), which proves workers load from `noobide://` in the shipped app.
- Evidence: unit tests (`window-options`, `csp`, `app-asset`, `self-test`) and e2e
  (`tests/e2e/smoke.spec.ts`: no `require`/`process` in the renderer, inline script blocked with a
  `script-src-elem` violation, live webPreferences, CSP header present, zero blocked network requests).
- Any change to these settings needs a new decision record that supersedes this one.
- Open items: the preview's own isolation (S04/S05), IPC sender validation (S03.1), signing (S28).
