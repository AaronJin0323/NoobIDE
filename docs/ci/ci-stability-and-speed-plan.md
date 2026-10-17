# CI stability and speed plan (S50)

Owner request 2026-10-17: "CI keeps failing; troubleshoot it and speed it up." This document records what the red
runs of 16–17 October actually failed on, where a green run spends its time, and the work packages (S50.1–S50.6 in
`harness/features.json`) that fix the causes and shorten the pipeline. Each package is sized for one agent
sub-session and names the files it owns, so packages can run in parallel without touching the same files.

Baseline and earlier work: [ADR 0035](../decisions/0035-ci-latency.md) (two shards per OS, S06.5),
[ADR 0036](../decisions/0036-draft-release-delivery.md) (release delivery, S28.7). This plan continues them; it
drops no test and weakens no acceptance criterion (AGENTS.md "Backlog integrity").

## 1. What failed, and why

Every `CI` run between 2026-10-16 07:00 and 2026-10-17 08:15 (25 runs) was inspected with `gh run view`. 13 passed,
5 failed, 7 were cancelled (superseded by a newer push to the same branch, which `concurrency` does on purpose).
Not one of the five failures was caused by the product code the run was testing.

| Run         | Branch                      | Failing step                     | Cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Class                                               |
| ----------- | --------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 39000141670 | codex/ci-cd-delivery        | Verify (harness, format), 4 jobs | `harness/features.json` lost a `,` between two feature objects in a hand-resolved merge (`SyntaxError … line 4257`). Fixed in 5a66a19.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Merge damage to the backlog file                    |
| 39011559538 | main (merge of PR 13)       | Verify on macOS shard 1          | `src/renderer/editor/completion-latency.test.ts`: p95 21.4 ms against a 10 ms budget. The budget was measured on the dev machine; the hosted macOS runner is slower and shared.                                                                                                                                                                                                                                                                                                                                                                                                        | Wall-clock budget asserted on a hosted runner       |
| 39011559538 | main (same run)             | E2E on Windows shard 2           | `tests/e2e/walkthrough.spec.ts:80`: after `menu('help-walkthrough')` the panel never appeared (20 s). Passed on the other three jobs and on every other run that day.                                                                                                                                                                                                                                                                                                                                                                                                                  | Intermittent E2E (timing)                           |
| 38866174566 | claude/s49-1-sheet          | E2E on Windows                   | `walkthrough.spec.ts`: `ENOENT …/引擎 数据/walkthrough.json`. The test reads the stored file with `readFile` at once, not with `expect.poll`, so it races the app's write.                                                                                                                                                                                                                                                                                                                                                                                                             | Intermittent E2E (race in the test)                 |
| 38885242882 | claude/s49-1-sheet          | E2E on Windows                   | `preview-isolation.spec.ts:1114` (alert/confirm/beforeunload): the 10 s `expect.poll` for `window.__doc` timed out once.                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Intermittent E2E (timing)                           |
| 39015145940 | claude/s49-splitter-physics | Verify on both macOS shards      | `tests/integration/e2e-shards.test.ts:55` expects `preview-isolation.spec.ts` in shard 2. The branch adds `splitter-physics.spec.ts`; Playwright splits shards by _test count in file order_, so the extra file moved the boundary and `preview-isolation` fell into shard 1 on macOS (the per-file count differs by platform). Windows passed on the same commit. On main the boundary sits exactly there: a local `--list` gives shard 1 = 31 files ending with `preview-annotations.spec.ts` (166 tests), shard 2 = 27 files starting with `preview-isolation.spec.ts` (161 tests). | Fragile shard assertion: any new spec file flips it |

Two structural conclusions:

1. **Three of the five red runs would have been red for any code change.** The shard-position assertion and the
   wall-clock budgets fail for reasons unrelated to the PR. Developers (and agent sessions) learn to ignore CI,
   which is the real cost.
2. **The flaky E2E tests are all on Windows and all in files that drive the app through menus or read app-data
   files.** Two of the three have a visible fix in the test (poll instead of read; wait for the menu to be
   dispatchable). Traces are not kept on failure (`retries: 0`, no `trace` option), so the third has to be
   reproduced from a screenshot and a stack line.

