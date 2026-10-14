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

## Formatting

Format with the **整理格式 / Format** button above the editor or with Shift+Alt+F (Windows) / ⇧⌥F (macOS). Formatting is
an ordinary edit: Ctrl+Z / ⌘Z undoes it, and autosave writes it.

| Capability                                  | Example                                       | Case          |
| ------------------------------------------- | --------------------------------------------- | ------------- |
| HTML is re-indented, one element per line   | `<ul><li>One</li>…` → nested, 2 spaces        | `html-format` |
| CSS rules get one declaration per line      | `h1{color:red;margin:0}` → expanded rule      | `css-format`  |
| JavaScript gets standard spacing and indent | `function add(a,b){` → `function add(a, b) {` | `js-format`   |

## Not claimed

These are **not** validated and must not be presented as features: completion inside `<script>` and `<style>` blocks
of an HTML file, CSS class/id completion from the project's HTML, go to definition or rename across files, type
checking of JavaScript beyond undefined names, and anything for languages other than HTML, CSS and JavaScript.
