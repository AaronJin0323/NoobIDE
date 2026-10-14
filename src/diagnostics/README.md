# src/diagnostics — problems

Unified ProblemRecord model, runtime capture adapter, attribution to preview generations, rate limiting, explanation
rules (10–15 categories, PLAN §9). Original messages are always retained.

Pure TypeScript, no Electron/DOM imports (usable from main, renderer and tests):

- `../shared/problem.ts` — `ProblemRecord` / `ProblemInput`, validation, dedupe key, `createProblemRecord`,
  `recordRepeat` (S16.1).
- `store.ts` — `ProblemStore`: dedupe with counts (first original + latest repeat kept verbatim), token-bucket rate
  limit for new records, per-source LRU capacity, dropped/evicted counters, `revision` for throttled redraws (S16.5).
- `normalize.ts` — page error → `ProblemInput` (preview URL → project path, opaque cross-origin "Script error."
  detection). For the capture adapter (S16.2).
- `rules/` — explanation engine (`engine.ts`), built-in rules in priority order (`index.ts` → `DEFAULT_RULES`,
  `explain`, `explainRecord`), fixtures per rule (`fixtures.ts`) and machine-checked honesty rules (`honesty.ts`):
  uncertain causes are worded as possibilities in every locale, "Show original error" is always offered.
- `messages/` — zh-CN (default) and en texts with a key/placeholder parity test. Params carry identifiers, paths and
  numbers only, never source code.

Rule inputs beyond the record come through `RuleContext` (declared names in scope, project file list, the text of
the reported line, HTML ids/classes, external script URLs). It is in-memory only and never copied into a record.

Codes producers must use for NoobIDE's own checks: `html-unclosed-tag` (`data.tagName`), `css-selector-unmatched`
(`data.selector`), `guided-style-not-applied`, `cross-origin-script-error`, `unhandledrejection`, `resource-failed`
(with `resource`).

The did-you-mean rule (`undefined-name`) returns `candidates` and the exact `span`; it adds a `replace-text` action
only when there is exactly one candidate and the name was located on the reported line (input for S22.5).

`html-check.ts` (S19.2) is NoobIDE's own static HTML check: elements opened but never closed, reported as
`html-unclosed-tag` with `data.tagName` (the renderer shows the findings as `noobide-html` markers). Beginner tuning
of the language services (ignored TypeScript codes, CSS lint levels) is in `src/renderer/editor/language-config.ts`,
proven by `tests/fixtures/static-diagnostics`. `css-selector-unmatched` is not emitted yet (it needs the project's
HTML ids and classes); the guided-checks rule handles it once a producer exists.