## 2. Where the time goes

Run 39015143213 (PR 17, green, 2026-10-17 07:50:36 → 08:11:03, **20 min 27 s wall-clock**):

| Step                                                                    | windows-x64 shard 1 | windows-x64 shard 2 | macos-arm64 shard 1 | macos-arm64 shard 2 |
| ----------------------------------------------------------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| Queue (run created → job started)                                       | 0:02                | 0:02                | **2:33**            | **9:21**            |
| Checkout + Node + `npm ci` (cache hit)                                  | 0:39                | 0:35                | 0:24                | 0:20                |
| Fault suite + upload                                                    | 0:05                | 0:04                | 0:04                | 0:03                |
| Verify (harness, typecheck, lint, format, 2 750 unit/integration tests) | 1:42                | 1:20                | 1:03                | 1:08                |
| `electron-forge package` (macOS builds two: normal + upgrade-next)      | 0:17                | 0:14                | 0:21                | 0:19                |
| Playwright tests (1 worker)                                             | 7:03                | 7:10                | 7:07                | **9:01**            |
| Make installers + inspect + upload (shard 1 only)                       | **1:33**            | –                   | 0:26                | –                   |
| Job total                                                               | 11:24               | 9:29                | 9:31                | 10:59               |

Same picture on run 39011765635 (PR 7): wall-clock 19 min, macOS shard 1 queued only 0:07 but ran its E2E in 16:23
(a slow runner), Windows jobs 11–14 min.

Where the minutes are:

- **The macOS queue is the single biggest item.** The account is a personal (free) plan with a limit of 5
  concurrent macOS jobs. At 07:50 five PRs (14, 15, 16, 17, 18) were pushed within 90 s by parallel agent
  sessions, each needing two macOS jobs: ten macOS jobs for five slots. Windows has slots to spare.
- **Every push to every PR runs the full matrix**, including docs-only PRs (PR 15 changes only `docs/`,
  `harness/PROGRESS.md` and `harness/features.json`) and intermediate pushes that are superseded minutes later
  (PR 14: three cancelled runs in 45 minutes).
- **Two E2E files cost two minutes each on every shard**: `app-startup-restore.spec.ts` (121–141 s; restarts the
  app under synthetic CPU load) and `preview-isolation.spec.ts` (116–118 s; the 1.7 min console-flood
  measurement). Shard 2 on macOS is two minutes longer than shard 1 because the split is by test count, not time.
- **Typecheck, lint and format run four times** (once per OS job), about 40–60 s each time, and a lint or format
  failure is reported only after the macOS queue.
- **Installers are made and uploaded on every PR push** (Windows: 1 min 33 s on the critical path); nobody
  downloads PR installers.
- Not worth touching: `npm ci` (20–40 s, npm cache hits), packaging (15–20 s), the fault suite (3 s), artifact
  uploads (a few seconds each).

## 3. Targets

| Measure                                           | Now                                        | Target after S50                                                                                  |
| ------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Red runs whose cause is not the PR's code         | 3 of the last 5 red runs                   | 0 (budgets informational on hosted runners; shard split deterministic; the two known races fixed) |
| Wall-clock for a code PR, no queue                | ~11.5 min (critical path: windows shard 1) | ≤ 9 min (no installers on PRs, static gates off the OS jobs, time-balanced shards)                |
| Wall-clock for a code PR, five PRs pushed at once | ~20 min                                    | ≤ 12 min (fewer macOS jobs per push: docs-only and draft pushes skip the matrix)                  |
| Wall-clock for a docs-only PR                     | ~20 min                                    | ≤ 3 min (one ubuntu job: harness check, format, docs tests)                                       |
| Time to first failure for lint/format/typecheck   | after verify on each OS job (2–12 min)     | ≤ 2 min (ubuntu static job)                                                                       |
| Debuggability of an E2E failure                   | screenshot + stack line                    | Playwright trace per failed test, kept 7 days                                                     |

Measurements come from `scripts/ci-timings.mjs` (S50.6), run against the last 20 runs before and after each package
lands, so the ADR for S50 records real numbers (ADR 0035 asked for exactly this comparison).

## 4. Work packages

