# AGENTS.md — operating manual for coding agents on NoobIDE

You are continuing a long-running build. You have no memory of earlier sessions; this repository is the memory.
Read this file fully at the start of every session. It applies to any agent (Claude, Codex, Copilot, Junie…).

## What we are building

NoobIDE: a desktop IDE that lets first-time web developers create, edit, preview, debug and recover plain
HTML/CSS/JS projects on **Apple Silicon macOS (arm64)** and **Windows (x64)**. Stack: Electron + React + TypeScript +
Monaco. Product truth: [PLAN.md](PLAN.md). Build order: [docs/ROADMAP.md](docs/ROADMAP.md). Backlog:
[harness/features.json](harness/features.json). History: [harness/PROGRESS.md](harness/PROGRESS.md).

## Session protocol

### 1. Orient (≈5 minutes, every session)

```bash
npm install                      # if node_modules is missing or package.json changed
node harness/session.mjs start   # git state, last progress entry, milestone status, ready features
npm run verify                   # must be green BEFORE you change anything
```

- If `verify` is red, fixing it is the first task of the session. Do not build on a broken tree.
- If git is not initialised yet: `git init`, commit everything, then `node harness/session.mjs set S00.2 done --evidence "<hash>"`.
- Read the PLAN.md sections cited by the session (`plan_refs`) before designing anything.

### 2. Pick work

- Work on the **current session** shown by `start` / `node harness/session.mjs next`. Finish its features before
  starting another session unless the owner says otherwise.
- **One feature at a time.** Mark it `in_progress`, implement it, prove it, mark it done, then move on.
- If the owner asked for something specific, do that — and record it as a feature if it is new work.

### 3. Implement and prove

- Write the test first where practical. Unit tests sit beside the code (`foo.test.ts`); integration tests in
  `tests/integration/`; Electron e2e in `tests/e2e/` (Playwright). Fixtures in `tests/fixtures/`.
- A feature is **done only when every acceptance criterion is demonstrated**: a passing test, a command's output, or a
  produced document checked against the criterion. Screenshots or "it compiles" are not evidence.
- `verify` kinds:
  - `auto` — prove with automated tests you add.
  - `agent-check` — you produce the artifact (doc, measurement) and check it against the criteria.
  - `manual-win` / `manual-mac` — needs a real run on that platform. If you did not run it there, set
    `needs_manual_check` and append exact steps for the owner to `harness/MANUAL-CHECKS.md`.
  - `human` — owner tasks (H.x). Never mark these done yourself.
- Update status only through the CLI:

  ```bash
  node harness/session.mjs set S07.2 in_progress
  node harness/session.mjs set S07.2 done --evidence "tests/integration/tree.test.ts (8 tests) + verify green @ <commit>"
  node harness/session.mjs set S09.4 needs_manual_check --evidence "steps in harness/MANUAL-CHECKS.md#S09.4"
  node harness/session.mjs set S04.2 blocked --evidence "why, and what unblocks it"
  ```

### 4. Close the session (always, even if you stop early)

1. `npm run verify` is green. If a feature is half-done, either finish it, or leave it `in_progress` with the code
   behind a disabled path so verify stays green. Never leave failing tests.
2. Append an entry to the top of `harness/PROGRESS.md` using the template there: what was done, evidence,
   decisions, problems, and an explicit **Next up**.
3. Commit with a message like `S07.2: lazy directory tree model` (one commit per feature is ideal).
   Open pull requests as **drafts** and mark them ready for review only at the end of the session: CI runs the
   OS build matrix only for ready PRs (S50.1), so intermediate pushes cost one small ubuntu `static` job each.
4. Tell the owner, in a few lines: features completed, anything needing their action (owner tasks, manual checks,
   decisions), and the next session.

## Rules you must not break

**Backlog integrity**

- Never delete a feature or weaken acceptance criteria. `verify` compares against the last commit and fails.
  To replace work: add a new feature, then `set <old> superseded --by <new>`. Refining (adding criteria, splitting)
  is allowed and should be noted in PROGRESS.md.
- New feature IDs follow their session (`S14.7`); new sessions continue the sequence (`S30`) and need an entry in
  `sessions` with a goal and dependencies.

**Product and architecture invariants** (from PLAN — breaking one is a bug even if tests pass)

- **User data is sacred.** Never silently overwrite or delete user files. Saves are atomic (temp file + rename).
  On any failure keep the in-memory content and explain the cause. Deletions go to the OS trash.
