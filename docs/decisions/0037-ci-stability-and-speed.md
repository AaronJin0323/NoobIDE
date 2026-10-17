# 0037 — CI stability and speed (S50)

- **Status:** accepted (the "Measured result" section is still to be filled after S50.1–S50.4 are merged)
- **Date:** 2026-10-17
- **Feature:** S50.6 (tooling and this record); decisions for S50.1–S50.5
- **Plan:** [docs/ci/ci-stability-and-speed-plan.md](../ci/ci-stability-and-speed-plan.md) (§1 causes, §2 baseline,
  §3 targets, §4 packages, §6 owner decisions). Continues [ADR 0035](0035-ci-latency.md) (two shards per OS) and
  [ADR 0021](0021-ci-matrix-and-arch-inspection.md) (the matrix itself).

## Context

The owner asked on 2026-10-17 to troubleshoot repeated CI failures and to speed CI up. The plan's §1 inspected the
25 `CI` runs of 16–17 October: 13 passed, 5 failed, 7 were cancelled by a newer push. None of the five red runs was
caused by the product code under test:

| Cause                                                                                              | Runs                     | Class                                |
| -------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------ |
| `harness/features.json` lost a `,` in a hand-resolved merge                                        | 39000141670              | merge damage to the backlog file     |
| `completion-latency.test.ts` asserts a 10 ms p95 budget; the hosted macOS runner measured 21 ms    | 39011559538, 39014335171 | wall-clock budget on a hosted runner |
| `walkthrough.spec.ts` reads `walkthrough.json` without polling / the Help-menu click opens nothing | 39011559538, 38866174566 | Windows E2E race                     |
| `preview-isolation.spec.ts` dialog test: one 10 s poll timed out                                   | 38885242882              | Windows E2E timing                   |
| `e2e-shards.test.ts` asserts which shard a file lands in; any new spec file moves the boundary     | 39015145940              | fragile assertion                    |

Three of the five would have been red for any change. The practical cost is that people and agent sessions learn to
ignore a red check.

**Where the time goes (plan §2, run 39015143213, green, 20 min 27 s wall-clock):** the four matrix jobs take 9.5–11.5
min each; the run takes twice that because macOS shard 2 waited 9 min 21 s in the queue behind five PRs pushed at
once (free plan: 5 concurrent macOS jobs). Inside a job: Playwright 7–9 min (two spec files cost two minutes each),
verify 1–1.7 min repeated on every OS job, installers 1.5 min on Windows shard 1, setup 20–40 s.

The baseline below, measured with the tool this ADR introduces over the last 20 runs, adds two facts the single
green run hid:

1. **macOS shard 1 usually spends 14–16 minutes in Playwright, not 7.** `app-startup-restore.spec.ts` (the S05.8
   restart-under-load loop) takes 10:08–10:17 on 8 of the 10 completed macOS shard-1 jobs, against 2:01 on the one
   fast run and 2:17–4:29 on Windows. The macOS shard-1 median is 14:20; the §2 table shows the fastest run of the
   day. Plan §4 S50.5 (move the two measurement tests to a nightly workflow) is therefore worth about 10 minutes
   of macOS wall-clock on most runs, not 2.
2. **Queue delay on macOS is the largest and most variable item**: median 2:33, maximum 32:16 (run 39014627704,
   wall-clock 41 min). Windows never queued for more than 25 s.

## Options considered

- **More shards or more workers per shard.** Rejected (plan §6 item 5): macOS concurrency is the limit, so more
  macOS jobs per push make the queue worse; more Playwright workers on one desktop risk focus and native-menu
  interference (ADR 0035).
- **Playwright retries.** Rejected: hides the bugs the tests exist to catch (`docs/testing.md`: a flaky test is a
  bug). Traces on failure instead (S50.2).
- **Paid or larger runners.** Not proposed: an owner budget question; the plan should get PR CI under 12 minutes
  without them.
- **Dropping tests from PRs.** Only as an explicit owner decision with nightly full runs (S50.5), never silently.

## Decision

Six packages, each owning disjoint files so they run as parallel sub-sessions (plan §4–§5):

1. **S50.1 — run less.** (a) A `changes` job classifies each push as code or docs-only with a unit-tested Node
   script; docs-only pushes skip the OS matrix. (b) Typecheck, lint, format, harness check and the workflow/docs
   tests run **once** on an `ubuntu-latest` static job for every push; the OS jobs keep harness check and `npm test`.
   (c) **Draft pull requests skip the build matrix**; pushes to `main` and `workflow_dispatch` always run it. Agent
   sessions open PRs as drafts and mark them ready when done. (d) The required gate jobs keep the names
   `windows-x64` and `macos-arm64` and pass only when static succeeded and build succeeded or was skipped for a
   docs-only push; a failed or cancelled shard still fails them. (e) **Installers are built and uploaded only on
   push to `main` and on `workflow_dispatch`**; PR runs still package the app for E2E but skip the 1.5 min Squirrel
   step. Owner decisions 1 and 2 of plan §6; default "yes" applies if unanswered.