Each package is one feature in `harness/features.json` (session S50) and one agent sub-session. "Owns" lists the
only files that package may edit, so packages marked _parallel_ can run at the same time in separate worktrees.

### S50.1 — Run less: path filter, draft gating, static gates once, no PR installers

_Parallel with S50.2, S50.3, S50.4, S50.6._ Owns `.github/workflows/ci.yml`, `scripts/ci-changes.mjs` (new),
`tests/integration/ci-workflow.test.ts`, `tests/integration/ci-changes.test.ts` (new), the AGENTS.md line on drafts.

1. A first `changes` job on `ubuntu-latest` (seconds) classifies the push with `git diff --name-only` against the
   base: `code` (anything under `src/`, `tests/`, `scripts/`, `resources/`, `harness/*.mjs`, `harness/features.json`,
   `package*.json`, `*.config.*`, `.github/`) or `docs-only` (everything else: `docs/`, `*.md`,
   `harness/PROGRESS.md`, `harness/MANUAL-CHECKS.md`). No third-party action: a 20-line Node script in
   `scripts/ci-changes.mjs`, unit-tested.
2. A `static` job on `ubuntu-latest` runs `harness check`, `typecheck`, `lint`, `format:check` and the
   workflow/docs integration tests once. It runs for every push, so a docs-only PR still proves its
   `features.json` and formatting. The OS jobs run `verify --quick`-style gates only (harness check + `npm test`,
   whose platform-specific tests are the reason they must stay on both OSes).
3. The `build` matrix runs only when `changes.outputs.kind == 'code'` **and** the PR is not a draft
   (`github.event.pull_request.draft == false`; pushes to `main` and `workflow_dispatch` always run). Agent sessions
   open PRs as drafts and mark them ready when the work is done (one line in AGENTS.md "Close the session").
4. The two `complete` gate jobs keep their names (`windows-x64`, `macos-arm64` are required by the "Protect main"
   ruleset) and pass when `static` succeeded and `build` either succeeded or was skipped because the push was
   docs-only. A draft PR shows pending gates, which is correct: it is not mergeable yet.
5. "Make installers / Inspect binary architectures / Upload installers" run only on `push` to `main` and on
   `workflow_dispatch`. PR runs still build the package (the E2E suite needs it) but skip the 1.5 min Squirrel step.

Acceptance: `ci-workflow.test.ts` covers the new jobs, the gate logic and the `if:` conditions; a docs-only PR shows
both required checks green in under 3 minutes; a code PR's `static` job reports lint/format failures before any
OS job finishes. Decision record: folded into the S50 ADR (S50.6).

### S50.2 — Deterministic, time-balanced E2E shards

_Parallel with S50.1, S50.3, S50.4, S50.6._ Owns `tests/e2e/playwright.config.ts`, `tests/e2e/shards.json`
(new), `scripts/e2e.mjs`, `scripts/e2e-shards.mjs` (new), `tests/integration/e2e-shards.test.ts`.

1. Replace Playwright's count-based `--shard` with an explicit manifest: `tests/e2e/shards.json` maps each shard to
   its spec files. `node scripts/e2e-shards.mjs balance reports/e2e/*.json` regenerates it from the timing reports
   CI already uploads (greedy longest-first onto the emptier shard), so the two 2-minute files always land on
   different shards and the shards differ by less than a minute.
2. `npm run test:e2e -- --shard=1/2` selects the manifest's files (Playwright positional file filters, or a
   per-shard `project` with `testMatch`). A spec file missing from the manifest goes to the lighter shard by
   default and makes the integration test print "add `<file>` to tests/e2e/shards.json". A new spec file can never
   turn CI red by moving a boundary again.
3. `e2e-shards.test.ts` keeps proving disjoint + complete coverage against the real `--list` output on this OS and
   drops the two position assertions in favour of "the manifest lists every spec file exactly once".
4. `playwright.config.ts` gets `trace: 'retain-on-failure'` and `screenshot: 'only-on-failure'`; the existing
   "Upload e2e results on failure" step already ships `test-results/`, so every CI failure comes with a trace.
   `retries` stays 0 (docs/testing.md: a flaky test is a bug).

