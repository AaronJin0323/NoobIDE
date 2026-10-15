# Language capabilities (validated)

PLAN §4: "Validate each language capability with real examples; do not equate highlighting with full language
analysis." This page lists **only** capabilities that a case in
[`tests/fixtures/lang-capabilities/cases.json`](../tests/fixtures/lang-capabilities/cases.json) proves. Every case runs
in the packaged app, in a real editor, with the network emulated offline (`tests/e2e/language.spec.ts`, which fails if
any case fails). A unit test (`src/renderer/editor/capability-cases.test.ts`) fails if this page cites a case id that
the suite does not contain.

Rule for editing this page: add a row only together with a passing case; when a case is removed or stops passing,
remove its row. Help texts and release notes may only claim what is listed here.

## HTML

| Capability                                            | Example                  | Case                              |
| ----------------------------------------------------- | ------------------------ | --------------------------------- |
| Tag names are suggested while typing a tag            | `<butt` → `button`       | `html-tag-completion`             |
| Closing tags are suggested                            | `</` → `/section`        | `html-close-tag-completion`       |
| Attribute names are suggested                         | `<img sr` → `src`        | `html-attribute-completion`       |
| Attribute values with a fixed set are suggested       | `type="che` → `checkbox` | `html-attribute-value-completion` |
| Hovering a tag explains the element (MDN description) | `<button>`               | `html-tag-hover`                  |

## CSS

| Capability                                       | Example                            | Case                         |
| ------------------------------------------------ | ---------------------------------- | ---------------------------- |
| Property names are suggested                     | `backg` → `background-color`       | `css-property-completion`    |
| Keyword values are suggested                     | `display: fl` → `flex`             | `css-value-completion`       |
| Colour names are suggested                       | `color: re` → `red`                | `css-color-value-completion` |
| Hovering a property explains it                  | `color`                            | `css-property-hover`         |
| Hovering a selector shows the element it matches | `.card` → `<element class="card">` | `css-selector-hover`         |

## JavaScript

| Capability                                                | Example                                       | Case                          |
| --------------------------------------------------------- | --------------------------------------------- | ----------------------------- |
| DOM methods are suggested                                 | `document.getElementBy` → `getElementById`    | `js-dom-completion`           |
| Names declared in the file are suggested                  | `user` → `userName`                           | `js-local-name-completion`    |
| String methods are suggested                              | `city.toUpp` → `toUpperCase`                  | `js-string-method-completion` |
| Array methods are suggested                               | `list.pu` → `push`                            | `js-array-method-completion`  |
| `console` methods are suggested                           | `console.lo` → `log`                          | `js-console-completion`       |
| DOM event names are suggested in `addEventListener`       | `addEventListener('cli` → `click`             | `js-event-name-completion`    |
| Hovering a DOM method shows its signature and description | `querySelector`                               | `js-dom-hover`                |
| Hovering a variable shows its declaration                 | `userName` → `const userName: "Lin"`          | `js-local-hover`              |
| Hovering a function shows its parameters                  | `greet` → `function greet(name: any): string` | `js-function-hover`           |

### Several JavaScript files

The project's other `.js` / `.mjs` files (up to 60, each up to 256 KB of text) are known to the JavaScript service
even when they are not open. Validated in the workbench on a project whose path has Chinese characters and spaces
(`tests/e2e/language-workbench.spec.ts`): an import from a closed file and a global from a closed script.

| Capability                                                         | Example                                                   | Case                          |
| ------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------- |
| Exports of a relative ES module import (same folder) are suggested | `import * as util from './util.mjs'`; `util.gr` → `greet` | `js-module-import-completion` |
| Names declared in another classic script are suggested             | `appT` → `appTitle` (from `config.js`)                    | `js-cross-script-completion`  |

If a language worker crashes, hangs or is killed, it is restarted within about 15 seconds; typing is never blocked
meanwhile (`tests/e2e/language-workbench.spec.ts`).

## Project names and files (S43)

