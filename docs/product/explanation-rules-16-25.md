# Explanation rules 16–25 and their quick fixes (S55.1)

Status: chosen 2026-10-17 for M19 / S55. Implemented by S55.2 (rules) and S55.3 (quick fixes).

## Where the choice comes from

The criterion asks for rules 16–25 "driven by the H.6 study where it has data". **H.6 (five-beginner study) has not
run yet**: `docs/research/study-1.md` does not exist. So every rule below is taken from the **default set** in the
S55.1 criterion, unchanged. No rule here cites H.6 findings. When H.6 reports, a later session compares its
hesitations with this list. If a rule should be replaced, that session adds a new feature and supersedes this one
(AGENTS.md backlog rules). Rules are not edited silently.

Inputs used instead of study data: the M19 gap review (`docs/reviews/mainstream-ide-gap-2026-10-17.md, retired: docs/history.md` §4, which
proposed the default set), PLAN §9 (honest explanations, original evidence kept, guided checks where analysis cannot
prove a cause) and §13 ("limit rules to defined conditions").

## The existing rules (1–15) a new rule must not duplicate

| #   | Rule id (S22.2 / S22.3)                                                    | Evidence                                                            |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | `undefined-name`: misspelled or undefined variable (did-you-mean)          | runtime ReferenceError; static TS 2304/2552 in a JS file            |
| 2   | `syntax`: bracket / syntax error, full-width punctuation                   | runtime + static SyntaxError                                        |
| 3   | `null-element`: using an element that was not found                        | runtime "Cannot read properties of null"                            |
| 4–6 | `script-/image-/stylesheet-not-found` (and `page-not-found`)               | runtime 404 reported by the preview                                 |
| 7   | `css-unknown-property`: misspelled CSS property                            | static CSS service `unknownProperties`                              |
| 8   | `module-import`: module import failure                                     | runtime                                                             |
| 9   | `unhandled-rejection`                                                      | runtime                                                             |
| 10  | `fetch-failed`                                                             | runtime                                                             |
| 11  | `cors`                                                                     | runtime                                                             |
| 12  | `json-parse`                                                               | runtime                                                             |
| 13  | `not-a-function`                                                           | runtime                                                             |
| 14  | `html-unclosed-tag`: element opened but never closed                       | static, NoobIDE's HTML check (S19.2), marker on the **opening** tag |
| 15  | `selector-guided-checks`: CSS selector matches nothing (guided, `unknown`) | static / user-started                                               |

## Rules 16–25

Each rule lists its **trigger** (what exactly makes it apply), its **evidence** (static: read from the file text
without running the page; runtime: reported by the running preview), its **certainty and uncertainty wording**, the
**rule it must not duplicate**, and the **quick fix** S55.3 may offer. A quick fix is offered only when its target is
unambiguous. "Exactly one" below always means: zero or several candidates means no fix, only the explanation, the
checks and Go to code.

Static rules 16–20 and 23–25 are produced by NoobIDE's own checks (`src/diagnostics/beginner-checks.ts`) as Monaco
markers with owner `noobide-beginner`. Like rule 14, they are **warnings**. Each check is conservative: it reports
only what it can locate exactly and skips what it cannot read (template placeholders, URLs with a scheme, files
larger than the check limit).

### 16. Broken relative `src` / `href`, found statically (`html-broken-ref`)

- **Trigger:** in an HTML file, a `src` attribute (on `script`, `img`, `source`, `audio`, `video`, `iframe`, `embed`,
  `track`) or an `href` attribute (on `link`, `a`, `area`) holds a relative or root-relative path (no URL scheme, not
  `//…`, not `#…`, not empty, no `{`/`$` template text). The path is resolved from the HTML file's folder (`/…` from
  the project root), with `?query` and `#fragment` removed and `%xx` decoded. The rule applies when no project file
  has that path, **not even with different letter case**. The case-only difference is rule 24. Paths ending in `/` and
  paths that leave the project are not checked.