Acceptance: both shards on both OSes within 60 s of each other in `reports/e2e` of the first hosted run after
merge; a synthetic new spec file in a temp copy does not fail the shards test; a forced E2E failure in CI uploads a
`trace.zip`.

### S50.3 — Wall-clock budgets: enforced locally, reported on hosted runners

_Parallel with S50.1, S50.2, S50.4, S50.6._ Owns `vitest.config.ts`, `vitest.perf.config.ts` (new),
`package.json` scripts, `harness/verify.mjs`, `.github/workflows/perf.yml` (new), `docs/testing.md`,
`docs/perf/ci-runners.md` (new), and the test files it moves.

1. Inventory the 24 test files that assert `toBeLessThan(<ms>)` (list in `docs/perf/ci-runners.md`). Classify each
   assertion: **functional timeout** (an event must arrive within N s, e.g. watcher delivery; keep in `npm test`)
   or **performance budget** (p95 latency, max lag, throughput, e.g. `completion-latency`, `completion-perf`,
   `journal-scheduler` timings, watcher `maxLag < 500`).
2. Performance budgets move to a `perf` Vitest project (`*.perf.test.ts`) run by `npm run test:perf`.
   `npm run verify` still runs it **and enforces the budgets** on developer machines, where the `docs/perf/*.md`
   baselines were measured. On GitHub Actions (`GITHUB_ACTIONS=true`) the same tests run with budgets reported, not
   asserted: the numbers go to `reports/perf/<platform>.json` and the job summary, and the test fails only on an
   error or a result more than 5× over budget (a regression, not runner noise).
3. `perf.yml` runs `test:perf` on both OSes on `push` to `main` and nightly, uploads the reports, and is **not**
   a required check. The OS jobs in `ci.yml` run `npm test` without the perf project, so S50.1 and S50.3 do not
   edit the same workflow file.
4. ADR `0038-perf-budgets-on-hosted-runners.md`: why a budget measured on a fixed dev machine is not a pass/fail
   oracle on a shared hosted runner, and what stays enforced where.

Acceptance: `npm run verify` locally still fails when a budget is exceeded (proven with a deliberately tightened
budget); the CI matrix no longer contains a p95/lag assertion; `perf.yml` leaves one report per OS on `main`.

### S50.4 — Fix the three Windows E2E intermittents

_Parallel with S50.1, S50.2, S50.3, S50.6._ Owns `tests/e2e/walkthrough.spec.ts`,
`tests/e2e/preview-isolation.spec.ts` (the dialog test only, lines ~1114–1175), the shared e2e helpers if the menu
fix belongs there, and renderer code only if the cause turns out to be in the app.

1. `walkthrough.spec.ts`: `stored()` reads `walkthrough.json` without waiting; wrap it in `expect.poll` (the file is
   written after the UI updates). Then find why `menu('help-walkthrough')` can open nothing on Windows: the
   `app-menu` click lands before the menu's React handlers are attached, or the menu closes on the window-focus
   change the runner's desktop produces. Reproduce with `NOOBIDE_E2E_WINDOW=1024x768` and CPU load (the
   `loadCpu()` helper from `app-startup-restore.spec.ts`); fix in the test helper (wait for `menu-help-walkthrough`
   to be visible and stable before clicking) or in the app if the menu really drops the click.
2. `preview-isolation.spec.ts` dialog test: the 10 s poll for `window.__doc` covers alert → confirm → prompt →
   print in the sandboxed view; measure its real duration on CI from the timing reports and either raise the
   budget to a value with headroom or split the poll per dialog so the failing one is named.
3. Run each fixed test 20× on Windows (`--repeat-each=20`) under CPU load as evidence.

Acceptance: 20/20 local repeats under load for each test; the next five hosted runs show no failure in these
files (checked with `scripts/ci-timings.mjs --failures`).

### S50.5 — Measurement-heavy E2E tests out of the PR path (owner decision)

_After S50.4 (same file) and S50.2 (manifest)._ Owns `tests/e2e/app-startup-restore.spec.ts`,
`tests/e2e/preview-isolation.spec.ts`, `.github/workflows/measurements.yml` (new), `tests/e2e/shards.json`.

