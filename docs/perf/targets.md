# PLAN §11 performance targets — status, misses and decisions (S27.3)

Source data: `docs/perf/<platform>-<arch>.md`, written by `node scripts/measure-perf.mjs --write` (S27.1). The rule
for S27.3: **every row marked "target missed" in a platform document gets a fix or a recorded decision here.** A row
is closed only by numbers from a new run, never by editing the generated document.

## Status (2026-10-15)

| PLAN §11 metric                  | Target                    | macOS arm64 (`darwin-arm64.md`)                                                                      | Windows x64 (`win32-x64.md`)                    |
| -------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Cold start → editor interactive  | p95 ≤ 5 s                 | p95 983 ms dev binary, 929 ms packaged (n=20) — no miss                                              | not measured yet (MANUAL-CHECKS#S27.1)          |
| Update after saving (≤ 50 files) | p95 ≤ 1 s                 | p95 54 ms, 50 files / 754 KB / 40 resources per load (n=20) — none                                   | not measured yet                                |
| Memory, idle and typical project | record; ~700 MB budget    | idle median 550 MB, typical median 551 MB, max 577 MB (n=3) — none; private 226 / 262 MB (memory.md) | not measured yet (S05.6 baseline: 429 / 523 MB) |
| Offline use                      | all core features offline | proven by `tests/e2e/offline.spec.ts` (S27.2)                                                        | same spec; runs in the owner's Windows e2e run  |

**Misses: none measured.** On the one device measured so far every target is met with a wide margin (cold start
~5× under, save → preview ~18× under, memory ~120 MB under the budget by the working-set sum).

## Limits of these numbers (decisions)

1. **Not the reference machines.** PLAN §11 asks for one fixed Windows x64 and one fixed Apple Silicon Mac, each with
   8 GB RAM and an SSD. The macOS numbers come from an M3 Pro with 18 GB, the S05.6 Windows baseline from an
   i9-13900KF with 32 GB. _Decision:_ no release claim about §11 targets until `measure-perf.mjs --write` has run on
   both reference machines; until then the documents describe the devices they name and nothing more.
2. **Dev binary vs packaged binary.** Playwright cannot drive the packaged app (the inspect fuse is off on purpose),
   so "editor interactive with a typed character" is measured on the production bundles in the development binary.
   _Decision:_ the packaged binary is measured too, via the self-test's wall-clock timestamps (editor rendered,
   workers answered); the two agree within ~60 ms on macOS (p95 983 vs 929 ms), so the dev-binary number stands in
   for the packaged one. The packaged run includes Gatekeeper's first-launch scan (first sample 3282 ms after a fresh build).
3. **Save → preview is an upper bound.** It is timed from the key press, so it includes the atomic save itself, and
   ends when the page's `load` event has fired for all 40 resources. No further split is needed while it is 16×
   under target.
4. **Memory varies between runs** (419–550 MB idle across three launches on macOS): Chromium's GPU and renderer
   working sets settle differently, and the GPU process's graphics memory is not in its working set at all.
   _Decision:_ report median, min and max of n=3 and compare the **max** of the working-set sum with the budget; record
   the private-memory sum (macOS phys_footprint, Windows privateBytes) next to it, because working sets count the
   shared Electron framework once per process. Breakdown, reductions and remaining options: `docs/perf/memory.md`,
   decision 0024.

## Open items outside the §11 table

- **Console flood stall** (S05.3 blocked, fix in S05.7): a page logging ~100k messages/s stalls the main process for
  seconds. Not a §11 metric, but the largest known performance problem; tracked there with its own acceptance
  criterion (< 200 ms stall).

## When a run shows a miss

Add a row under a "Misses" heading here with: platform and device, metric, measured value vs target, cause (profile
or experiment), and either the fix (feature id + commit + the new run's numbers) or a decision (accepted with a
reason, target change proposed to the owner — PLAN is owner-maintained).
