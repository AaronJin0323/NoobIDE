# src/platform — macOS / Windows adapters

The **only** place allowed to read `process.platform` (enforced by ESLint). Menus, shortcuts and modifier labels,
window conventions, reveal-in-OS labels, filesystem quirks (case sensitivity, reserved names), app-data locations.

S24: `keybindings.ts` renders and matches the command registry's per-platform shortcuts (`⌘S` / `Ctrl+S`);
`menu-template.ts` builds each platform's native menu bar from it (decision 0014).
