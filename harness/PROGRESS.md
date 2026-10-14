# Progress log

Newest entry first. Every session appends one entry using the template at the bottom. `session.mjs start` shows
the latest entry to the next session, so write it for a reader with zero context.

## Session 3 — 2026-10-14 — UI prototype, quick-fix backlog item, prototype shell (S30)

**Agent:** Claude (Opus 5.5) on the Windows x64 dev machine, Node 22.22.2.

**Done**

- Owner-requested UI prototype (design canvas, outside the repo): welcome, create wizard, workbench, problem
  card, narrow window and state vocabulary, restyled after feedback into a dark “studio” look.
- Added **S22.5 — One-click fix for a misspelled name** (owner-approved from the prototype).
- Owner asked to implement the prototype. Added session **S30 — Visual foundation from the UI prototype** (M2,
  depends on S02) and completed it:
  - S30.1 colour tokens (`src/renderer/theme/tokens.ts`), dark/light following the system scheme, contrast test.
  - S30.2 Monaco themes from the same tokens, synced with the shell.
  - S30.3 shell: app mark + project identity, labelled rail (Files, Problems), rounded panels, status strip with
    collapsible Problems, honest placeholder states (sample badge, preview 未运行, problems 还没检查).
  - S30.4 narrow window (< 960px): files collapse into a drawer, Code / Preview switch.

**Evidence:** `npm run verify` green (harness, typecheck, lint, format, 83 unit tests). `npm run test:e2e` on
Windows x64: 16/16 (new `tests/e2e/shell.spec.ts` + unchanged smoke and worker specs). The contrast test caught
light-theme line numbers at 4.40:1 (fixed). Screenshots during review caught a real bug: re-creating the editor on
a language switch used the start-up theme (light Monaco in a dark shell); fixed, with a regression e2e that fails
without the fix. S02.6's e2e now also passes on Windows; its macOS run is still outstanding, so status unchanged.

**Decisions:**

- Only what works is shown. Unlike the prototype, the shell has no command bar, coach card, history/lessons rail
  items, welcome screen or help/more-tools buttons yet — each needs its feature first (S20, S21, S23, S24). The
  disabled Preview/Help/More-tools buttons were removed (assessment: no working-looking placeholders).
- System fonts, not the prototype's Geist (offline invariant; bundling a font would need a decision record).
- Dark unless the system asks for light. A persisted theme choice stays with S24.4.
- The native window frame is kept; merging it into the top bar needs main-process work and per-platform checks.
- S30.4 overlaps S15.2: S30.4 is layout only; S15.2 must still move the WebContentsView with the switch.
- The one-click fix is deterministic (did-you-mean rule output), not AI, so it stays within PLAN §4 exclusions.

**Problems / risks:** Not run on macOS. Panel widths are fixed until splitters (S15.1). The empty-state copy says
opening folders “arrives in a later version” and must be updated when S07/S20 land.

**Owner action needed:** Decide whether the command bar and coach card become backlog items. Run the new e2e on a
Mac when one is available (same command: `npm run test:e2e`).

**Next up**

1. Formal current session is still S01 (S01.4 waits on H.1). If the owner prefers to keep building the
   interface, the natural next steps are S03 (real files) feeding the shell's files panel and save status.

## Ideas / backlog candidates (Session 3)

- Command bar “找文件、命令或帮助… Ctrl K”; coach card for step-by-step lessons (S23).
- Merge the window title bar into the top bar (needs platform work and manual checks).

## Session 2 — 2026-10-14 — Interface assessment and design direction

**Agent:** Codex on the Windows x64 dev machine, Node 22.22.2.

**Done**

- S01.5 — Owner-requested appearance and beginner-usability assessment in
  `docs/reviews/interface-assessment-2026-10-14.md`. Added the review feature without changing existing criteria.
- Inspected the actual React/Monaco renderer in headless Edge at 1280×800 (light/dark) and 640×480.
  Confirmed the 176px empty Problems region, a white Monaco surface in dark mode, and a 210px narrow editor.
- Proposed a shared visual foundation, welcome/workbench/error states, implementation order, and observable
  acceptance checks. Prepared an interactive concept in the chat; application source remains unchanged.

**Evidence:** Review checked against all three S01.5 criteria and PLAN §§2, 3, 9, 11; relative source links
resolve. Baseline and closing `npm run verify` pass: harness, typecheck, lint, formatting, 42 tests in 9 files.
Ignored inspection artifacts: `test-results/interface-audit/current-{light,dark,narrow}.png`.

**Decisions:** This is design guidance, not implementation or evidence of beginner task success. Recommend
establishing typography, spacing, control hierarchy, and shared shell/Monaco themes before expanding the UI.
Connect functional states as the existing backlog delivers files, saving, preview, diagnostics and recovery.