2. **S50.2 — deterministic, time-balanced E2E shards.** `tests/e2e/shards.json` assigns every spec file to a
   shard; `scripts/e2e-shards.mjs balance` regenerates it from the timing reports (longest file first onto the
   emptier shard). A file missing from the manifest goes to the lighter shard and is named by the integration
   test instead of failing on a boundary. `trace: 'retain-on-failure'`, `screenshot: 'only-on-failure'`,
   `retries` stays 0.
3. **S50.3 — budgets enforced locally, reported on hosted runners.** Performance budgets move to a `perf` Vitest
   project that `npm run verify` still enforces on developer machines; on GitHub Actions they report to
   `reports/perf/` and the job summary and fail only on an error or a result more than 5× over budget. The
   required matrix contains no p95 or lag assertion; `perf.yml` runs the project on `main` and nightly as a
   non-required check (ADR 0038, owner decision 3).
4. **S50.4 — fix the Windows intermittents** in `walkthrough.spec.ts` (poll the stored file; wait for the menu
   item) and the preview-isolation dialog test (measured budget or per-dialog poll), each proven 20/20 under CPU
   load.
5. **S50.5 — measurement-heavy E2E tests nightly, smoke versions on PRs.** Blocked on owner decision 4; the
   baseline above says it is worth ~10 min of macOS shard-1 time on most runs.
6. **S50.6 — measure it (this record).** `scripts/ci-timings.mjs` (gh wrappers) + `scripts/ci-timings-parse.mjs`
   (pure parser/formatter, tested on fixtures of runs 39015143213 and 39011559538 under `tests/fixtures/ci/`):
   per job the queue delay, every step's duration, the Playwright time from the `e2e-report-<target>-<shard>`
   artifact, and for failed runs the failing step with the first error line. `scripts/e2e.mjs` appends the 10
   slowest spec files and the shard total to the GitHub job summary after every Playwright run
   (`scripts/e2e-summary.mjs`).

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- A red check means the PR's code, a real flake with a trace attached, or a genuine 5× perf regression; nothing
  else. Lint, format and typecheck failures arrive from the ubuntu job within ~2 minutes instead of after the
  macOS queue.
- Fewer macOS jobs per push (docs-only and draft pushes run none) shortens the queue for everyone; the free-plan
  limit of five concurrent macOS jobs is unchanged, so five ready code PRs pushed at once still queue.
- PR runs no longer produce installers; `main` and manual dispatch still do, and the release workflow is
  untouched (ADR 0036).
- Perf budgets are no longer a pass/fail oracle on hosted runners. The dev-machine `verify` still enforces them,
  and `perf.yml` keeps a per-OS record so a drift is visible in the reports rather than as a random red run.
- Verification: `tests/integration/ci-workflow.test.ts` (S50.1 conditions and gates), `e2e-shards.test.ts` (manifest
  complete and disjoint on both OSes), `ci-timings.test.ts` (the parser reproduces the §2 table from fixtures:
  queue 2:33 / 9:21 on the macOS shards, Playwright 7:03 / 7:10 / 7:07 / 9:01, installers 1:33, within 5 s), the
  job summary on the first hosted run after merge, and the "Measured result" section below, filled from real runs
  on both targets. Targets (plan §3): code PR ≤ 9 min without queue, ≤ 12 min with five PRs at once, docs-only PR
  ≤ 3 min, lint/format/typecheck feedback ≤ 2 min, zero red runs whose cause is not the PR's code.

## Baseline (before S50.1–S50.4), 2026-10-17

`node scripts/ci-timings.mjs --runs 20 --no-steps`, run at 2026-10-17 11:45 UTC against the last 20 `CI` runs
(2026-10-17 03:40 → 08:41; three were still queued or in progress). Columns: queue = job start − run creation; Playwright = `stats.duration`
from the shard's `e2e-report` artifact; Package = the E2E step minus Playwright; Installers = make + inspect +
upload. `–` means the step did not run or has not finished.

<!-- BASELINE-START: output of node scripts/ci-timings.mjs --runs 20 --no-steps, 2026-10-17 11:45 UTC -->

