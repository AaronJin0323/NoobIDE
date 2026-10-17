# Timing assertions and hosted runners (S58.3)

Decision [0038](../decisions/0038-perf-budgets-on-hosted-runners.md). Plan: [ci-stability-and-speed-plan.md](../ci/ci-stability-and-speed-plan.md) §4 "S58.3".

Two hosted runs failed in October 2026 for reasons unrelated to the change under test: run 39011559538 asserted a
10 ms p95 completion budget on a hosted macOS runner (21.4 ms), and run 39018194387 ran the unit suite in 86 s instead
of ≈ 25 s on a starved Windows runner and hit six 5 s / 30 s test timeouts in disk-heavy integration tests. This page
is the inventory behind the fix: every `toBeLessThan` / `toBeLessThanOrEqual` assertion and every explicit test
timeout in `src/**/*.test.ts` and `tests/integration/**/*.test.ts`, classified as one of

- **performance budget** — a p95 latency, a median, a max event-loop lag, a throughput bound. Measured on the dev
  machine (Windows 11, 32 logical cores; see [win32-x64.md](win32-x64.md), [completion-latency.md](completion-latency.md)).
  Moved to the `perf` project (`tests/perf/*.perf.test.ts`, `npm run test:perf`), read through `tests/perf/budget.ts`:
  enforced by `npm run verify` on developer machines, reported on GitHub Actions (`.github/workflows/perf.yml`, not a
  required check) where the test fails only on an error or a result more than 5× over budget;
- **functional timeout** — an event must arrive within N seconds, a cancellation must return promptly, a probe must
  give up within its own limit. Stays in `npm test`, sized for a runner several times slower than the dev machine;
- **not a timing assertion** — a count, a byte size, a string length, a DOM or list order, a geometry bound, a constant.
  Listed so the inventory is complete; nothing to do.

## 1. `toBeLessThan` / `toBeLessThanOrEqual` assertions (36 files)

