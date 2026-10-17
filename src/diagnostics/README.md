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
- `runtime-capture.ts` — the runtime capture adapter (S16.2–S16.6, decision 0017): raw preview records →
  ProblemRecords in a bounded store, attributed to preview session + generation (a new generation per committed
  page load; records not seen since are `stale`), coalesced change notifications. Wired in main by
  `src/main/problems-bridge.ts`, read by the workbench through `window.noobide.problems`.
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

`beginner-checks.ts` (S55.2) is NoobIDE's static check for rules 16–20 and 23–25
(docs/product/explanation-rules-16-25.md): broken relative `src`/`href` (`html-broken-ref`), a reference that
differs only in letter case (`html-ref-case`, same comparison key as the portability scan: `portableNameKey` in
`src/shared/portability.ts`), duplicate ids, `<img>` without `alt`, a stray closing tag (`html-mismatched-close`),
a CSS length without unit, `getElementById`/`querySelector` selector-prefix mistakes and an assignment in an
`if`/`while` condition. Findings quote their facts in backticks; `beginnerFacts` reads them back into the record's
`data` (static-problems.ts). The renderer shows them as `noobide-beginner` markers for files of the open project
(src/renderer/problems/beginner-checks-monaco.ts). Runtime rules 21 (inline `on…` handler calling an undefined
function) and 22 (script runs before the element it reads) run before rules 1 and 3 and take only their narrower
cases. Rules 16, 18, 19, 23 and 24 return a quick fix (`replace-text` with `match: 'exact'`, or `create-file`) only
when its target is unambiguous (S55.3: problem card and editor lightbulb, src/renderer/problems/quick-fix-monaco.ts).