```text
Run 39018329181  queued  pull_request  claude/laughing-brattain-d2dcf0  2026-10-17 08:41:46Z  wall-clock 0:00
  Job                      Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2)   0:01      –       –       –        –           –         –           –      –
  macos-arm64 (shard 2/2)   0:09   0:22    0:03    0:59        –           –         –           –      –
  windows-x64 (shard 1/2)   0:05   0:44    0:08    1:42        –           –         –           –      –
  windows-x64 (shard 2/2)   0:03   0:38    0:04    1:36        –           –         –           –      –

Run 39018194387  in_progress  pull_request  claude/ci-failures-optimization-f08cd1  2026-10-17 08:39:43Z  wall-clock 0:36
  Job                                Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2)             0:36   0:20    0:03    0:46        –           –         –           –      –
  macos-arm64 (shard 2/2)             0:35   0:25    0:03    0:57        –           –         –           –      –
  windows-x64 (shard 1/2) [failure]   0:31   0:56    0:06    2:16        –           –         –           –   3:21
  windows-x64 (shard 2/2)             0:32   0:38    0:05    1:23        –           –         –           –      –
  ✘ windows-x64 (shard 1/2): failed at "Verify (harness, typecheck, lint, format, unit and integration tests)"

Run 39017928152  in_progress  pull_request  claude/noobide-ui-ux-improvements-50c047  2026-10-17 08:35:18Z  wall-clock 0:35
  Job                      Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2)   0:35   0:25    0:03    1:08        –           –         –           –      –
  macos-arm64 (shard 2/2)   0:35   0:26    0:03    0:59        –           –         –           –      –
  windows-x64 (shard 1/2)   0:30   0:42    0:05    1:35        –           –         –           –      –
  windows-x64 (shard 2/2)   0:30   1:07    0:06    1:42        –           –         –           –      –

Run 39017707753  cancelled  pull_request  claude/ci-failures-optimization-f08cd1  2026-10-17 08:31:50Z  wall-clock 8:22
  Job                                  Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2) [cancelled]   1:41   0:17    0:03    0:44        –           –      5:20           –   6:34
  macos-arm64 (shard 2/2) [cancelled]   0:07   0:24    0:03    1:01        –           –      6:30           –   8:06
  windows-x64 (shard 1/2) [cancelled]   0:02   0:57    0:04    1:07     0:12        5:31      5:43           –   7:56
  windows-x64 (shard 2/2) [failure]     0:02   0:42    0:05    1:29        –           –         –           –   2:21
  ✘ macos-arm64 (shard 1/2): failed at "Upload E2E timing report"
  ✘ macos-arm64 (shard 2/2): failed at "Upload E2E timing report"
  windows-x64 (shard 1/2) e2e: 92 passed, 0 failed, 74 skipped; slowest app-startup-restore.spec.ts 3:24, external-change.spec.ts 0:35, ai-prompt.spec.ts 0:12
  ✘ windows-x64 (shard 2/2): failed at "Verify (harness, typecheck, lint, format, unit and integration tests)" — FAIL  tests/integration/watcher.test.ts > file watcher (S07.3) > entries that came and went within one batch are reported as deleted, a folder once — AssertionError: expected [ { type: 'deleted', …(1) }, …(1) ] to deeply equal ArrayContaining{…}
  ✘ macos-arm64: failed at "Require every platform and shard" — Process completed with exit code 1.
  ✘ windows-x64: failed at "Require every platform and shard" — Process completed with exit code 1.

Run 39017135521  failure  pull_request  claude/laughing-brattain-d2dcf0  2026-10-17 08:22:46Z  wall-clock 18:04
  Job                                Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2)             0:06   0:20    0:04    1:11     0:21       15:21     15:42        0:28  17:51
  macos-arm64 (shard 2/2)             0:07   0:24    0:02    1:02     0:18        8:40      8:58           –  10:32
  windows-x64 (shard 1/2) [failure]   0:02   0:41    0:05    1:45     0:16        7:06      7:22           –   9:59
  windows-x64 (shard 2/2)             0:02   0:27    0:06    1:17     0:10        6:36      6:46           –   8:41
  macos-arm64 (shard 1/2) e2e: 163 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 10:14, external-change.spec.ts 0:35, language-workbench.spec.ts 0:25
  macos-arm64 (shard 2/2) e2e: 161 passed, 0 failed, 0 skipped; slowest preview-isolation.spec.ts 1:58, recovery.spec.ts 0:56, upgrade.spec.ts 0:30
  windows-x64 (shard 1/2) e2e: 157 passed, 1 failed, 8 skipped; slowest app-startup-restore.spec.ts 2:32, external-change.spec.ts 0:35, language-workbench.spec.ts 0:25
  ✘ windows-x64 (shard 1/2): failed at "End-to-end tests (Playwright + Electron)" — Error: light: the code itself has detail
  windows-x64 (shard 2/2) e2e: 160 passed, 0 failed, 1 skipped; slowest preview-isolation.spec.ts 1:59, runtime-problems.spec.ts 0:27, recovery.spec.ts 0:24
  ✘ macos-arm64: failed at "Require every platform and shard" — Process completed with exit code 1.
  ✘ windows-x64: failed at "Require every platform and shard" — Process completed with exit code 1.

Run 39017118291  cancelled  pull_request  claude/noobide-ui-ux-improvements-50c047  2026-10-17 08:22:30Z  wall-clock 13:16
  Job                                  Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2) [cancelled]   0:06   0:21    0:02    0:51        –           –     11:41           –  13:02
  macos-arm64 (shard 2/2)               0:08   0:29    0:04    1:06     0:17        9:10      9:27           –  11:13
  windows-x64 (shard 1/2)               0:02   0:39    0:05    1:41     0:15        7:13      7:28        1:34  11:34
  windows-x64 (shard 2/2) [failure]     0:02   0:33    0:04    1:13        –           –         –           –   1:54
  ✘ macos-arm64 (shard 1/2): failed at "Upload E2E timing report"
  macos-arm64 (shard 2/2) e2e: 161 passed, 0 failed, 0 skipped; slowest preview-isolation.spec.ts 2:14, recovery.spec.ts 0:55, upgrade.spec.ts 0:30
  windows-x64 (shard 1/2) e2e: 163 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 2:43, external-change.spec.ts 0:34, language-workbench.spec.ts 0:25
  ✘ windows-x64 (shard 2/2): failed at "Verify (harness, typecheck, lint, format, unit and integration tests)" — FAIL  tests/integration/watcher.test.ts > file watcher (S07.3) > entries that came and went within one batch are reported as deleted, a folder once — AssertionError: expected [ { type: 'deleted', …(1) }, …(1) ] to deeply equal ArrayContaining{…}
  ✘ windows-x64: failed at "Require every platform and shard" — Process completed with exit code 1.
  ✘ macos-arm64: failed at "Require every platform and shard" — Process completed with exit code 1.

Run 39015670923  failure  pull_request  claude/noobide-ui-ux-improvements-50c047  2026-10-17 07:59:27Z  wall-clock 22:11
  Job                                Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2)             5:07   0:20    0:03    0:56     0:19       14:47     15:06        0:27  16:58
  macos-arm64 (shard 2/2)            11:34   0:19    0:02    0:51     0:21        8:21      8:42           –   9:59
  windows-x64 (shard 1/2) [failure]   0:30   1:03    0:07    1:35     0:18        9:11      9:29           –  12:19
  windows-x64 (shard 2/2)             0:31   0:40    0:05    1:51     0:28        7:50      8:18           –  10:58
  macos-arm64 (shard 1/2) e2e: 163 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 10:11, external-change.spec.ts 0:33, language-workbench.spec.ts 0:25
  macos-arm64 (shard 2/2) e2e: 161 passed, 0 failed, 0 skipped; slowest preview-isolation.spec.ts 1:58, recovery.spec.ts 0:49, upgrade.spec.ts 0:30
  windows-x64 (shard 1/2) e2e: 162 passed, 1 failed, 3 skipped; slowest app-startup-restore.spec.ts 3:57, external-change.spec.ts 0:33, distribution.spec.ts 0:28
  ✘ windows-x64 (shard 1/2): failed at "End-to-end tests (Playwright + Electron)" — Error: expect(received).toBe(expected) // Object.is equality
  windows-x64 (shard 2/2) e2e: 160 passed, 0 failed, 1 skipped; slowest preview-isolation.spec.ts 2:00, recovery.spec.ts 0:33, runtime-problems.spec.ts 0:28
  ✘ windows-x64: failed at "Require every platform and shard" — Process completed with exit code 1.
  ✘ macos-arm64: failed at "Require every platform and shard" — Process completed with exit code 1.

Run 39015148835  success  pull_request  claude/s49-tree-typeahead-icons-8a9c6d  2026-10-17 07:50:41Z  wall-clock 24:02
  Job                      Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2)   8:01   0:16    0:03    0:42     0:13       14:20     14:33        0:18  15:54
  macos-arm64 (shard 2/2)  13:38   0:24    0:02    0:55     0:15        8:33      8:48           –  10:15
  windows-x64 (shard 1/2)   0:02   0:30    0:05    1:05     0:11        8:40      8:51        1:12  11:49
  windows-x64 (shard 2/2)   0:02   0:40    0:05    1:43     0:16        7:38      7:54           –  10:28
  macos-arm64 (shard 1/2) e2e: 167 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 10:08, external-change.spec.ts 0:32, language-workbench.spec.ts 0:24
  macos-arm64 (shard 2/2) e2e: 161 passed, 0 failed, 0 skipped; slowest preview-isolation.spec.ts 1:57, recovery.spec.ts 0:50, upgrade.spec.ts 0:31
  windows-x64 (shard 1/2) e2e: 167 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 4:29, external-change.spec.ts 0:33, language-workbench.spec.ts 0:24
  windows-x64 (shard 2/2) e2e: 160 passed, 0 failed, 1 skipped; slowest preview-isolation.spec.ts 1:58, recovery.spec.ts 0:33, smart-editing.spec.ts 0:26

Run 39015145940  failure  pull_request  claude/s49-splitter-physics-c88bff  2026-10-17 07:50:38Z  wall-clock 13:57
  Job                                Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2) [failure]  11:42   0:28    0:03    1:17        –           –         –           –   1:53
  macos-arm64 (shard 2/2) [failure]  12:10   0:27    0:03    1:06        –           –         –           –   1:40
  windows-x64 (shard 1/2)             0:02   0:41    0:05    1:50     0:18        6:55      7:13        1:46  11:43
  windows-x64 (shard 2/2)             0:03   0:42    0:05    1:46     0:16        7:47      8:03           –  10:44
  ✘ macos-arm64 (shard 1/2): failed at "Verify (harness, typecheck, lint, format, unit and integration tests)" — FAIL  tests/integration/e2e-shards.test.ts > two real Playwright shard selections cover every E2E test exactly once — AssertionError: expected false to be true // Object.is equality
  ✘ macos-arm64 (shard 2/2): failed at "Verify (harness, typecheck, lint, format, unit and integration tests)" — FAIL  tests/integration/e2e-shards.test.ts > two real Playwright shard selections cover every E2E test exactly once — AssertionError: expected false to be true // Object.is equality
  windows-x64 (shard 1/2) e2e: 163 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 2:19, external-change.spec.ts 0:34, language-workbench.spec.ts 0:25
  windows-x64 (shard 2/2) e2e: 165 passed, 0 failed, 1 skipped; slowest preview-isolation.spec.ts 1:58, recovery.spec.ts 0:34, runtime-problems.spec.ts 0:32
  ✘ windows-x64: failed at "Require every platform and shard" — Process completed with exit code 1.
  ✘ macos-arm64: failed at "Require every platform and shard" — Process completed with exit code 1.

Run 39015143213  success  pull_request  claude/s48-chat-core-9b1e35  2026-10-17 07:50:36Z  wall-clock 20:27
  Job                      Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2)   2:33   0:24    0:04    1:03     0:20        7:08      7:28        0:26   9:31
  macos-arm64 (shard 2/2)   9:21   0:23    0:03    1:08     0:18        9:02      9:20           –  10:59
  windows-x64 (shard 1/2)   0:02   0:38    0:05    1:42     0:16        7:04      7:20        1:33  11:24
  windows-x64 (shard 2/2)   0:02   0:35    0:04    1:20     0:14        7:11      7:25           –   9:29
  macos-arm64 (shard 1/2) e2e: 166 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 2:01, external-change.spec.ts 0:33, language-workbench.spec.ts 0:25
  macos-arm64 (shard 2/2) e2e: 161 passed, 0 failed, 0 skipped; slowest preview-isolation.spec.ts 1:56, recovery.spec.ts 0:58, upgrade.spec.ts 0:32
  windows-x64 (shard 1/2) e2e: 166 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 2:21, external-change.spec.ts 0:35, language-workbench.spec.ts 0:25
  windows-x64 (shard 2/2) e2e: 160 passed, 0 failed, 1 skipped; slowest preview-isolation.spec.ts 1:58, recovery.spec.ts 0:33, runtime-problems.spec.ts 0:26

Run 39015139685  failure  pull_request  claude/beautiful-shirley-d2ba80  2026-10-17 07:50:33Z  wall-clock 26:16
  Job                                Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2)             9:19   0:19    0:03    0:46     0:15       14:55     15:10        0:26  16:50
  macos-arm64 (shard 2/2) [failure]   0:07   0:28    0:04    1:17     0:22        9:12      9:34           –  11:32
  windows-x64 (shard 1/2)             0:02   0:42    0:05    1:44     0:16       10:29     10:45        1:53  15:16
  windows-x64 (shard 2/2) [failure]   0:02   0:39    0:04    1:45     0:17        7:54      8:11           –  10:46
  macos-arm64 (shard 1/2) e2e: 163 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 10:14, external-change.spec.ts 0:35, language-workbench.spec.ts 0:25
  macos-arm64 (shard 2/2) e2e: 157 passed, 2 failed, 6 skipped; slowest preview-isolation.spec.ts 2:06, recovery.spec.ts 0:53, upgrade.spec.ts 0:34
  ✘ macos-arm64 (shard 2/2): failed at "End-to-end tests (Playwright + Electron)" — Error: 20 workers at once, each with a saved console.log
  windows-x64 (shard 1/2) e2e: 163 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 6:06, external-change.spec.ts 0:35, language-workbench.spec.ts 0:25
  windows-x64 (shard 2/2) e2e: 162 passed, 1 failed, 2 skipped; slowest preview-isolation.spec.ts 1:58, recovery.spec.ts 0:41, runtime-problems.spec.ts 0:26
  ✘ windows-x64 (shard 2/2): failed at "End-to-end tests (Playwright + Electron)" — Error: expect(received).toEqual(expected) // deep equality
  ✘ windows-x64: failed at "Require every platform and shard" — Process completed with exit code 1.
  ✘ macos-arm64: failed at "Require every platform and shard" — Process completed with exit code 1.

Run 39015034829  cancelled  pull_request  claude/noobide-ui-ux-improvements-50c047  2026-10-17 07:48:51Z  wall-clock 11:05
  Job                                  Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2) [cancelled]   0:34   0:29    0:05    1:38        –           –      8:02           –  10:25
  macos-arm64 (shard 2/2) [cancelled]   0:34   0:30    0:04    1:18        –           –      8:23           –  10:22
  windows-x64 (shard 1/2) [failure]     0:27   0:38    0:06    1:50        –           –         –           –   2:39
  windows-x64 (shard 2/2)               0:27   0:33    0:05    1:15     0:15        7:01      7:16           –   9:15
  ✘ macos-arm64 (shard 1/2): failed at "Upload E2E timing report"
  ✘ macos-arm64 (shard 2/2): failed at "Upload E2E timing report"
  ✘ windows-x64 (shard 1/2): failed at "Verify (harness, typecheck, lint, format, unit and integration tests)" — FAIL  tests/integration/history-groups.test.ts > recording an agent turn (S34.2) > keeps the newest groups within the limit, newest first; a group-only index is not deleted — Error: Test timed out in 5000ms.
  windows-x64 (shard 2/2) e2e: 160 passed, 0 failed, 1 skipped; slowest preview-isolation.spec.ts 1:54, recovery.spec.ts 0:28, runtime-problems.spec.ts 0:26
  ✘ windows-x64: failed at "Require every platform and shard" — Process completed with exit code 1.
  ✘ macos-arm64: failed at "Require every platform and shard" — Process completed with exit code 1.

Run 39014627704  success  pull_request  claude/dazzling-shtern-8a5721  2026-10-17 07:42:23Z  wall-clock 41:04
  Job                      Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2)   0:05   0:16    0:02    0:43     0:13       14:27     14:40        0:23  16:09
  macos-arm64 (shard 2/2)  32:16   0:16    0:02    0:43     0:11        7:25      7:36           –   8:41
  windows-x64 (shard 1/2)   0:02   0:40    0:04    1:38     0:16        7:13      7:29        1:33  11:30
  windows-x64 (shard 2/2)   0:02   0:45    0:05    1:44     0:17        7:31      7:48           –  10:28
  macos-arm64 (shard 1/2) e2e: 163 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 10:08, external-change.spec.ts 0:34, language-workbench.spec.ts 0:25
  macos-arm64 (shard 2/2) e2e: 161 passed, 0 failed, 0 skipped; slowest preview-isolation.spec.ts 1:53, recovery.spec.ts 0:36, upgrade.spec.ts 0:28
  windows-x64 (shard 1/2) e2e: 163 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 2:34, external-change.spec.ts 0:35, language-workbench.spec.ts 0:25
  windows-x64 (shard 2/2) e2e: 160 passed, 0 failed, 1 skipped; slowest preview-isolation.spec.ts 1:58, recovery.spec.ts 0:34, runtime-problems.spec.ts 0:26

Run 39014335171  cancelled  pull_request  claude/noobide-ui-ux-improvements-50c047  2026-10-17 07:37:39Z  wall-clock 11:38
  Job                                  Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2) [failure]     0:21   0:24    0:03    1:04        –           –         –           –   1:36
  macos-arm64 (shard 2/2) [cancelled]   0:22   0:29    0:04    1:14        –           –      9:15           –  11:09
  windows-x64 (shard 1/2) [failure]     0:16   0:38    0:05    1:51        –           –         –           –   2:40
  windows-x64 (shard 2/2)               0:17   0:43    0:05    1:43     0:17        7:51      8:08           –  10:46
  ✘ macos-arm64 (shard 1/2): failed at "Verify (harness, typecheck, lint, format, unit and integration tests)" — FAIL  src/renderer/editor/completion-latency.test.ts > completion latency budget (S43.6) > a selector and a path request each take <= 10 ms p95 on a 200-file project — AssertionError: expected 10.894542000000001 to be less than or equal to 10
  ✘ macos-arm64 (shard 2/2): failed at "Upload E2E timing report"
  ✘ windows-x64 (shard 1/2): failed at "Verify (harness, typecheck, lint, format, unit and integration tests)" — FAIL  src/renderer/editor/completion-latency.test.ts > completion latency budget (S43.6) > a selector and a path request each take <= 10 ms p95 on a 200-file project — AssertionError: expected 12.799599999999998 to be less than or equal to 10
  windows-x64 (shard 2/2) e2e: 160 passed, 0 failed, 1 skipped; slowest preview-isolation.spec.ts 1:58, recovery.spec.ts 0:33, runtime-problems.spec.ts 0:26
  ✘ macos-arm64: failed at "Require every platform and shard" — Process completed with exit code 1.
  ✘ windows-x64: failed at "Require every platform and shard" — Process completed with exit code 1.

Run 39013013887  cancelled  pull_request  claude/noobide-ui-ux-improvements-50c047  2026-10-17 07:16:21Z  wall-clock 21:32
  Job                                  Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2)               0:06   0:20    0:03    0:50     0:15       14:46     15:01        0:25  16:44
  macos-arm64 (shard 2/2)               0:08   0:30    0:05    1:22     0:19        9:16      9:35           –  11:41
  windows-x64 (shard 1/2)               0:02   0:50    0:05    1:38     0:16        7:28      7:44        1:34  11:56
  windows-x64 (shard 2/2) [cancelled]  19:06   0:48    0:06    1:18        –        7:47         –           –   2:18
  macos-arm64 (shard 1/2) e2e: 163 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 10:10, external-change.spec.ts 0:34, language-workbench.spec.ts 0:25
  macos-arm64 (shard 2/2) e2e: 161 passed, 0 failed, 0 skipped; slowest preview-isolation.spec.ts 1:58, recovery.spec.ts 1:02, upgrade.spec.ts 0:35
  windows-x64 (shard 1/2) e2e: 163 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 2:54, external-change.spec.ts 0:36, language-workbench.spec.ts 0:25
  windows-x64 (shard 2/2) e2e: 148 passed, 1 failed, 12 skipped; slowest preview-isolation.spec.ts 2:00, recovery.spec.ts 0:37, runtime-problems.spec.ts 0:34
  ✘ windows-x64 (shard 2/2): failed at "Upload E2E timing report"
  ✘ macos-arm64: failed at "Require every platform and shard" — Process completed with exit code 1.
  ✘ windows-x64: failed at "Require every platform and shard" — Process completed with exit code 1.

Run 39011765635  success  pull_request  claude/noobide-ui-ux-assessment-d4624a  2026-10-17 06:56:27Z  wall-clock 19:07
  Job                      Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2)   0:31   0:25    0:03    1:04     0:22       16:01     16:23        0:27  18:29
  macos-arm64 (shard 2/2)   0:28   0:17    0:02    0:45     0:13        8:00      8:13           –   9:23
  windows-x64 (shard 1/2)   0:24   0:42    0:05    1:51     0:18        8:59      9:17        1:37  13:39
  windows-x64 (shard 2/2)   0:25   0:44    0:05    1:47     0:17        8:09      8:26           –  11:09
  macos-arm64 (shard 1/2) e2e: 166 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 10:17, external-change.spec.ts 0:37, language-workbench.spec.ts 0:25
  macos-arm64 (shard 2/2) e2e: 168 passed, 0 failed, 0 skipped; slowest preview-isolation.spec.ts 1:55, recovery.spec.ts 0:47, upgrade.spec.ts 0:30
  windows-x64 (shard 1/2) e2e: 166 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 3:24, external-change.spec.ts 0:34, language-workbench.spec.ts 0:25
  windows-x64 (shard 2/2) e2e: 167 passed, 0 failed, 1 skipped; slowest preview-isolation.spec.ts 2:07, recovery.spec.ts 0:38, runtime-problems.spec.ts 0:32

Run 39011559538  failure  push  main  2026-10-17 06:53:09Z  wall-clock 11:30
  Job                                Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2) [failure]   0:08   0:27    0:04    1:09        –           –         –           –   1:44
  macos-arm64 (shard 2/2)             0:06   0:19    0:02    0:43     0:14        7:31      7:45           –   8:55
  windows-x64 (shard 1/2)             0:02   0:40    0:05    1:38     0:16        6:48      7:04        1:47  11:20
  windows-x64 (shard 2/2) [failure]   0:03   0:49    0:05    1:39     0:17        8:02      8:19           –  11:00
  ✘ macos-arm64 (shard 1/2): failed at "Verify (harness, typecheck, lint, format, unit and integration tests)" — FAIL  src/renderer/editor/completion-latency.test.ts > completion latency budget (S43.6) > a selector and a path request each take <= 10 ms p95 on a 200-file project — AssertionError: expected 21.368790999999987 to be less than or equal to 10
  macos-arm64 (shard 2/2) e2e: 161 passed, 0 failed, 0 skipped; slowest preview-isolation.spec.ts 1:54, recovery.spec.ts 0:36, upgrade.spec.ts 0:29
  windows-x64 (shard 1/2) e2e: 163 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 2:17, external-change.spec.ts 0:35, language-workbench.spec.ts 0:25
  windows-x64 (shard 2/2) e2e: 148 passed, 1 failed, 12 skipped; slowest preview-isolation.spec.ts 1:58, recovery.spec.ts 0:34, walkthrough.spec.ts 0:32
  ✘ windows-x64 (shard 2/2): failed at "End-to-end tests (Playwright + Electron)" — Error: expect(locator).toHaveAttribute(expected) failed
  ✘ windows-x64: failed at "Require every platform and shard" — Process completed with exit code 1.
  ✘ macos-arm64: failed at "Require every platform and shard" — Process completed with exit code 1.

Run 39010518591  success  pull_request  codex/ci-cd-delivery  2026-10-17 06:36:07Z  wall-clock 16:48
  Job                      Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2)   0:07   0:27    0:04    0:54     0:17       14:26     14:43        0:20  16:35
  macos-arm64 (shard 2/2)   0:06   0:24    0:04    0:59     0:18        8:19      8:37           –  10:10
  windows-x64 (shard 1/2)   0:02   0:28    0:04    1:07     0:10        8:15      8:25        1:18  11:28
  windows-x64 (shard 2/2)   0:02   0:43    0:04    1:44     0:17        7:45      8:02           –  10:39
  macos-arm64 (shard 1/2) e2e: 163 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 10:08, external-change.spec.ts 0:33, language-workbench.spec.ts 0:24
  macos-arm64 (shard 2/2) e2e: 161 passed, 0 failed, 0 skipped; slowest preview-isolation.spec.ts 1:57, recovery.spec.ts 0:45, upgrade.spec.ts 0:30
  windows-x64 (shard 1/2) e2e: 163 passed, 0 failed, 3 skipped; slowest app-startup-restore.spec.ts 4:26, external-change.spec.ts 0:33, language-workbench.spec.ts 0:24
  windows-x64 (shard 2/2) e2e: 160 passed, 0 failed, 1 skipped; slowest preview-isolation.spec.ts 1:58, recovery.spec.ts 0:32, runtime-problems.spec.ts 0:26

Run 39000141670  failure  pull_request  codex/ci-cd-delivery  2026-10-17 03:47:44Z  wall-clock 10:32
  Job                                Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 (shard 1/2) [failure]   7:52   0:27    0:03    1:24        –           –         –           –   1:59
  macos-arm64 (shard 2/2) [failure]   7:53   0:30    0:03    1:16        –           –         –           –   1:52
  windows-x64 (shard 1/2) [failure]   7:48   0:33    0:04    1:11        –           –         –           –   1:52
  windows-x64 (shard 2/2) [failure]   7:48   0:43    0:05    1:45        –           –         –           –   2:38
  ✘ macos-arm64 (shard 1/2): failed at "Verify (harness, typecheck, lint, format, unit and integration tests)" — SyntaxError: Expected ',' or '}' after property value in JSON at position 235611 (line 4257 column 7)
  ✘ macos-arm64 (shard 2/2): failed at "Verify (harness, typecheck, lint, format, unit and integration tests)" — SyntaxError: Expected ',' or '}' after property value in JSON at position 235611 (line 4257 column 7)
  ✘ windows-x64 (shard 1/2): failed at "Verify (harness, typecheck, lint, format, unit and integration tests)" — SyntaxError: Expected ',' or '}' after property value in JSON at position 235611 (line 4257 column 7)
  ✘ windows-x64 (shard 2/2): failed at "Verify (harness, typecheck, lint, format, unit and integration tests)" — SyntaxError: Expected ',' or '}' after property value in JSON at position 235611 (line 4257 column 7)
  ✘ windows-x64: failed at "Require every platform and shard" — Process completed with exit code 1.
  ✘ macos-arm64: failed at "Require every platform and shard"

Run 38999713610  cancelled  pull_request  claude/noobide-ui-ux-assessment-d4624a  2026-10-17 03:40:53Z  wall-clock 3:15:57
  Job                        Queue  Setup  Faults  Verify  Package  Playwright  E2E step  Installers  Total
  macos-arm64 [cancelled]  3:07:03   0:37    0:05    1:48        –           –      6:14           –   8:53
  windows-x64                 0:02   0:42    0:05    1:39        –           –     15:36        2:01  20:08

Successful runs, by measure (median / max):
  Measure                  n  Median    Max
  wallClock                5   20:27  41:04
  queue:macos-arm64       10    2:33  32:16
  total:macos-arm64       10   10:59  18:29
  playwright:macos-arm64  10    9:02  16:01
  queue:windows-x64       10    0:02   0:25
  total:windows-x64       10   11:24  13:39
  playwright:windows-x64  10    7:45   8:59

16 job(s) queued for more than a minute (plan §2: macOS concurrency).
```