**Problems / risks:** Native Electron launch did not stay open in this tool session; renderer inspection does
not establish native-frame behavior or macOS compatibility. Existing untracked `.idea/`, `CLAUDE.md` and
`package-lock.json` were left untouched. No redesign feature or platform check has been marked complete.

**Owner action needed:** None for this assessment. Existing H.1 minimum-platform decision still gates S01.4;
existing H.3 beginner wireframe review remains open.

**Next up**

1. For the proposed redesign, implement shared visual tokens and synchronized editor themes, then integrate
   welcome, responsive workbench and honest status states as described in the review.
2. Formal current session remains S01, with S01.4 waiting on H.1. Preserve the existing technical-spike gates
   and platform checks when scheduling design implementation.

---

## Session 1 — 2026-10-14 — Git, scope docs, wireframes, secure Electron shell

**Agent:** Claude (cloud workspace, Linux x64, Node 22.22; no shell on the Windows machine — files written back to
`D:\NoobIDE`, git history handed over as `noobide.bundle`, see Owner action)

**Done**

- S00.2 — Git initialised (`main`), LF policy checked: `git ls-files --eol` all `i/lf w/lf`. `PLAN.md` had mixed
  CRLF/LF on disk; it is stored LF (content unchanged).
- S01.1 — `docs/product/scope.md`: audience, in-scope table, 16 exclusions each linked to its PLAN section, support
  matrix (minimum OS versions TBD → H.1).
- S01.2 — `docs/product/task-script.md`: the 8 PLAN §2 steps with facilitator prompts, expected IDE feedback and
  pass conditions; metrics M1–M5 (PLAN §11 beginner metrics) mapped to steps with measurement methods; hints,
  unguided follow-up task, recording sheet.
- S01.3 — `docs/wireframes/` (open `index.html`): welcome + create wizard, editor+preview (wide and narrow with a
  working Code/Preview switch), problem card (PLAN §9 example, original error, uncertain cause, unresponsive page).
  zh-CN copy, English notes under each screen, no external assets.
- S02.1–S02.5 — Electron 44.7.0 + Forge 8.0.1 (Vite) + React 19.3 + Monaco 0.57 scaffold (decision 0004):
  `src/main/main.ts`, sandboxed preload placeholder, React shell with the five regions, zh-CN/en i18n with
  session-persisted switch, Monaco bundled locally with HTML/CSS/JS/JSON workers.
- Security baseline (decision 0005): webPreferences factory + startup assertion, UI served from `noobide://app/`
  (custom protocol, path-guarded) instead of file://, CSP response header (no eval / inline scripts / remote
  origins), window-open/navigation/webview/permission denial, a network guard that blocks every http(s)/ws(s)
  request from the workbench, fuses (RunAsNode, NODE_OPTIONS, --inspect off; ASAR integrity on).
- S02.6 — Playwright Electron e2e (`npm run test:e2e`, 8 tests) — **needs_manual_check** for Windows/macOS runs.
- S02.7 — Squirrel/DMG/ZIP makers configured; Squirrel install events handled in `src/platform/squirrel.ts` —
  **needs_manual_check** (build + install on Windows).

**Evidence:** `npm run verify -- --e2e` green @ 0c43853: harness, typecheck, lint, format, 42 unit tests (9 files),
e2e 8/8 (Linux under xvfb). `npm run selftest:packaged` and `npm run selftest:dev` pass (CSS + TS workers answer in
~1 s). Wireframes rendered offline with Playwright: 0 non-file requests, 0 console errors, switch works.

**Decisions**

- 0004 stack versions: Electron pinned to 44.7.0 rather than 44.7.2 (published hours earlier) — bump patches
  deliberately. Monaco via its 0.56+ tree-shakeable entry points. No `electron-squirrel-startup` dependency.
- 0005 workbench security baseline (above). Because the `--inspect` fuse is off, e2e drives the production bundles
  with the stock Electron binary; the packaged binary is checked by the built-in self-test (`NOOBIDE_SELF_TEST=1`).
- `package-lock.json` still not committed (generate on Windows, session 0 decision). It is git-ignored nowhere;
  the cloud clone excluded it locally.
- Refinement, not a backlog change: S02.3 placeholders already use the i18n dictionaries.

**Problems / risks**

- Nothing has run on Windows or macOS yet. The first Windows run (MANUAL-CHECKS S02.7) may surface
  platform-specific issues (paths with spaces in scripts, Squirrel, SmartScreen for the unsigned installer).