- **Evidence:** static (HTML text + the project's file list). Without a file list the check reports nothing.
- **Certainty:** `likely`. The file list can lag behind the disk for a moment (watcher), and a file the page creates
  at run time is possible. Wording: "这个路径在项目里可能找不到文件……" / "No file in the project may match this path…".
  Causes say what was compared ("项目里有名字相近的文件 …" / "The project has a similarly named file …").
- **Must not duplicate:** rules 4–6 (and `page-not-found`). Those explain a **404 the running preview got**; rule 16
  is found while typing, before the page runs, on a static record. They never apply to the same record.
- **Quick fixes:** _pick an existing file_ when exactly one project file has a similar name in the same folder (edit
  distance within the typo threshold) or the same name in another folder. The fix replaces the path text with the
  relative path to that file. _Create the missing file from a template_ when there is no candidate at all, the
  extension is `.html`, `.htm`, `.css` or `.js`, and the target folder already exists. Creating never overwrites:
  the new file is created exclusively, and if anything appeared at that path the fix is not applied.

### 17. Duplicate `id` (`html-duplicate-id`)

- **Trigger:** within one HTML file, an `id="x"` value that an earlier element in the same file already uses. Each
  later occurrence is reported. The marker sits on the value and names the line of the first one.
- **Evidence:** static.
- **Certainty:** `certain` that the id repeats. The consequence ("`getElementById` only finds the first one; `#x`
  styles both") is stated as browser behaviour, not a guess.
- **Must not duplicate:** rule 3 (runtime: no element found at all) and rule 15 (selector matches nothing). Rule 17
  is about an id matching too many elements, and it is static.
- **Quick fix:** none. Which element should keep the id, and what the other one should be called, is the user's
  choice. Nothing is unambiguous.

### 18. `<img>` without `alt` (`html-img-no-alt`)

- **Trigger:** an `<img>` start tag with no `alt` attribute (any value, including empty, counts as present).
- **Evidence:** static.
- **Certainty:** `certain` that the attribute is missing. The explanation says what `alt` is for (screen readers, a
  broken image) and that an empty `alt=""` is right only for decoration.
- **Must not duplicate:** rule 5 (image 404, runtime). Rule 18 is about a missing description, whether or not the
  image loads.
- **Quick fix:** _add `alt=""`_. Always unambiguous (one tag, one place to insert). The label names the exact change,
  and the card and explanation say to describe the image inside the quotes.

### 19. Mismatched closing tag (`html-mismatched-close`)

- **Trigger:** a closing tag `</x>` where no element `x` is open (the browser ignores it), while an element `y` is
  open at that point. HTML's optional-end elements (`p`, `li`, `td` …) are skipped when looking for `y`.
- **Evidence:** static, NoobIDE's HTML check.
- **Certainty:** `likely`. The user probably meant `</y>`, or typed a closing tag twice. Wording uses "可能" / "may".
- **Must not duplicate:** rule 14. Rule 14 reports the **opening** tag of an element that is never closed. Rule 19
  reports the **stray closing** tag. When both happen (`<section> … </secton>`), the two records point at different
  places, and fixing rule 19 also clears rule 14.
- **Quick fix:** _change `</x>` to `</y>`_. Offered only when that `y` is also never closed later in the file (rule
  14 reports it). Then the stray closing tag and the unclosed element pair up unambiguously. Otherwise there is no
  fix: either both closing tags exist, or there is nothing to pair with.

### 20. CSS length without a unit (`css-unitless-length`)

- **Trigger:** in a CSS file or a `<style>` block, a declaration of a length property (`width`, `height`, `min-/max-…`,
  `margin…`, `padding…`, `top`/`right`/`bottom`/`left`, `font-size`, `border…-width`, `border-radius`, `gap`,
  `row-gap`, `column-gap`, `outline-width`, `letter-spacing`, `word-spacing`, `text-indent`, `inset`) whose value has
  a bare non-zero number (`width: 100`). `0` is fine. Unitless-by-design properties (`line-height`, `z-index`,
  `opacity`, `flex`, `font-weight`, `order` …) are never on the list.
- **Evidence:** static.
- **Certainty:** `certain` that the browser ignores the declaration. Which unit was meant is a guess, so the text
  says "可能想写 100px" / "you may have meant 100px".
- **Must not duplicate:** rule 7 (misspelled property name). Rule 20 is about the value of a correctly spelled
  property. Rule 15 is about selectors.
- **Quick fix:** none. `px`, `%`, `em` and `rem` are all plausible, so no unit is unambiguous.

### 21. Inline handler calling an undefined function (`inline-handler-undefined`)

- **Trigger:** a runtime `ReferenceError: x is not defined` thrown from an inline event-handler attribute. The stack
  frame is `HTML…Element.on<event>` (or, without any stack, the reported file is an `.html` page). An undefined
  name in an inline `<script>` of a page stays rule 1.
- **Evidence:** runtime.
- **Certainty:** `possible`. Causes, each worded as a possibility: the function is declared in a `type="module"`
  script (module functions are not global), the script that declares it is not loaded or is loaded after the
  click, the name is misspelled, or it is declared inside another function. Checks: compare the name in the
  `on…="…"` attribute with the declaration; look at the `<script>` tag.
- **Must not duplicate:** rule 1. Rule 1 explains an undefined name used **inside a script file**. Rule 21 runs
  before rule 1 and takes only the inline-handler case, so a record gets one of them, never both.
- **Quick fix:** none (where the function should live is not unambiguous).

### 22. Script runs before the element it reads (`script-before-element`)

- **Trigger:** a runtime "Cannot read/set properties of null" whose reported line calls `getElementById('x')` or
  `querySelector('#x')`, **and** the project's HTML does contain an element with id `x`.
- **Evidence:** runtime, plus the project's HTML ids (static facts).
- **Certainty:** `likely`. The element exists, so the most probable cause is timing: the `<script>` runs before the
  browser has read that element. Checks: move the `<script>` to the end of `<body>`, or add `defer`. Also check
  whether the element is created later by script.
- **Must not duplicate:** rule 3. Rule 3 handles the null access when the element is missing, misspelled or
  unknown. Rule 22 runs before rule 3 and applies only when the id is known to exist.
- **Quick fix:** none (moving a script tag changes the page structure; there is not exactly one right place).

### 23. `getElementById` / `querySelector` selector-prefix mistakes (`js-selector-prefix`)

- **Trigger (static, JavaScript files and `<script>` blocks):**
  - `getElementById('#x')` or `getElementById('.x')`: `getElementById` takes the bare id;
  - `querySelector('x')` / `querySelectorAll('x')` with a bare word `x` that is not an HTML tag name, while the
    project's HTML has an id or a class `x`.
- **Evidence:** static (+ the project's ids and classes for the second form).
- **Certainty:** `likely` for both. An id can technically start with `#`, and a custom tag could be named `x`.
- **Must not duplicate:** rule 3. Rule 3 is the runtime null access, and its "`#` in getElementById" cause stays.
  Rule 23 finds the mistake statically before the page runs. Rule 15 is about CSS files.
- **Quick fix:** _rename to the defined id/class_. `'#x'` becomes `'x'` in `getElementById` when the project has id
  `x` (or ids are unknown and the rest is a plain name). `'x'` becomes `'#x'` / `'.x'` in `querySelector` when
  exactly one of "id `x`" / "class `x`" exists. If both exist, there is no fix.

### 24. File reference differing only in letter case (`html-ref-case`)

- **Trigger:** like rule 16, but a project file matches the path when letter case (and Unicode composition) is
  ignored, while the exact spelling does not exist. Example: `Images/Logo.PNG` while the file is `images/logo.png`.
  The comparison key is the one `src/shared/portability.ts` uses for case conflicts (NFC, then lower case), so the
  rule and the portability scan (S13.5) always agree on what counts as "the same name except for case". A shared
  fixture and unit test prove this.
- **Evidence:** static.
- **Certainty:** `likely`. On Windows and default macOS volumes the page may still load. On a case-sensitive server
  or system it breaks. Wording: "在别的系统或网站上可能打不开" / "may fail on another system or web server".
- **Must not duplicate:** rule 16 (no file at all) and the runtime 404 rules' "case" cause (`notFound.cause.case`,
  given only after the preview failed). Rule 24 is the static warning before anything fails.
- **Quick fix:** _pick the existing file_. Replace the path with the file's exact spelling. Always unambiguous when
  exactly one file matches (two files differing only in case are themselves a portability conflict, and then there
  is no fix).

### 25. Assignment in an `if` condition (`js-assign-in-condition`)

- **Trigger:** in JavaScript, an `if ( … )` or `while ( … )` condition whose top-level expression contains a single
  `=` (not `==`, `===`, `!=`, `<=`, `>=`, `=>`), outside strings and comments. Conditions wrapped in an extra pair
  of parentheses (`if ((m = re.exec(s)))`) are the deliberate idiom and are skipped.
- **Evidence:** static.
- **Certainty:** `likely`. Wording: "这里可能本想比较（=== ）……" / "you may have meant to compare (===)". The
  explanation states as fact that `=` assigns and the condition then tests the assigned value.
- **Must not duplicate:** rule 2 (syntax). The code is valid, so no syntax error is reported.
- **Quick fix:** none. `==` versus `===` and intended assignments make it ambiguous.

## Quick-fix policy (for S55.3)

- Fixes exist for exactly the five kinds in the criterion: create a missing file from a template (16), pick an
  existing file for a broken path (16, 24), add an `alt` attribute (18), close or fix a tag (19), rename to the
  defined id/class (23). Rules 17, 20, 21, 22 and 25 explain and check, and offer no fix.
- A fix appears on the problem card **and** in the editor lightbulb (Monaco's quick-fix menu, `Ctrl/Cmd+.`), with a
  label naming the exact change (e.g. "把路径改成 images/logo.png" / "Change the path to images/logo.png").
- Both surfaces apply a fix the same way as the S22.5 one-click fix: one ordinary editor edit on the file's model
  (undoable with Ctrl/Cmd+Z and with the card's Undo), saved through the file's own atomic save pipeline (so it is
  autosaved, journaled and snapshotted like typing). A failed save keeps the edit in memory and the card never shows
  "resolved". The card shows "resolved" only after a re-check of the saved file no longer reports the problem.
- "Close a tag" for rule 14 (inserting `</x>`) is **not** offered. Where the closing tag belongs is never
  unambiguous from the text alone. Rule 19's pairing is the only tag fix.
