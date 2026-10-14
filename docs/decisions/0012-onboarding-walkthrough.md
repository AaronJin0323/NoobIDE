# 0012 — Onboarding walkthrough: detected steps, app-data progress, lessons as bundled JSON

- **Status:** accepted
- **Date:** 2026-10-15
- **Feature:** S23.1–S23.4

## Context

PLAN §2 asks for a ten-minute learning cycle inside a real project that can be skipped or revisited, followed by an
unguided task whose completion is checked, plus short terminology explanations (PLAN §6 `resources/lessons`). The
walkthrough has to survive an app restart (its last step _is_ "close and reopen"), must not cover the native preview
view, and must not claim a step is done unless the user really did it.

## Options considered

1. **Progress in settings.json** — fewer files, but settings are user preferences with a strict patch schema; the
   walkthrough holds progress and baselines that change often.
2. **Separate `walkthrough.json` in app data with its own two IPC channels** — isolated, validated on its own.
3. **Floating coach-mark bubbles next to each anchor** — the native preview `WebContentsView` draws over any HTML on
   the right half, and a floating bubble can intercept clicks meant for the tree or the editor.
4. **A strip in the layout flow** (between the workbench and the status strip) with a dashed outline on the anchor.

## Decision

- Progress lives in `<userData>/walkthrough.json` (`src/main/walkthrough-store.ts`, atomic writes, corrupt file
  backed up, invalid fields reset one by one) behind `walkthrough:get` / `walkthrough:save`
  (`src/shared/ipc/walkthrough-contract.ts`, sender + strict payload check). The state holds step ids, statuses and
  short baseline signatures only — never file contents or paths.
- A step is marked done only by detection from real state (`src/renderer/walkthrough/detect.ts`): the open project
  and tabs, the problems list, the file on disk after each confirmed save compared with the baseline captured when the
  step began, a finished local-history restore, and — for "reopen" — a new app run that started on that step. Next is
  always available (skip) but never marks a step done.
- The panel is an in-flow strip (option 4); the anchor gets a dashed outline and the step also says _where_ in words.
- Help entries (walkthrough, glossary) are items of the existing top-bar menu until the S24 command registry provides
  a Help menu; the walkthrough starts by itself only after the first project is created with the wizard.
- Lesson texts (steps, final task, glossary) are JSON in `resources/lessons`, zh-CN + en per string, imported into the
  renderer bundle (offline). Glossary entries keep the standard English term verbatim in every locale.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- Unit: `src/shared/walkthrough.test.ts`, `src/renderer/walkthrough/*.test.ts`; integration:
  `tests/integration/walkthrough-store.test.ts`; e2e: `tests/e2e/walkthrough.spec.ts` (Chinese + spaces paths).
  Run on macOS arm64 in development; Windows x64 runs the same suites in CI / on the dev machine.
- The S24 command registry should take over `help-walkthrough` / `help-glossary` (Workbench `menuItems`).
- The "deliberate error" step relies on the existing problems list and problem details (S17/S19); the suggested
  checks on the card arrive with S22.4 and need no walkthrough change.
