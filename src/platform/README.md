# src/platform — macOS / Windows adapters

The **only** place allowed to read `process.platform` (enforced by ESLint). Menus, shortcuts and modifier labels,
window conventions, reveal-in-OS labels, OS-specific error explanations and installer hooks.

- `index.ts` — platform id for main and preload (the renderer reads it from `window.noobide.platform`).
- `labels.ts` — `isMac` / `isWindows`, modifier and shortcut labels, "Reveal in Finder" / "Show in File Explorer"
  label keys (S03.2, S08.5).
- `keybindings.ts` — renders and matches the command registry's per-platform shortcuts (`⌘S` / `Ctrl+S`) (S24.1).
- `menu-template.ts` — each platform's native menu bar built from the command registry (S24.2, decision 0014).
- `protected-folders.ts` — recognises macOS privacy protection (TCC) and Windows Controlled Folder Access behind
  `EPERM` / `EACCES` (S25.3).
- `squirrel.ts` — Windows Squirrel install / update / uninstall events (S02.7, decision 0012).
- `os-info.ts` — OS facts for the log header (S13.6); main only.
- `power-events.ts` — which powerMonitor events and drift check mean "the computer woke" (S25.1/S25.2, decision 0028).

App-data locations are not decided here: main uses Electron's `app.getPath('userData')` (see `src/main/README.md`).