Two tests are measurements, not regression checks: the S05.8 startup-under-load restart loop (2.3 min) and the
S05.3/S05.7 console-flood rate test (1.7 min). Proposal: keep a 20-second smoke version of each in the PR suite
(one restart under load; a 5-second flood that checks the bound) and run the full versions in a nightly
`measurements.yml` on `main` on both OSes, with the fault-suite report style. This cuts about 2 min from every
shard. It is an explicit coverage decision, so it needs the owner's yes and its own decision record; nothing is
removed, the full tests still run every night and on `workflow_dispatch`.

Acceptance: PR shards each lose ≥ 90 s; `measurements.yml` ran green on `main` at least once per OS; ADR written.

### S50.6 — Measure it: CI timing tool, job summaries, decision record

_Parallel with everything; do it first so the comparison is honest._ Owns `scripts/ci-timings.mjs` (new),
`tests/integration/ci-timings.test.ts` (new, fixture-based), `docs/decisions/0037-ci-stability-and-speed.md`
(new), `docs/ci/`.

1. `node scripts/ci-timings.mjs [--runs 20] [--failures]` uses `gh api` to list the last N `CI` runs and prints per
   job: queue delay, step durations, Playwright test time (from the `e2e-report-*` artifacts when present), and for
   failed runs the failing step and the first error line. Pure Node, no new dependency; the parser is unit-tested on
   saved fixtures from the runs in §1.
2. An E2E step summary: after each Playwright run, `scripts/e2e.mjs` appends the 10 slowest files and the shard
   total to `$GITHUB_STEP_SUMMARY` (the data is already in `reports/e2e/results.json`).
3. ADR 0037 records the baseline from §2, the targets from §3, the decisions in S50.1 (draft gating, path filter,
   installers only on `main`) and, after S50.1–S50.4 are merged, the measured result.

Acceptance: the tool reproduces the §2 table for run 39015143213 from fixtures; the ADR has before/after numbers.

## 5. Order and parallelism

```
S50.6 (tooling, baseline)  ──┐
S50.1 (workflow)           ──┤
S50.2 (shards + traces)    ──┼──▶ merge, measure 20 runs ──▶ S50.5 (needs owner yes) ──▶ ADR final numbers
S50.3 (perf budgets)       ──┤
S50.4 (flaky tests)        ──┘
```

S50.1, S50.2, S50.3, S50.4 and S50.6 touch disjoint files and can each run in its own worktree session. S50.3 puts
its CI job in a separate workflow file for exactly that reason. S50.5 waits for S50.4 (same spec file), S50.2
(manifest) and the owner's decision.

Every package: `npm run verify` green, PROGRESS.md entry, one commit per feature, status through
`node harness/session.mjs set S50.x …`. Hosted evidence (a green run URL, the timing table) goes into the
feature's `--evidence`.

## 6. Decisions the owner is asked to make

1. **Draft PRs skip the matrix** (S50.1): agent sessions must open drafts and mark them ready. Saves most of the
   macOS queue. Default if no answer: yes.
2. **Installers only on `main` and manual dispatch** (S50.1), not on PR pushes. Default: yes.
3. **Performance budgets informational on hosted runners** (S50.3), still enforced by local `verify`. Default: yes.
4. **Full startup-under-load and console-flood measurements nightly, smoke versions on PRs** (S50.5). This is the
   only item that changes what a PR run proves; no default. S50.5 stays `todo` until answered.
5. Not proposed: more shards (macOS concurrency is the limit, not shard count), Playwright retries (hides bugs),
   paid runners (an owner budget question; the plan should get PR CI under 12 minutes without them).

## 7. Things checked and ruled out

- `npm ci` and the npm cache: cache hits on every job (76 MB), 15–20 s. No gain from caching Electron separately.
- Packaging twice per macOS shard (upgrade-next fixture): 20 s total. Not worth sharing packages between shards
  (an artifact round-trip of ~300 MB would cost more than it saves).
- Vitest: 2 750 tests in ~30 s on every OS; `maxWorkers: 4` from S06.5 is fine.
- The fault suite: 3 s. Leave it.
- `cancel-in-progress` on `main`: wanted (ADR 0035). The cancelled runs in the list are not failures.
