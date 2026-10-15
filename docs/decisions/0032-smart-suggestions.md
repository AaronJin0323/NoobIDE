# 0032 — Smarter indentation and context-aware suggestions

- **Status:** accepted
- **Date:** 2026-10-16

## Context

The owner asked (2026-10-16) for "a better 智能推荐": smarter indentation detection and code suggestions that use the
surrounding context. Until now the editor used a fixed indentation (`tabSize: 2`, spaces, set on the editor) plus
Monaco's own guess, which is per file, has no notion of "this file has too little evidence", never looks at the rest of
the project, and is invisible to the user. Completion came only from Monaco's HTML / CSS / TypeScript services (S18):
they know the file they are in and (S18.4) the project's other scripts, but not the ids and classes the project's HTML
and CSS define, and not the project's files. A beginner writing `document.querySelector('#` gets nothing, and in
`<img src="` has to remember the image's exact name. docs/capabilities.md lists "CSS class/id completion from the
project's HTML" under _Not claimed_.

AI ghost-text suggestions already exist (S32.1, decision 0025: on by default once AI is set up, switchable in the status
bar and the command palette). What is missing is a mark on the suggestion itself: grey ghost text alone does not say
"this came from AI".

Parallel work: S41 (preview annotations) and S42 (inline `/ai` prompt) also touch the editor and AI. This work does not
touch `src/renderer/ai/inline-prompt*` or the AI context builders.

## Decision

### Indentation

**Detection is NoobIDE's own pure function** `detectIndentation(text, languageId)` in
`src/renderer/editor/indent-detect.ts` (no Monaco import), returning

```ts
interface IndentGuess {
  insertSpaces: boolean;
  tabSize: number; // 2 | 4 (8 only if clearly used); width of a tab / indent unit
  confidence: 'high' | 'low' | 'none';
  mixed: boolean; // both tab- and space-indented lines carry real weight
  evidence: number; // number of indented code lines used
}
```

Rules (each covered by a fixture in `tests/fixtures/indentation/`):

- Only code lines count. Blank lines, lines inside block comments (`/* … */`, `<!-- … -->`), JSDoc continuation lines
  (` * …`, which are aligned by one space), and the inside of `<pre>`, `<textarea>` and template literals are skipped.
- Tabs vs spaces: count lines whose indentation starts with a tab vs with spaces; the majority wins. A tab-led line
  followed by alignment spaces counts as tabs. When both have at least a third of the lines the file is `mixed`.
- Width: the most common _increase_ in indentation between consecutive code lines (2 vs 4; 8 only when nothing else
  fits); absolute indentation is a tie-breaker. HTML files with embedded `<script>` / `<style>` blocks use all lines,
  since the blocks follow the document's nesting.
- Confidence `none` below 2 indented code lines, `low` below 6 lines or when mixed with no clear majority, `high`
  otherwise.

**Fallbacks** (`resolveIndentation` in the same module): a per-file user override wins; then a `high` guess; then the
project convention; then a `low` guess; then the template default (2 spaces — the bundled templates and the formatter
output use it). The project convention is the majority of `high` guesses of the project's HTML / CSS / JS files read by
the project index (below); it needs at least 2 agreeing files. New and nearly empty files therefore follow the project,
or the templates when the project has no evidence. The result carries its `source`
(`override | detected | project | default`) for the status bar.

**Application.** The resolved options are set on the Monaco model (`tabSize`, `indentSize`, `insertSpaces`) when it is
shown and again after the project convention changes; Monaco's built-in `detectIndentation` is switched off so the
two never disagree. Enter, auto-closing pairs and tags, Tab / Shift+Tab and formatting all read the model's options.
Paste: after a paste, the leading whitespace of the pasted lines is rewritten into the file's style when the pasted text
uses the other style (`reindentPasted`, pure, whitespace-only — it never changes anything but leading whitespace);
this is a separate undo step after the paste, as format-on-paste is in other editors. It runs only when it is safe
(review of 2026-10-16): one cursor; the range Monaco reports is exactly the clipboard text (read from the DOM paste
event), so a whole-line paste that lands above the cursor never touches the user's own line; the text has no
whitespace-sensitive part (`<pre>`, `<textarea>`, template literals, block / HTML comments); and its space unit is
clear (≥ 80 % of its space-indented lines are whole levels, so 3-space code is left alone). The first line is converted
too when the paste starts at column 1.