- `getLastWebPreferences()` used by one e2e assertion is missing from electron.d.ts (cast); if Electron removes it
  the test fails loudly — the unit test on the factory remains the primary evidence.
- S01.4 is blocked by H.1 (minimum OS versions). Electron 44's own minimums are the floor.
- `eslint-plugin-react-hooks` is not installed yet; consider adding it in S09 when hooks get complex.

**Owner action needed**

1. Adopt the git history (D:\NoobIDE has none yet). In a terminal in `D:\NoobIDE`:
   `git init -b main`, `git fetch noobide.bundle main`, `git reset --hard FETCH_HEAD`, then `git status` should be
   clean apart from two leftover untracked files, `docs/wireframes/.gitkeep` and `scripts/.gitkeep` (delete them). Then delete the bundle.
2. `npm install`, commit the generated `package-lock.json`, `npm run verify -- --e2e`.
3. Run harness/MANUAL-CHECKS.md → S02.7 (Windows installer) and S02.6.
4. Owner tasks now unblocked: H.1 (unblocks S01.4), H.2, H.3 (walk beginners through `docs/wireframes/`), H.4, H.5.

**Next up**

1. S03 — restricted IPC + open/save a real file: S03.1 typed IPC contract in `src/shared/ipc` (replace the
   preload placeholder `window.noobide.apiVersion`), S03.2 extend `src/platform` (isMac/isWindows, modifier and
   reveal labels; add an ESLint rule fixture), then S03.3/S03.4 file open/save in a `中文 路径` path.
2. S01.4 after H.1. S02.6/S02.7 after the owner's Windows run.

**Ideas / backlog candidates:** a `npm run dev:selftest` CI job once S06 exists; bundle a CJK-capable UI font
(offline) in S24 instead of relying on system fonts.

---

## Session 0 — 2026-10-14 — Plan structured, harness built

**Agent:** Claude (cloud workspace, files handed back to `D:\NoobIDE`; no shell on the Windows machine)

**Done**

- S00.1 — Read PLAN.md and turned it into 9 milestones, 30 sessions, 129 agent features and 8 owner tasks
  (`harness/features.json`, `docs/ROADMAP.md`).
- Harness: `AGENTS.md` (session protocol + invariants), `CLAUDE.md`, `harness/session.mjs` (start/status/next/show/
  set/check with dependency checks and a tamper guard against the last commit), `harness/verify.mjs` (all gates).
- Toolchain skeleton: TypeScript 6.0.3 (strict), Vitest 5.0.4, ESLint 10 + typescript-eslint 8.71 (with the
  `process.platform` restriction outside `src/platform`), Prettier 3.9, `.gitattributes` LF policy, PLAN §6 folders
  with module READMEs, `src/shared/result.ts` + tests.

**Evidence:** `npm run verify` green in the cloud workspace (Linux, Node 22.22): harness, typecheck, lint, format,
5 unit tests.

**Decisions**

- TypeScript pinned to 6.0.3, not 7.0 — typescript-eslint 8.71 supports `<6.1`. Revisit when it supports 7.
- No `package-lock.json` committed yet: generate it on the Windows machine with the first `npm install` and commit
  it (avoids cross-platform optional-dependency gaps in a Linux-generated lockfile).
- Electron/Forge/React/Monaco are deliberately not installed yet; S02 picks and pins them with a decision record.
- Status changes go through `session.mjs set`; features can be superseded, never deleted or weakened.

**Problems / risks**

- Not yet run on Windows. First Windows session must run `npm install` + `npm run verify` and fix anything
  platform-specific.
- S06.1 needs a GitHub repository (H.5); S01.4 needs minimum OS versions (H.1).

**Next up**

1. S00.2 — `git init`, commit, verify the LF policy (`git ls-files --eol`).
2. S01 (scope docs + wireframes) and S02 (Electron scaffold) can run in either order or in parallel.
3. Owner: H.1, H.2, H.4 are unblocked now.

---

<!-- Template — copy above the previous entry. Indented here so the CLI does not treat it as an entry.

    ## Session <N> — <YYYY-MM-DD> — <short title>

    **Agent:** <who / where it ran (Windows dev machine, cloud, Mac)>

    **Done**
    - <feature id> — <what changed, key files>

    **Evidence:** <tests / commands / docs proving the acceptance criteria; verify result>

    **Decisions:** <choices made + link to docs/decisions/NNNN if significant>

    **Problems / risks:** <what broke, what is fragile, what is unverified>

    **Owner action needed:** <manual checks, owner tasks, questions>

    **Next up**
    1. <the next feature(s) to pick up and any context needed>

    **Ideas / backlog candidates:** <out-of-scope ideas, not built>
-->