NoobIDE's own suggestions, from the project around the file (decision 0032): ids and classes its HTML and CSS define,
and its files. They name where they come from (the defining file, "项目文件 / project file", "NoobIDE 片段 / NoobIDE
snippet"), work offline, and are measured in [perf/completion-latency.md](perf/completion-latency.md). The workbench
cases on a project with a Chinese path and spaces are in `tests/e2e/smart-editing.spec.ts`.

| Capability                                                         | Example                                                               | Case                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------- |
| `querySelector('#` suggests the project's ids                      | `#` → `page-title` (from index.html)                                  | `js-project-id-completion`                |
| `getElementById('` suggests the project's ids                      | `'` → `plus-button`                                                   | `js-project-get-element-by-id-completion` |
| `classList.add('` suggests the project's classes                   | `'` → `is-active` (from style.css)                                    | `js-project-class-completion`             |
| The same inside an HTML page's `<script>`                          | `querySelector('#` → `page-title`                                     | `js-html-script-project-id-completion`    |
| CSS `.` selectors suggest classes used in the HTML                 | `.` → `headline`, `btn`                                               | `css-project-class-selector-completion`   |
| CSS `#` selectors suggest ids used in the HTML                     | `#` → `#page-title`                                                   | `css-project-id-selector-completion`      |
| `class="` suggests classes defined in the project's CSS            | `class="` → `price-tag`                                               | `html-class-attribute-project-completion` |
| `<img src="` suggests images and folders, relative to the page     | `src="` → `logo.png`, `images/`                                       | `html-src-path-completion`                |
| `<link href="` suggests style sheets                               | `href="` → `style.css`                                                | `html-link-href-path-completion`          |
| `import … from '` suggests the project's scripts                   | `from '` → `./util.mjs`                                               | `js-import-path-completion`               |
| Beginner snippets: click listener, change text, toggle class, hide | `click` → `document.querySelector('#…').addEventListener('click', …)` | `js-click-snippet-completion`             |

## Indentation (S43)

Each file's indentation (tabs or spaces, width 2 or 4) is detected from its content; files with too little evidence
follow the project (two or more agreeing files), otherwise the templates' 2 spaces. Enter, auto-closed braces and tags,
paste (re-indented into the file's style, a separate undo step) and Format use it. The status bar shows it and where it
came from, and its menu changes it. Proven by `tests/fixtures/indentation` (19 files, `indent-detect.test.ts`) and
`tests/e2e/smart-editing.spec.ts`; it is a heuristic, so the status bar always shows the choice.

## AI suggestions are marked

AI ghost text (S32.1, only when AI is set up) carries an **AI** badge with the accessible name "AI 建议 / AI
suggestion"; the suggestion list above is never AI (`tests/e2e/ai-inline.spec.ts`, `smart-editing.spec.ts`).

## Formatting

Format with the **整理格式 / Format** button above the editor or with Shift+Alt+F (Windows) / ⇧⌥F (macOS). Formatting is
an ordinary edit: Ctrl+Z / ⌘Z undoes it, and autosave writes it. It indents with the file's own indentation (see
Indentation above); the cases below run with 2 spaces.

| Capability                                  | Example                                       | Case          |
| ------------------------------------------- | --------------------------------------------- | ------------- |
| HTML is re-indented, one element per line   | `<ul><li>One</li>…` → nested, 2 spaces        | `html-format` |
| CSS rules get one declaration per line      | `h1{color:red;margin:0}` → expanded rule      | `css-format`  |
| JavaScript gets standard spacing and indent | `function add(a,b){` → `function add(a, b) {` | `js-format`   |

## Not claimed

These are **not** validated and must not be presented as features: the language services' own completion inside
`<script>` and `<style>` blocks of an HTML file (only the project names above are proven there), class/id completion in
other contexts than those listed, go to definition or rename across files, type
checking of JavaScript beyond undefined names, and anything for languages other than HTML, CSS and JavaScript.