<!-- BASELINE-END -->

## Measured result (after S50.1–S50.4 are merged)

TODO — fill in once S50.1–S50.4 are on `main` and at least 20 `CI` runs have completed on top of them:

```bash
node scripts/ci-timings.mjs --runs 20 --no-steps
```

Paste the output here under "After", then record in the table below the same measures as plan §3 (median of
successful runs; the aggregate block at the end of the tool's output gives wall-clock, queue, job total and
Playwright per target). `node scripts/ci-timings.mjs --failures` lists the red runs with their failing step and
first error line; count those whose cause is not the PR's code.

| Measure                                       | Before (baseline above)                  | After | Target (plan §3)   |
| --------------------------------------------- | ---------------------------------------- | ----- | ------------------ |
| Red runs whose cause is not the PR's code     | 3 of the last 5 red runs (plan §1)       | TODO  | 0                  |
| Wall-clock, successful run, median            | 20:27 (n = 5)                            | TODO  | ≤ 9:00 (no queue)  |
| Queue, macOS, median / max                    | 2:33 / 32:16                             | TODO  | —                  |
| Job total, median, windows-x64 / macos-arm64  | 11:24 / 10:59                            | TODO  | —                  |
| Playwright, median, windows-x64 / macos-arm64 | 7:45 / 9:02 (macOS shard 1 alone: 14:20) | TODO  | shards within 60 s |
| Docs-only PR wall-clock                       | same as a code PR (~20 min)              | TODO  | ≤ 3:00             |
| Time to first lint/format/typecheck failure   | after verify on each OS job (2–12 min)   | TODO  | ≤ 2:00             |
