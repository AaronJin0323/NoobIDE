# 0004 — Desktop stack and pinned versions

- **Status:** accepted
- **Date:** 2026-10-14
- **Feature:** S02.1

## Context

PLAN §5 prefers Electron + React + TypeScript + Monaco packaged with an established tool, with versions pinned when
development starts and real packaged builds validated on both platforms in weeks 2–3. Session 0 pinned the toolchain
(TypeScript 6.0.3, Vitest 5.0.4, ESLint 10, Vite 8.3.4) and left the runtime stack to S02.

## Options considered

- **Packaging:** Electron Forge 8 (official, Vite plugin, Squirrel/DMG/ZIP makers, fuses plugin) vs electron-builder
  (more features, third-party, larger config surface). Forge matches PLAN §5's suggestion and the Electron docs.
- **Bundler:** Forge's Vite plugin (Vite 8 / Rolldown, already in the toolchain) vs Webpack plugin. Vite chosen.
- **Monaco loading:** the `monaco-editor` ESM build bundled by Vite with `?worker` imports vs a Monaco loader from a
  CDN (forbidden: offline-first) vs `@monaco-editor/react` (defaults to a CDN loader; extra indirection). Direct ESM.
- **Electron patch level:** 44.7.2 was published hours before this session; 44.7.0 (2026-10-07) is the newest patch
  that is a week old. Supply-chain caution wins for now; bump patches deliberately (see Consequences).

## Decision

Exact versions (no `^`/`~`), all pure JS/TS — no native modules:

| Package                                                                  | Version | Role                                                            |
| ------------------------------------------------------------------------ | ------- | --------------------------------------------------------------- |
| electron                                                                 | 44.7.0  | Desktop host (Chromium + Node), arm64 and x64 binaries upstream |
| @electron-forge/cli, plugin-vite, plugin-fuses, maker-squirrel/-dmg/-zip | 8.0.1   | Build, package, installers (Windows Squirrel, macOS DMG, ZIP)   |
| @electron/fuses                                                          | 2.1.3   | Fuse constants used by forge.config.ts                          |
| react, react-dom                                                         | 19.3.0  | Workbench UI                                                    |
| monaco-editor                                                            | 0.57.0  | Editor; HTML/CSS/JS/JSON languages and their workers, bundled   |
| @vitejs/plugin-react                                                     | 6.1.2   | JSX transform for Vite 8                                        |
| @playwright/test                                                         | 1.64.0  | Electron e2e (`_electron`), no browser downloads needed         |
| @types/react, @types/react-dom                                           | 19.3.0  | Types                                                           |

Layout follows PLAN §6: `src/main/main.ts` (entry), `src/preload/preload.ts`, `src/renderer/` (Vite root,
`index.html`, `main.tsx`), platform conventions in `src/platform/`. Build output: `.vite/build/{main,preload}.cjs`
and `.vite/renderer/main_window/`; `package.json#main` points at `.vite/build/main.cjs`.

Monaco is imported through its tree-shakeable 0.56+ entry points (`monaco-editor/editor` plus the html/css/
javascript/typescript definitions and the css/html/json/typescript language features), not the all-languages bundle.

The Windows Squirrel startup handling (`--squirrel-install` etc.) is implemented in `src/platform/squirrel.ts` instead
of depending on `electron-squirrel-startup` (30 lines, would pull in an old `debug@2`).

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- Linux (cloud workspace) evidence for S02: `npm run package` builds; packaged self-test and dev self-test pass
  (Monaco workers answer); `npm run test:e2e` 8/8. Windows x64 installer + launch and macOS arm64 builds are still
  unproven: `harness/MANUAL-CHECKS.md#S02.7` (Windows, owner) and S06 (CI matrix + physical Mac).
- `package-lock.json` is still generated on the Windows machine and committed from there (session 0 decision).
- Patch bumps of Electron within 44.x are routine maintenance (half-day weekly budget, PLAN §10): bump, run
  `npm run verify -- --e2e` and the self-test on both platforms. A major Electron bump needs a new decision (minimum
  OS versions may change — see 0003 / H.1).
- TypeScript stays at 6.0.3 (typescript-eslint support), unchanged from session 0.
