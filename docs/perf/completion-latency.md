# Completion latency (S43.6)

Budget (decision [0032](../decisions/0032-smart-suggestions.md)): NoobIDE's own completion provider (project ids,
classes, paths, snippets) computes its items in **≤ 10 ms p95** for a project of 200 HTML/CSS files and 2 000 classes,
and a project id is listed **≤ 500 ms** after typing the trigger character.

Measured on the Windows x64 dev machine (Windows 11, 32 logical cores), 2026-10-16 (unit numbers re-measured
2026-10-17).

## Provider work (unit)

`tests/perf/completion-latency.perf.test.ts` (the perf project, S58.3): 100 HTML pages (10 ids and 11 classes each) + 100 CSS files
(10 classes each) + 300 images = 500 files, 200 of them indexed, 2 100 classes. Per request: find the context in a
2 000-character window, merge the project's names (open files' unsaved edits included), build one item per class; and
for a path request, list `../images/` relative to a page. 60 measured runs each, after 10 warm-up runs; since 2026-10-17
the test judges the best of up to five such batches (S06.6), because on hosted CI runners (3–4 vCPUs shared by four
vitest workers) one descheduling inflated a whole batch to 11–21 ms p95 while the dev machine measures below 1 ms;
contention and GC pauses add time to a sample and never remove any, so the quietest batch is the closest measurement of
the provider's own cost, and every batch is judged against the unchanged budget. Reproduce with `npm run test:perf`
(`NOOBIDE_PERF_PRINT=1` prints every batch); the numbers land in `reports/perf/<platform>-<arch>.json` (budgets enforced
on developer machines, reported on GitHub Actions — docs/perf/ci-runners.md, decision 0038).

| Request                         | p95 (best batch) | Budget |
| ------------------------------- | ---------------- | ------ |
| `querySelector('.c-4` (classes) | 0.54 ms          | 10 ms  |
| `<img src="../images/` (paths)  | 0.23 ms          | 10 ms  |

Symbol extraction runs once per file read, not per request: 200 files (≈ 3 200 classes) take ≈ 2.6 ms in total
(`tests/perf/completion-perf.perf.test.ts`). Indentation detection of a 5 000-line file takes ≈ 0.3 ms (JS) / ≈ 1.4 ms (HTML with
`<script>`/`<style>`) (`tests/perf/indent-detect.perf.test.ts`).

## In the app (e2e)

`tests/e2e/smart-editing.spec.ts` "latency": the production build in Electron, a project with a Chinese path and spaces,
`script.js` open. Seven times: type `document.querySelector('` on a new line, then `#`, and wait until the suggestion
list shows `product-title` (defined in `shop/product.html`). Time from the `#` key press returning to the row being
in the DOM, measured by Playwright, warm (after the previous tests in the file).

| Measure                                       | Result                 | Budget   |
| --------------------------------------------- | ---------------------- | -------- |
| `#` → project id listed (median of 7)         | 7 ms (samples 6–12 ms) | ≤ 500 ms |
| Provider time inside the app (p95, 114 calls) | 0.20 ms                | ≤ 10 ms  |

`#` is a trigger character of NoobIDE's provider only, so the list does not wait for the TypeScript worker. Not
measured: the first request after start-up (Monaco loads the suggest widget lazily), and Apple Silicon (S43 has no
platform-specific code; a manual check is listed in harness/MANUAL-CHECKS.md).