| File (line at the time of S58.3)                                | What is compared                                          | Class                   | Where now                                                                                     |
| --------------------------------------------------------------- | --------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| `src/renderer/editor/completion-latency.test.ts:62-63`          | p95 of the completion provider ≤ 10 ms (classes, paths)   | performance budget      | `tests/perf/completion-latency.perf.test.ts` (git mv)                                         |
| `src/renderer/editor/completion-perf.test.ts:51,67`             | median < 50 ms: extract 200 files; context on 2 000 chars | performance budget      | `tests/perf/completion-perf.perf.test.ts` (git mv)                                            |
| `src/renderer/editor/indent-detect.test.ts:260`                 | median < 20 ms: indentation of a 5 000-line file          | performance budget      | `tests/perf/indent-detect.perf.test.ts`; the 51 correctness cases stay                        |
| `src/renderer/editor/project-symbols.test.ts:75`                | < 500 ms: symbols of a 256 KB document                    | performance budget      | `tests/perf/project-symbols.perf.test.ts`; the correctness half of the case stays             |
| `src/diagnostics/store.test.ts:131`                             | best-of-3 CPU time < 2 s for 100k events                  | performance budget      | `tests/perf/problem-store.perf.test.ts` (CPU time, so robust to load, but a throughput bound) |
| `tests/integration/watcher.test.ts:337`                         | max event-loop lag < 500 ms during a 3 000-file delete    | performance budget      | `tests/perf/watcher-mass-delete.perf.test.ts`; the rescan + snapshot check stays              |
| `tests/integration/project-search.test.ts:220-225` (S51.2)      | search of 2 000 files < 1 s, max event-loop gap < 100 ms  | performance budget      | `tests/perf/project-search.perf.test.ts`; the 2 000-file functional case stays (PR #22)       |
| `src/ai/fake-provider.test.ts:156`                              | cancelling a slow fake stream returns in < 5 s            | functional timeout      | stays (the script is paced in ms; 5 s is the "did not hang" bound)                            |
| `src/preview/page-snapshot.test.ts:203`                         | a 50 ms outline timeout fires in < 1 s                    | functional timeout      | stays (20× headroom over the timer it checks)                                                 |
| `tests/integration/wake-recovery.test.ts:151`                   | `answers(300)` gives up in < 2 s on a silent socket       | functional timeout      | stays (6.7× headroom over the probe's own 300 ms)                                             |
| `src/renderer/recovery/journal-scheduler.test.ts:56-57,106-108` | journal copies ≤ 2 s apart                                | logical time            | stays: fake timers (`vi.advanceTimersByTimeAsync`), no wall clock                             |
| `src/renderer/workbench/typing-reporter.test.ts:70`             | last report ≤ 150 ms after the last key                   | logical time            | stays: injected clock and timers                                                              |
| `src/platform/power-events.test.ts:8`                           | drift interval constant ≤ 10 s                            | not timing (constant)   | stays                                                                                         |
| `src/preview/page-guard.test.ts:372,387`                        | pending timers ≤ 1; worker console limit < page limit     | not timing (counts)     | stays                                                                                         |
| `src/diagnostics/store.test.ts:129`                             | list length ≤ 1 000                                       | not timing (count)      | stays (also asserted inside the perf test)                                                    |
| `src/ai/chat-store.test.ts:138`                                 | kept turns < 4                                            | not timing (count)      | stays                                                                                         |
| `src/ai/generate-prompt.test.ts:83`                             | `<before>` comes before `<after>`                         | not timing (order)      | stays                                                                                         |
| `src/diagnostics/runtime-capture.test.ts:395`                   | console records ≤ 300                                     | not timing (count)      | stays                                                                                         |
| `src/preview/page-snapshot.test.ts:156`                         | outline text ≤ `SNAPSHOT_LIMITS.outlineChars`             | not timing (size)       | stays                                                                                         |
| `src/renderer/ai/ai-prompt-model.test.ts:186-187`               | context lengths ≤ `GENERATE_CONTEXT_CHARS`                | not timing (size)       | stays                                                                                         |
| `src/renderer/ai/chat-panel.test.ts:140-141`                    | DOM order context < input < send                          | not timing (order)      | stays                                                                                         |
| `src/renderer/ai/inline-context.test.ts:96-97`                  | prefix ≤ 200, suffix ≤ 100 chars                          | not timing (size)       | stays                                                                                         |
| `src/renderer/ai/inline-edit-model.test.ts:59-60,273,276`       | context lengths; accept before reject in the DOM          | not timing (size/order) | stays                                                                                         |
| `src/renderer/ai/inline-postprocess.test.ts:41`                 | suggestion ≤ `INLINE_MAX_SUGGESTION_CHARS`                | not timing (size)       | stays                                                                                         |
| `src/renderer/annotations/annotations-model.test.ts:89,154-155` | summary < 60 chars; rectangle inside the unit square      | not timing              | stays                                                                                         |
| `src/renderer/problems/ai-fix.test.ts:142-143`                  | DOM order of the problem actions                          | not timing (order)      | stays                                                                                         |
| `src/renderer/workbench/disk-sync.test.ts:395`                  | decoration start ≤ 1                                      | not timing (index)      | stays                                                                                         |
| `src/renderer/workbench/file-role.test.ts:67-68`                | label lengths (zh-CN ≤ 6, en ≤ 22)                        | not timing (size)       | stays                                                                                         |
| `src/renderer/workbench/icons.test.ts:74`                       | effective stroke within 0.05 of 1.5                       | not timing (geometry)   | stays                                                                                         |
| `src/renderer/workbench/layout.test.ts:103`                     | panes fit the window height                               | not timing (geometry)   | stays                                                                                         |
| `tests/integration/ai-agent-preview.test.ts:187`                | text order in the agent context                           | not timing (order)      | stays                                                                                         |
| `tests/integration/app-log.test.ts:90`                          | log file size ≤ 400 (rotation)                            | not timing (size)       | stays                                                                                         |
| `tests/integration/ci-workflow.test.ts:139`                     | step order in ci.yml                                      | not timing (order)      | stays                                                                                         |
| `tests/integration/distribution.test.ts:96`                     | ICO directory offsets inside the file                     | not timing (size)       | stays                                                                                         |
| `tests/integration/entry-pages.test.ts:52`                      | page order                                                | not timing (order)      | stays                                                                                         |
| `tests/integration/history-store.test.ts:158,184`               | total bytes ≤ 100; kept versions ≤ 63                     | not timing (size/count) | stays                                                                                         |
| `tests/integration/recovery-journal.test.ts:197`                | journal usage ≤ 3 000 bytes                               | not timing (size)       | stays                                                                                         |
| `tests/integration/release-workflow.test.ts:125`                | step order in release.yml                                 | not timing (order)      | stays                                                                                         |
| `tests/integration/templates.test.ts:85`                        | template files ≤ 120 lines                                | not timing (size)       | stays                                                                                         |
| `tests/integration/watcher.test.ts:338`                         | snapshot size < 10 after the delete                       | not timing (count)      | stays                                                                                         |

After S58.3 the default `npm test` (and so every `ci.yml` job) contains no p95, median, lag or throughput assertion.
`tests/integration/perf-workflow.test.ts` keeps it that way structurally; the grep above is the review check:

```bash
grep -rnE "toBeLessThan(OrEqual)?\(" src tests/integration --include=*.test.ts
```

## 2. Test timeouts (explicit or tightened)

Default Vitest timeout: 5 s per test, 10 s per hook. Local durations are the verbose run on the dev machine on
2026-10-17; hosted durations come from run 39018194387 (Windows shard 1 starved: six timeouts; shard 2 and both macOS
jobs green on the same commit).

| File                                                                                                                                   | Timeout before → after                               | Local (dev machine)            | Hosted (run 39018194387)                                                                | Class                               |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- | ----------------------------------- |
| `tests/integration/history-groups.test.ts` (10 tests)                                                                                  | 5 s default → 60 s per test (`REAL_IO`)              | longest 0.37 s, file 0.8 s     | win shard 1: two tests > 5 s, file 21 s; win shard 2: 2.3 s; mac: 0.38 s                | functional (real saves + snapshots) |
| `tests/integration/history-store.test.ts` "coalesces a save burst"                                                                     | 30 s → 180 s                                         | 1.07 s                         | win shard 1: > 30 s (timed out); win shard 2: file 5.9 s; mac: file 0.97 s              | functional (125 atomic writes)      |
| `tests/integration/history-store.test.ts` other 18 tests                                                                               | 5 s default (unchanged)                              | ≤ 0.14 s                       | passed on every job                                                                     | functional                          |
| `tests/integration/history-triggers.test.ts`                                                                                           | 60 s (`REAL_IO`, unchanged)                          | —                              | passed                                                                                  | functional (real I/O)               |
| `tests/integration/watcher.test.ts` `describe` (18 tests)                                                                              | 15 s per test (unchanged); polls 1 s → 5 s           | longest 1.3 s; sleeps dominate | win shard 1: 31 s file, 2 wrong-event failures (below); win shard 2: 17.6 s; mac 14.9 s | functional (OS watch delivery)      |
| `tests/integration/watcher.test.ts` mass delete                                                                                        | 20 s → 60 s; the lag probe left for the perf project | 1.47 s                         | passed                                                                                  | functional (one rescan must arrive) |
| `tests/integration/e2e-shards.test.ts`                                                                                                 | 120 s / 360 s (unchanged)                            | —                              | passed                                                                                  | functional (`playwright --list`)    |
| `src/platform/eslint-rule.test.ts`                                                                                                     | 20 s (unchanged)                                     | —                              | passed                                                                                  | functional (spawns ESLint)          |
| `tests/integration/ai-history.test.ts` poll 10 s, `save-pipeline.test.ts` waits 2 s / 5 s, `preview-server.test.ts` client timeout 2 s | unchanged                                            | —                              | passed                                                                                  | functional                          |

Sizing rule used: a timeout is at least 4× the local duration **and** at least 1.5× the longest duration seen on a
hosted runner, including the starved one. For the two files that timed out the hosted figure dominates, which is why
the new timeouts are 60 s and 180 s rather than "4× local": that runner was 20–30× slower on disk writes, not 4×.
A long timeout costs nothing on a green run; it only decides how long a genuinely hung test takes to fail.

### The two watcher cases that were wrong events, not timeouts

Both failed in run 39018194387 with the right events plus one more. Both were timing assumptions in the test, not in
the watcher; the fixes change only the tests' waits.

- **"reports a deletion without a partner once its wait is over; a file back within the wait as deleted, then
  created"** — 3 events instead of 2. The test deleted a file, paused 60 ms, wrote it back and then delivered the raw
  event, against a 150 ms rename wait. On the starved runner the 60 ms pause outlived the 150 ms wait: the watcher's
  held-deletion timer fired after the rewrite had completed but before the test's raw event, so it reported `deleted`
  - `created` (the file is back) and then, for the raw event, `changed` — exactly what the OS watch would have made it
    do. Fix: a 1 s rename wait (margin 12–16× over the pauses), `await watcher.idle()` after the pause so the deletion is
    classified before the file returns, and 5 s poll timeouts. The two "halves in different batches" tests use the same
    1 s wait for the same reason.
- **"reports a new folder with files as the folder only, then later changes inside it"** — 2 events instead of 1.
  "As the folder only" means the `mkdir` and the file write fall into one debounced batch; with the default 80 ms
  debounce a slow disk delivered the folder first and the file in a second batch. Fix: that test watches with a 500 ms
  quiet period.

## 3. Numbers from hosted runners

`perf.yml` uploads `reports/perf/<platform>-<arch>.json` (one per target, 90 days) and writes the same table to the
job summary. Fill this section from the first runs on `main`; until then the dev-machine baseline is the only data:

| Measurement (name in the report)                                | Budget  | Dev machine (2026-10-17) |
| --------------------------------------------------------------- | ------- | ------------------------ |
| completion provider: class items p95                            | 10 ms   | 0.50 ms                  |
| completion provider: path items p95                             | 10 ms   | 0.31 ms                  |
| symbol extraction: 200 files + context + filter, median         | 50 ms   | 2.5 ms                   |
| completion context on a 2 000-char window, median               | 50 ms   | 0.03 ms                  |
| indentation detection: 5 000-line file, median                  | 20 ms   | 0.41 ms                  |
| symbol extraction: 256 KB HTML document                         | 500 ms  | 4.6 ms                   |
| problem store: 100k console events, best-of-3 CPU time          | 2000 ms | 31 ms                    |
| watcher: max event-loop lag during a 3 000-file delete          | 500 ms  | 283 ms                   |
| project search: 2 000 files with Chinese paths, 200 hits        | 1000 ms | 202 ms                   |
| project search: max event-loop gap during the 2 000-file search | 100 ms  | 5.4 ms                   |
| project search: 2 000 files, common word cut at the match cap   | 1000 ms | 24 ms                    |

The hosted macOS figure that started this (21.4 ms p95 against 10 ms, run 39011559538) would now be recorded as
"over budget (reported)" at 2.14× and would not fail the run; 50 ms would.
