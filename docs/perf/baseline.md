# Performance baseline (S05.6)

First measurements for PLAN §11 "Cold startup" and "Memory". These are a **baseline to compare against**, not a
claim that the targets are met: the PLAN reference machines (8 GB RAM, SSD, one fixed Windows x64 and one fixed
Apple Silicon Mac) are not available yet, and the Windows numbers below come from a much faster developer machine.

How to reproduce: `npm run package` (builds the production bundles), then `node scripts/measure-baseline.mjs
[--runs N]`. The script prints JSON and a Markdown row for this table.

Definitions (see the header of `scripts/measure-baseline.mjs`):

- **Cold start → editor-interactive:** from spawning the app until Monaco is rendered and a typed character appears
  in it. Every sample starts with a fresh, empty app-data directory (like a first launch); the OS file cache is warm
  after sample 1, which is listed separately as "first".
- **Idle memory:** sum of `app.getAppMetrics()` working sets over all processes (main, GPU, utility, workbench
  renderer, and the preview renderer when running), after 10 s idle, no DevTools. Measured with no project open and
  with the multi-file fixture (`tests/fixtures/预览 多文件`) open and its preview running.
- **Build:** the production bundles in `.vite/` (the code that gets packaged) run by the unpackaged Electron 44.7.0
  binary. The packaged `.exe`/`.app` cannot be driven by Playwright because the `EnableNodeCliInspectArguments` fuse
  is off on purpose; asar loading and signature checks of the packaged app are therefore not included.

## Results

| Platform                    | Device                                                                     | Build                                                         | Cold start → editor-interactive (ms)                    | Idle memory, no project (MB)       | Idle memory, preview running (MB)  |
| --------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------- | ---------------------------------- |
| Windows 11 x64 (10.0.26200) | Intel Core i9-13900KF, 32 threads, 32 GB RAM, SSD                          | production bundles (.vite) on unpackaged Electron, 2026-10-14 | median 655, p95 701, min 644, max 701, first 689 (n=10) | median 429, min 428, max 432 (n=3) | median 523, min 521, max 525 (n=3) |
| macOS on Apple Silicon      | _not measured yet — needs a physical Mac (harness/MANUAL-CHECKS.md#S05.6)_ |                                                               |                                                         |                                    |                                    |

Process breakdown (first sample, MB): no project — Browser 125, GPU 98, Utility 52, workbench renderer 153;
preview running — Browser 113, GPU 101, Utility 54, workbench renderer 151, preview renderer 102.

## Other numbers recorded by the S04/S05 tests (same Windows machine)

| What                                                          | Value                                                                   | Source                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------- |
| Save → preview shows the new heading (multi-file fixture)     | 34–35 ms                                                                | `tests/e2e/preview.spec.ts` (S04.4), logged   |
| Typing 10 characters while the preview runs `while (true) {}` | 42–103 ms                                                               | `tests/e2e/preview-isolation.spec.ts` (S05.1) |
| Console flood: messages logged by the page in 6 s             | ~650,000                                                                | S05.3 test                                    |
| Console flood: keystroke delivery main → workbench            | 0–2 ms each, 20/20 delivered                                            | S05.3 test                                    |
| Console flood: longest stall of the main (browser UI) thread  | 3.2–4.7 s with the flood guard (≈8 s without it, standalone experiment) | S05.3 test; see S05.3 status                  |

## Reading the numbers

- Startup is far below the 5 s p95 target on this machine; the reference 8 GB machines will be slower, so the Windows
  row must be re-measured there before any claim.
- Idle memory (~430 MB, ~520 MB with a preview) is inside the ~700 MB budget of PLAN §11, again on this machine only.
- The console-flood stall is the open problem from this baseline (S05.3 is blocked; follow-up in S05.7).
