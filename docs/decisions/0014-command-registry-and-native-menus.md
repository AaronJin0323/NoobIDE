# 0014 — One command registry for shortcuts, the in-window menu and the native menus

- **Status:** accepted
- **Date:** 2026-10-15
- **Feature:** S24.1, S24.2

## Context

PLAN §3 asks for "a shared command system" that maps shortcuts per platform (⌘S / Ctrl+S) with the right symbols in
menus and hints, a macOS system menu and the Windows convention of quitting with the last window. Before S24 the
workbench handled keys ad hoc in `Workbench.tsx`, and Electron's default menu (English, with Reload and a whole-window
zoom) was active on both platforms. Two things could handle one key press: the page and a native menu accelerator.

## Options considered

1. **Native menu owns the shortcuts** (accelerators registered, renderer listens to menu events only). Simple, but
   keys typed in the page reach the page first on both platforms, Monaco handles some of them (⌘S) itself, and the
   preview (a separate WebContentsView) would also have to be covered by menu accelerators on Windows.
2. **Renderer owns the shortcuts, native menu displays them** — chosen.
3. Global shortcuts (`globalShortcut`) — no: they fire when the app is not focused.

## Decision

- `src/shared/commands.ts` is the registry: id, i18n label key, `when` clause over a small boolean context
  (`hasProject`, `hasActiveTab`, `modalOpen`) and a per-platform keybinding written once with `primary` (⌘ / Ctrl).
  `src/platform/keybindings.ts` renders (`⌘S` / `Ctrl+S`), matches key presses and builds Electron accelerators;
  `src/platform/menu-template.ts` builds each platform's menu bar from the registry (macOS application and Window
  menus, ⇧⌘W closes the window because ⌘W closes the tab; Windows File ends with Exit).
- The renderer resolves every key press through the registry in the capture phase and runs the command when it
  applies (`preventDefault` + `stopPropagation`). Unbound or non-applying keys are left alone.
- Native menu items show the accelerator. On Windows/Linux it is not registered (`registerAccelerator: false`). On
  macOS a key the page did not handle may reach the menu as a key equivalent; main ignores such an
  accelerator-triggered click while the workbench page has the focus and forwards it otherwise (e.g. ⌘S while the
  preview has the focus). Mouse choices are always forwarded to the renderer by id (`app:run-command`).
- The renderer reports its command context over `app:set-command-context` (sender-checked, exact-key boolean
  payload); main enables menu items from it. Main translates the menus with the renderer's i18n catalogs
  (`src/renderer/i18n`, pure data) in the interface language from settings, and rebuilds them when it changes.
- No Reload item (it would discard editor state); the developer-tools toggle only in development builds.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- New commands are added in one place and get hints, menus and keys on both platforms.
- Unit tests render both platforms' menus and labels on any machine (`src/platform/*.test.ts`,
  `src/main/app-menu.test.ts`, `src/main/window-lifecycle.test.ts`); e2e `tests/e2e/commands.spec.ts` and
  `tests/e2e/menus.spec.ts` ran on macOS arm64. The real menu bar, dock reactivation and Windows' quit-on-last-close
  are in `harness/MANUAL-CHECKS.md#S24.2`.
- Main's bundle includes both message catalogs (small).
