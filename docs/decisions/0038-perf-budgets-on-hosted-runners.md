# 0038 — Performance budgets: enforced on developer machines, reported on hosted runners

- **Status:** accepted
- **Date:** 2026-10-17
- **Feature:** S50.3 (plan: docs/ci/ci-stability-and-speed-plan.md §4; inventory: docs/perf/ci-runners.md)

## Context

NoobIDE carries wall-clock budgets from its product targets (docs/perf/targets.md, decision 0032): the completion
provider answers in ≤ 10 ms p95, indentation detection and symbol extraction stay inside a typing frame, the file
watcher never stalls the main process for more than 500 ms during a mass delete, the problem store absorbs a console
flood. Each budget was measured on the Windows x64 dev machine (docs/perf/win32-x64.md, completion-latency.md) and
asserted with `expect(ms).toBeLessThan(budget)` inside the ordinary unit and integration suites, so every CI job
asserted them too.

Hosted GitHub runners are shared, 2–4 vCPU machines with virtualised disks and noisy neighbours. On 2026-10-17 run
39011559538 failed on macOS because the completion p95 came out at 21.4 ms (2.1× the budget) with no change to the
provider; run 39018194387 ran the whole unit suite in 86 s instead of ≈ 25 s on a starved Windows runner and hit six
5 s / 30 s timeouts in disk-heavy integration tests (history-groups, history-store, watcher), plus two watcher tests
whose 60–120 ms pauses had been sized against 150–300 ms rename waits. None of the five red runs that week was caused
by the change under test; developers and agent sessions had started to treat CI as noise, which is the real cost.

Two kinds of timing assertion were mixed in the same suites:

- a **performance budget** says "this is fast enough on the reference machine" — a number whose meaning depends on
  the machine it was measured on;
- a **functional timeout** says "this event must arrive at all" — the bound only has to be generous enough that a slow
  machine still meets it.

## Options considered

1. **Loosen every budget until hosted runners pass.** A 10 ms p95 budget becomes 50 ms; the assertion then catches
   nothing on the dev machine (a 5× regression still passes) and still flakes on a 10× slower runner. Rejected: the
   budgets are product promises (PLAN §9), not CI tuning knobs.
2. **Retry timing tests on failure.** Hides the problem, doubles the cost of the slow case, and docs/testing.md says a
   flaky test is a bug. Rejected.
3. **Skip the budget tests on CI (`describe.skipIf(CI)`).** Keeps the dev-machine signal but throws the hosted numbers
   away, so a real regression on macOS (where no developer machine measures) would go unseen until a beta tester
   reports it. Rejected.
4. **Run the budget tests on self-hosted runners with known hardware.** The right long-term answer for publishing
   numbers, but it needs hardware the project does not have (H.1, H.5) and a security review for self-hosted runners
   on a public repository. Deferred; nothing here prevents it.
5. **Two modes for the same tests (chosen).** The budget is read through one helper. On developer machines the budget
   is enforced, so `npm run verify` is the pass/fail oracle it always was. On GitHub Actions the same tests run, the
   numbers are kept, and the test fails only on an error or a result more than 5× over budget. Functional timeouts stay
   in the default suite, sized for a slow runner.

## Decision

- **A `perf` Vitest project** (`vitest.perf.config.ts`, files `tests/perf/*.perf.test.ts`, `npm run test:perf`) holds
  every performance budget: completion latency and throughput, indentation detection, symbol extraction, the problem
  store's CPU bound and the watcher's event-loop lag. It is excluded from `npm test`, runs one file at a time on one
  worker (a measurement must not share the CPU with other test files), and the moved files keep their git history.
- **One helper, `tests/perf/budget.ts`,** is the only way a perf test reads its budget. `checkBudget(name, value,
budget)` records every measurement to `reports/perf/<platform>-<arch>.json` and then:
  - **enforce mode** (default; developer machines, `npm run verify`): throws when `value > budget`;
  - **report mode** (`GITHUB_ACTIONS` set, or `NOOBIDE_PERF_MODE=report`): throws only when the value is not a finite
    number (an error in the test) or `value > 5 × budget`. A regression of that size is real on any machine; anything
    smaller is recorded as "over budget (reported)". The 5× factor is deliberately crude: the point is a floor under
    catastrophic regressions, not a second budget.
  - The project's global setup empties the report at the start of a run and, on GitHub Actions, appends the report as
    a table to the job summary at the end.
- **`npm run verify` gains a `perf` gate** after `test` (skipped with `--quick`). Proven by tightening one budget:
  the gate goes red on the dev machine and the same tightened budget is only reported in report mode.
- **`.github/workflows/perf.yml`** runs `test:perf` on windows-latest (x64) and macos-14 (arm64) on push to `main`,
  nightly and on dispatch, uploads `reports/perf/` per target, and is **not** a required check and never runs on pull
  requests. `ci.yml` keeps running plain `npm test`, so the required matrix contains no budget assertion; S50.1 and
  S50.3 therefore never edit the same workflow file.
- **Functional timeouts stay functional** and are sized for a runner several times slower than the dev machine: at
  least 4× the local duration and at least 1.5× the longest duration seen on a hosted runner, including the starved one
  (history-groups 60 s, history-store's 125-write case 180 s, the watcher's rescan 60 s). The two watcher cases that
  reported one event too many were test pauses racing a rename wait; the waits are now 1 s against 60–120 ms pauses and
  the "folder with files" case uses a 500 ms debounce. The watcher itself is unchanged.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- A hosted run can no longer go red because a shared runner was slow; it can still go red because a change made
  something 5× slower, and the nightly report shows drifts smaller than that. Budgets are only _proven_ on the dev
  machine, which docs/perf already says.
- Developers keep the same signal: `npm run verify` fails on a budget miss, and the perf gate adds ≈ 2.5 s locally.
- Every measurement is now named and recorded, so docs/perf numbers can be refreshed from `reports/perf/*.json`
  instead of a `NOOBIDE_PERF_PRINT` console line.
- Risk: the hosted numbers are informational and nobody is forced to read them. Mitigation: the job summary table on
  every `main` push and nightly run, `docs/perf/ci-runners.md` §3 to be filled from the first runs (owner check
  MANUAL-CHECKS.md#S50.3), and S50.5 / ADR 0037 reviewing the measurements.
- Risk: a hosted runner more than 5× slower than the dev machine fails a nightly perf run. Acceptable: it is not a
  required check, and the report says which measurement and by how much.
- Verification: `tests/integration/perf-budget.test.ts` (the two modes, the 5× rule, the report file, the job
  summary), `tests/integration/perf-workflow.test.ts` (triggers, permissions, matrix, pinned SHAs identical to ci.yml,
  artifact upload, no Electron import in the perf project, the default config excludes it, ci.yml never runs it),
  `npm run verify` green on Windows x64 with the gate, and the first hosted `perf.yml` runs on both targets
  (MANUAL-CHECKS.md#S50.3) leaving one report per OS.
