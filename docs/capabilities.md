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

### Go to definition and find references (S57.1)

**F12 / 转到定义 / Go to definition** and **Shift+F12 / 查找所有引用 / Find all references** (Edit menu, command palette,
the editor's context menu) work for functions and variables in the project's `.js` / `.mjs` files, also when the other
file is not open (`tests/e2e/js-navigation.spec.ts`, on a project with a Chinese path and spaces). One definition opens
its file at the place; references are listed by file and line. Names that come with the browser (`document`,
`console`) have no project file and are not offered. The same limits as above apply (60 scripts, 256 KB each).

**Right after a project opens** (S57.3) its scripts are still being read into the language service. A command pressed
then — F12, Shift+F12 or F2 — waits for that index (at most 10 seconds) rather than answering "not found" from a
half-read project; the status strip says "正在读取项目脚本，读完就转到定义… / Reading the project's scripts, then Go to
definition…" meanwhile, and the same keypress then navigates. If the scripts are still not read after the bound, the
notice says so and asks to try again in a moment (a rename is refused with the same reason). The e2e case holds the
project's script reads (a slow disk on demand, through the editor test hooks), opens a project, presses F12 as soon as the
file is open, sees the note and no "not found", then releases the reads and sees the file open; the race itself is
unit-tested in `project-scripts.test.ts` and `project-scripts-registry.test.ts`.

| Capability                                                    | Example                                          | Case                                        |
| ------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------- |
| Definition of a function in a closed script                   | `greet('Lin')` in app.js → config.js, line 1     | `js-definition-closed-file`                 |
| Definition of a variable in another open script               | `score += 1` → state.js, line 1                  | `js-definition-open-file`                   |
| Definition of a function imported from an ES module           | `add(1, 2)` → util.mjs, line 1                   | `js-definition-module-import`               |
| References across two files                                   | `greet` → app.js lines 1 and 2, config.js line 1 | `js-references-two-files`                   |
| **Not supported:** an HTML page's inline `<script>` (said so) | F12 in `<script>` → "not supported" message      | `html-inline-script-definition-unsupported` |

### Rename across the project's scripts (S57.2)

**F2 / 在所有脚本里重命名 / Rename in all scripts** (Edit menu, palette, context menu) renames a function or variable in
every project `.js` / `.mjs` file that uses it. A preview lists every file and every changed line (before and after)
first; nothing is written until **Apply**. Each file then goes through its own tab and the normal save (atomic write,
"changed on disk" check): a file that changed since the preview stops the whole rename, a failed save keeps the change
in that tab with its explanation, and Ctrl+Z / ⌘Z in a tab undoes that file's change alone
(`tests/integration/rename-apply.test.ts`, `tests/e2e/js-navigation.spec.ts`). The rename is refused, with the reason,
whenever the language service cannot be sure it found every use or that the code keeps its meaning: names that come with
the browser, properties and methods (`obj.count`), a new name that is already used in a project script or by the
browser (`location`, `status`), a global that an HTML page's inline `<script>` or `onclick="…"` also uses, and scripts or
pages NoobIDE could not read in full.

| Capability                                     | Example                                           | Case                                  |
| ---------------------------------------------- | ------------------------------------------------- | ------------------------------------- |
| Rename across two files (one of them closed)   | `greet` → `sayHello` in app.js and config.js      | `js-rename-two-files`                 |
| Refused: a name of the browser                 | `console.log` → refused, "comes with the browser" | `js-rename-refuses-built-in`          |
| Refused: the name is also used in an HTML page | `onclick="greet()"` in index.html → refused       | `js-rename-refuses-name-used-in-html` |

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

## Emmet abbreviations (S53.1)

Tab expands an Emmet abbreviation at the end of the text before the cursor (decision 0039). It is on by default and is
switched off with Edit › **Tab 展开 Emmet 缩写 / Expand Emmet abbreviations with Tab**; the first expansion shows a hint
in the status bar that names this switch (`tests/e2e/authoring.spec.ts`). Where no abbreviation applies, Tab indents as
before. With the suggestion list open, Tab accepts the suggestion; press Esc first to expand.

| Capability                                                             | Example                              | Case                             |
| ---------------------------------------------------------------------- | ------------------------------------ | -------------------------------- |
| HTML abbreviations expand to nested, repeated elements                 | `ul>li*3` → `<ul>` with three `<li>` | `html-emmet-nested`              |
| A class abbreviation expands to a `<div>`                              | `.card` → `<div class="card"></div>` | `html-emmet-class`               |
| CSS abbreviations expand inside a rule (CSS files)                     | `m10` → `margin: 10px;`              | `css-emmet-property`             |
| CSS abbreviations expand inside an HTML page's `<style>`               | `m10` → `margin: 10px;`              | `html-emmet-style-block`         |
| A word that is not an HTML element is not expanded; Tab inserts spaces | `hello` + Tab → `hello  `            | `html-emmet-plain-word-indents`  |
| A word that is not a CSS abbreviation is not expanded                  | `zz` + Tab → `zz  `                  | `css-emmet-unknown-word-indents` |

## Paired tags (S53.2)

Renaming an opening HTML tag renames its closing tag, and the other way round (Monaco linked editing, with NoobIDE's own
tag pairing in `src/renderer/editor/tag-match.ts`). Only explicit pairs are linked: a void element (`<img>`), a
self-closing tag, and a tag whose closing tag is left out (such as `<li>` closed by the next `<li>`) are not.
Edit › **用标签包住选中的代码 / Wrap selection with tag** (also in the command palette) wraps the selection in `<div>`
with both tag names selected, so typing a name changes both; one undo restores the original
(`tests/e2e/authoring.spec.ts`).

| Capability                                            | Example                                   | Case                                        |
| ----------------------------------------------------- | ----------------------------------------- | ------------------------------------------- |
| Typing in an opening tag name changes its closing tag | `<div>` → `<divx>` … `</divx>`            | `html-linked-tag-rename`                    |
| Typing in a closing tag name changes its opening tag  | `</h1>` → `</h12>` and `<h12>`            | `html-linked-tag-closing-side`              |
| Not linked: a tag without its own closing tag         | `<li>One <li>Two` → only the first `<li>` | `html-linked-tag-implicit-close-not-linked` |
| Wrap with tag; typing the tag name changes both tags  | `hello` → `<strong>hello</strong>`        | `html-wrap-with-tag`                        |

## Colour hints (S53.3)

In **CSS files**, every colour value gets a small swatch in front of it (Monaco's colour decorators; clicking it opens
Monaco's colour picker). With the cursor on a colour value, the status bar writes the value out next to a swatch whose
accessible name carries the value ("颜色：#c0392b / Colour: #c0392b"), and **编辑颜色 / Edit colour** (also Edit ›
Edit colour at cursor and the command palette) opens NoobIDE's colour picker: hue, saturation and lightness sliders and a
value field, all keyboard-operable (`tests/e2e/authoring.spec.ts`, with an axe scan). Apply replaces the value in place,
in its own format, as one undo step. Not claimed: swatches inside an HTML page's `<style>` or `style=""` attribute.

| Capability                                                             | Example                                                    | Case                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------ |
| Swatches for hex, `rgb()`, `hsl()` and named colours (not in comments) | `#c0392b`, `rgb(240, 248, 255)`, `hsl(…)`, `rebeccapurple` | `css-color-swatches`     |
| The picker keeps a hex value hex                                       | `#c0392b` → `#008000`                                      | `css-color-picker-hex`   |
| The picker keeps an `rgb()` value `rgb()`                              | `rgb(0, 0, 255)` → `rgb(255, 0, 0)`                        | `css-color-picker-rgb`   |
| The picker keeps an `hsl()` value `hsl()`                              | `hsl(0, 100%, 50%)` → `hsl(240, 100%, 50%)`                | `css-color-picker-hsl`   |
| A colour name becomes hex (most colours have no name)                  | `teal` → `#ff6347`                                         | `css-color-picker-named` |

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

## Comments (S53.4)

Edit › **切换行注释 / Toggle line comment** (Ctrl+/ on Windows, ⌘/ on macOS) and **切换块注释 / Toggle block comment**
(Shift+Alt+A / ⇧⌥A), also in the command palette, use the syntax of the place the cursor is in: inside an HTML page's
`<style>` and `<script>` they write CSS and JavaScript comments, not `<!-- -->`. One undo step each.

| Capability                                   | Example                            | Case                                                 |
| -------------------------------------------- | ---------------------------------- | ---------------------------------------------------- |
| HTML line comment                            | `<p>Hi</p>` → `<!-- <p>Hi</p> -->` | `html-toggle-comment`                                |
| CSS line comment                             | `a { … }` → `/* a { … } */`        | `css-toggle-comment`                                 |
| JavaScript line comment, and uncomment       | `let a = 1;` ↔ `// let a = 1;`     | `js-toggle-line-comment`, `js-toggle-line-uncomment` |
| JavaScript block comment around a selection  | `a` → `/* a */`                    | `js-toggle-block-comment`                            |
| CSS comment inside an HTML page's `<style>`  | `a { … }` → `/* a { … } */`        | `html-style-block-toggle-comment`                    |
| JavaScript comment inside an HTML `<script>` | `let a = 1;` → `// let a = 1;`     | `html-script-toggle-comment`                         |
| Block comment inside an HTML `<script>`      | `let a = 1;` → `/* let a = 1; */`  | `html-script-block-comment`                          |

## Format on save (S53.4)

Edit › **保存时整理格式 / Format on save** is **off** by default. When it is on, an explicit save (Ctrl+S / ⌘S, the Save
button, File › Save) formats an HTML, CSS or JavaScript file with the formatter above and then saves it: the bytes on
disk are the formatted text, and one undo gives back the text as it was before the save. Autosave never formats. If
the formatter fails or takes more than 3 seconds, the file is saved as it was and the status bar says why
(`tests/integration/format-on-save.test.ts`, `tests/e2e/authoring.spec.ts`).

## Not claimed

These are **not** validated and must not be presented as features: the language services' own completion inside
`<script>` and `<style>` blocks of an HTML file (only the project names above are proven there), class/id completion in
other contexts than those listed, go to definition, references or rename in an HTML page's inline `<script>`, type
checking of JavaScript beyond undefined names, and anything for languages other than HTML, CSS and JavaScript.