- **Preview isolation.** User webpages run in a sandboxed `WebContentsView` with no preload, no Node, context
  isolation on, a per-project session partition, and no access to IDE IPC. Never inject user HTML into the React DOM.
- **Static server** binds loopback only, serves GET/HEAD from inside the project root only (realpath-checked),
  validates Host, denies dotfiles. A random port is not access control.
- **Restricted IPC.** The renderer reaches main only through the typed API in `src/shared/ipc`, exposed by preload.
  Main validates every payload and the sender frame.
- **Platform code lives in `src/platform`.** `process.platform` anywhere else is a lint error. Use `path` APIs; never
  concatenate separators or lowercase paths. Paths with Chinese characters and spaces must always work.
- **Undo, autosave, crash recovery and local history are separate mechanisms** with separate UI states.
- **Project folders stay ordinary.** Only `.noobide/project.json` (relative paths, no secrets) may be written into a
  project. Caches, history and recovery data live in the app-data directory.
- **Offline first.** Core features never need the network. No CDN assets; Monaco and fonts are bundled.
- **i18n.** No hardcoded UI strings in components; zh-CN is the default locale, en is required.
- **Accessibility.** State is never communicated by colour alone; key actions are keyboard-reachable.
- **Logs never contain source code.**

**Dependencies**

- Pin exact versions (no `^`/`~`). Commit `package-lock.json` (generate it on the Windows dev machine).
- Prefer pure JS/TS packages. A native module needs a decision record and proof of macOS arm64 + Windows x64
  builds against the pinned Electron ABI.
- Record any significant choice as `docs/decisions/NNNN-title.md` (template: 0001).

**Scope**

- MVP exclusions (PLAN §4): React/Vue projects, npm management, terminal, Git UI, extension marketplace, AI chat,
  cloud accounts, collaboration, publishing, custom breakpoint debugger. Do not build them; put ideas in PROGRESS.md
  under "Ideas / backlog candidates".
- Only claim capabilities that a test or validation scenario proves (PLAN §4, §9).

## Repository map

```
PLAN.md                 product plan (owner-maintained source of truth)
AGENTS.md / CLAUDE.md   this manual
harness/
  features.json         backlog: milestones, sessions, features, status, evidence
  session.mjs           CLI: start | status | next | show | set | check
  verify.mjs            runs all quality gates (npm run verify)
  PROGRESS.md           session log, newest first
  MANUAL-CHECKS.md      steps the owner must run on real Windows / Apple Silicon hardware
docs/
  ROADMAP.md            milestones → sessions, dependency graph, change rules
  decisions/            architecture decision records
  testing.md            test strategy and conventions
  product/ wireframes/ research/ reviews/ perf/ release/
src/  main platform preload renderer workspace preview diagnostics recovery shared   (see each README.md)
resources/  templates lessons
tests/      fixtures integration e2e
scripts/    build, measurement and release helpers
```

## Commands

| Command                                                           | Purpose                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| `npm run session -- start`                                        | Orientation (same as `node harness/session.mjs start`) |
| `npm run session -- next [--all]`                                 | Ready features for the current session (or everywhere) |
| `npm run session -- show S10`                                     | Details of a session, feature or milestone             |
| `npm run verify` / `-- --quick` / `-- --e2e`                      | All gates / fast subset / including e2e                |
| `npm test`, `npm run typecheck`, `npm run lint`, `npm run format` | Individual gates                                       |
| `npm start`                                                       | Run the app with the Vite dev server                   |
| `npm run package` / `npm run make`                                | Packaged app in `out/` / installers in `out/make`      |
| `npm run test:e2e`                                                | Build + Playwright Electron e2e (`tests/e2e`)          |
| `npm run selftest:packaged` / `selftest:dev`                      | Monaco worker self-test of the packaged / dev app      |

## Environment notes

- Primary dev machine: Windows (x64), repo at `D:\NoobIDE`. Use cross-platform Node scripts (`.mjs`), not bash or
  PowerShell, for anything in the repo.
- Node ≥ 22.12 (see `.nvmrc`). Electron bundles its own Node; users never install Node.
- macOS arm64 builds and `manual-mac` checks need a physical Apple Silicon Mac or the macOS CI runner (S06).
- Cloud agent sessions without a shell on the dev machine: work in a clone and hand files back, but run
  `npm run verify` in the clone before handing back.