**Status bar and override.** An item next to the cursor position names the style ("空格：2" / "Spaces: 2", "Tab 宽度：4" /
"Tab size: 4") and its source as text, not colour. It is a button: it opens a keyboard-navigable menu with Spaces 2,
Spaces 4, Tabs 2, Tabs 4, "Detect again" and "Convert the file's indentation", which rewrites every line's leading whitespace level by level
from the style the file is written in to the chosen one (`convertIndentation`; Monaco's own actions only swap tabs and
spaces, so 4 → 2 spaces would do nothing) as one undoable edit. An override lasts for the file until the app closes (kept in the
renderer, keyed by file URI). Persisting a project-wide choice in `.noobide/project.json` is a candidate for later; it is
not built now because it needs a project.json schema change.

### Context-aware completion

A **project index** (`src/renderer/editor/project-index.ts`, Monaco-free, host injected like `ProjectScripts`) reads the
project's `.html` / `.htm` / `.css` files (≤ 200 files, ≤ 256 KB each) and keeps, per file, the ids and classes it
defines (`id="…"`, `class="…"` in HTML; `#id` / `.class` selectors in CSS, including CSS in `<style>` blocks) and its
indentation guess. Open editor models win over the disk copy. It updates on watcher events and model changes; a folder event stands for everything below it
(a created folder is listed through `workspace.listDir`, a deleted or renamed one takes its files along) and `rescan`
re-lists the project. Texts stay
in memory only; nothing is logged.

**Pure context engine** `src/renderer/editor/completion-context.ts`: given the language, the text before the cursor
(bounded window) and, for HTML, whether the cursor is in `<script>` / `<style>`, it returns one of

- `{ kind: 'id', prefix }` — JS string argument of `getElementById(`, or `querySelector(All)('#…`;
- `{ kind: 'class', prefix }` — `getElementsByClassName(`, `classList.add|remove|toggle|contains|replace(`,
  `querySelector(All)('.…`; HTML `class="… ` (space-separated, last word); CSS selector `.…`;
- `{ kind: 'selector', prefix }` — `querySelector(All)('` with no `#`/`.` yet (ids as `#x`, classes as `.x`);
- `{ kind: 'css-id', prefix }` — CSS selector `#…` outside a declaration block;
- `{ kind: 'path', prefix, accept }` — HTML `src="` / `href="` (by element: `img`/`audio`/`video`/`source` → media,
  `link` → `.css`, `script` → `.js`, `a` → `.html`), CSS `url(`, JS `import … from '` / `import('` (`.js` / `.mjs`);
- `null` otherwise (the language services answer alone).

Paths are suggested relative to the current file (`./`-less for HTML/CSS, `./`-prefixed for JS imports), with `/`
separators, never absolute, and work for Chinese names and spaces (encoded only if the user's text is). **Symbols in
scope** (variables, functions, other scripts) stay the TypeScript service's job (S18.4); this work does not duplicate it.

**Beginner patterns.** A handful of snippets in JS (and HTML `<script>`): "listen for a click", "change the text",
"show / hide an element", "toggle a class", each using a real project id/class as the first placeholder choice when one
exists. Their labels and descriptions are localised (zh-CN default, en).

Only names that are valid unescaped CSS identifiers are offered (Chinese names included), so an id like `1` or a class
like `md:flex` never produces a broken selector. In an HTML page the `<script>` / `<style>` region is decided over the
64 KB before the cursor, so a long inline script keeps its suggestions.

**Labels.** Every NoobIDE item names where it came from in the suggestion's description: "index.html" for an id or
class, "项目文件 / project file" for a path, "NoobIDE 片段 / NoobIDE snippet" for a snippet. They are sorted before the
generic DOM names when the context is specific. Language-service items are untouched.

**AI ghost text label.** When Monaco shows an AI ghost-text suggestion (S32.1 provider's `handleItemDidShow`), a small
content widget at the cursor reads "AI" with the accessible name and tooltip "AI 建议 — Tab 接受，Esc 忽略" / "AI
suggestion — Tab accepts, Esc dismisses". It disappears when the suggestion does. Language-service suggestions never
appear as ghost text (Monaco's `suggest.preview` stays off), so grey text with the badge always means AI, and the
suggest list always means the language services / NoobIDE. The AI default (on once AI is set up) stays as decided in 0025.

### Offline and latency

Everything above is local: no network, no AI. Budget: the NoobIDE provider computes its items in ≤ 10 ms p95 for a
project of 200 HTML/CSS files and 2 000 classes (unit-measured), and the suggestion list shows a project id within
500 ms of typing the trigger character in the packaged app (e2e-measured). Results: docs/perf/completion-latency.md.

## Consequences

- Capabilities are claimed only through cases in `tests/fixtures/lang-capabilities/cases.json` that run in the packaged
  app offline; the S18 probe gains no new mechanism because a case's `files` are editor models, which the project
  index reads as open models.
- The _Not claimed_ list loses "CSS class/id completion from the project's HTML" only for the contexts proven here.
- Indentation guesses are heuristics; the status bar always shows the choice and its source, and one click changes it.
