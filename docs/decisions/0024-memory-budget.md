# 0024 — Memory budget: what is measured, and which reductions are taken

- **Status:** accepted
- **Date:** 2026-10-15
- **Feature:** none assigned (memory investigation for PLAN §11 "Memory"; evidence for S27.3 is the lead's call)

## Context

PLAN §11 asks for the combined memory of all processes at idle and with a typical project, per platform, against a
budget of about 700 MB. `scripts/measure-perf.mjs` (S27.1) sums `app.getAppMetrics()` working sets and recorded
~530 MB idle and ~535–650 MB with the preview on an M3 Pro — close enough to the budget to ask where it goes.

The per-process breakdown (`scripts/measure-memory.mjs`, numbers in `docs/perf/memory.md`) showed:

1. **The working-set sum overstates the cost.** Every Electron process maps the same framework; its resident pages are
   counted once per process. The macOS `phys_footprint` (private dirty + compressed + GPU memory attributed to the
   process; what Activity Monitor shows) of the same runs is 40–60 % of the working-set sum. Conversely, the working
   set of the GPU process does not include its graphics memory at all.
2. **The largest idle item was the GPU process with a focused editor** (~175 MB footprint), caused by Monaco's blinking
   caret: one frame every 0.5 s keeps Chromium's swap-chain and raster buffers resident. Without frames the GPU
   process drops to ~45 MB.
3. **The TypeScript worker** (JavaScript diagnostics, completion, hover) costs ~83 MB as soon as a `.js` file is open;
   the HTML and editor workers ~12 MB together. Monaco already stops idle HTML/CSS/JSON workers (2 min) and the editor
   worker (5 min); it never stops the TypeScript worker.
4. Main process ~50–66 MB, network service ~7 MB and the preview renderer ~25 MB footprint leave little to gain.

## Options considered

| Option                                                        | Effect measured (footprint)                       | Verdict                                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caret stops blinking after 10 s without input (stays visible) | GPU 175 → ~48 MB idle with a focused editor       | **taken** — no security or data effect; precedent: GNOME's 10 s `cursor-blink-timeout`; any input restores blinking                                                           |
| Monaco `disableLayerHinting`                                  | none                                              | rejected                                                                                                                                                                      |
| `--force-gpu-mem-available-mb=128`                            | none                                              | rejected                                                                                                                                                                      |
| `--js-flags=--optimize-for-size`                              | idle −5 MB; with a JS file open −27 MB (renderer) | rejected — slower JS for the IDE and for the user's page, small gain                                                                                                          |
| `--js-flags=--max-semi-space-size=2`                          | idle 0; with a JS file open −22 to −28 MB         | not taken now — trades GC CPU in every renderer (including the user's page) for ~25 MB; kept as the first option if a reference machine misses                                |
| Stop the TypeScript worker when idle                          | −83 MB after the idle period                      | not possible cleanly — Monaco's TS worker manager has no idle stop, and restarting it re-validates every open JS model at once; needs a Monaco patch or an own worker manager |
| Network service in the browser process, `--in-process-gpu`    | −1 process each (~40 / ~70 MB working set)        | **rejected** — removes a sandbox/process boundary (network parsing or GPU driver code in the privileged main process); never trade isolation for memory (AGENTS.md)           |
| Lazy Monaco / fewer editor contributions                      | not measured; renderer V8 heap is ~26 MB in total | rejected — small ceiling, real risk of losing editor features                                                                                                                 |

## Decision

1. Take the caret rest (`src/renderer/editor/caret-rest.ts`, wired in `CodeEditor.tsx`).
2. Keep the PLAN §11 budget rows on the working-set sum (comparable with S05.6), but record the private-memory sum
   next to them (`measure-perf.mjs` rows "private memory"; macOS `phys_footprint`, Windows `privateBytes`). The
   private sum is the better estimate of what NoobIDE costs an 8 GB machine; the working-set sum is an upper bound.
3. Idle before a memory sample is 30 s (was 10 s), so start-up spikes (GPU ~300 MB for the first seconds) are over.
4. No V8 or Chromium switches, and no change to the preview's isolation, sessions or process model.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- The caret is solid after 10 s without input in the editor; typing, clicking, moving the cursor or focusing the
  editor makes it blink again. Unit test `caret-rest.test.ts`; the whole e2e suite runs with it.
- macOS arm64: `node scripts/measure-memory.mjs` (per process) and `node scripts/measure-perf.mjs --write`
  (`docs/perf/darwin-arm64.md`) after `npm run package`. Numbers vary between runs because the GPU process reacts to
  other windows (spikes to ~300 MB when the window is redrawn); report medians of n ≥ 3.
- Windows x64: the same scripts; private memory comes from `privateBytes`. Not yet run (owner's Windows run, see
  MANUAL-CHECKS#S27.1). Whether the caret effect is as large with D3D11/ANGLE on Windows is not measured.
- Remaining options if an 8 GB reference machine misses the budget: the semi-space cap (−~25 MB with JS open), a
  TypeScript-worker idle stop (−~83 MB, needs a Monaco patch), in that order.
