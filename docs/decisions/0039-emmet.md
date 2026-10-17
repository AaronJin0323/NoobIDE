# 0039 — Emmet abbreviations with the `emmet` package

- **Status:** accepted
- **Date:** 2026-10-17
- **Feature:** S53.1 (owner decision 3 of docs/reviews/mainstream-ide-gap-2026-10-17.md §6: even a pure-JS package
  needs a decision record)

## Context

Tutorials for beginners use Emmet (`ul>li*3`, `.card`, `!`, `m10`) and every mainstream editor expands it on Tab.
Monaco has no Emmet. PLAN invariants that apply: offline first (no CDN, everything bundled), exact pinned versions,
pure JS preferred, no native modules without a record, and Tab must keep indenting for people who do not know Emmet.

## Options considered

1. **`emmet` 2.4.11** (the reference implementation by Emmet's author, used by VS Code's Emmet). Pure ES module,
   MIT. Three dependencies, also pure JS and MIT: `@emmetio/abbreviation` 2.3.3, `@emmetio/css-abbreviation` 2.1.8,
   `@emmetio/scanner` 1.0.4. It expands and extracts abbreviations and has no Monaco or DOM code.
2. **`emmet-monaco-es`**: wraps `emmet` and registers Emmet as completion items. It adds a second layer we would
   have to keep in step with Monaco, and it offers Emmet through the suggestion list rather than Tab. It also has no
   context rules of the kind below.
3. **Our own subset**: only `tag`, `.class`, `>`, `*n`. That means writing and maintaining a parser, and it would
   still miss what tutorials show (`!`, `lorem`, CSS abbreviations).

## Decision

Option 1, pinned exactly (`"emmet": "2.4.11"` in package.json, with the transitive versions locked in
package-lock.json).

- **Licences checked:** all four packages declare `"license": "MIT"` in their package.json. NoobIDE's licence
  notices come from package.json metadata.
- **Offline:** the package is bundled by Vite into the renderer. It has no runtime fetch, no CDN and no workers. The
  packaged-app self-test runs the Emmet capability cases with the network emulated offline
  (`tests/e2e/language.spec.ts`; `tests/e2e/authoring-offline.spec.ts` for S53.5).
- **Bundle size, measured** on Windows x64 with `npm run package`: the chunk holding Emmet and NoobIDE's glue
  (`.vite/renderer/main_window/assets/emmet-monaco-*.js`) is **75.4 KB minified, 27.2 KB gzip**. That is about 0.5 %
  of `app.asar` (16.1 MB). It loads with the editor chunk, not at start-up of the shell.
- **Our rules on top of Emmet** (src/renderer/editor/emmet-expand.ts, unit-tested):
  - HTML: Tab expands only in text content, never inside a tag, a comment or `<script>`. Every element name in the
    abbreviation must be a real HTML element or a known Emmet snippet, so `hello` + Tab indents rather than writing
    `<hello></hello>`.
  - CSS (files and `<style>`): Tab expands only where a property starts inside a rule. The fuzzy match must score at
    least 0.5, and Emmet's "unknown word" answer (`foo: ;`) is not an expansion.
  - Tab is bound only when no suggestion list, AI suggestion, snippet session or selection owns it. When the
    suggestion list is open, Tab accepts the suggestion as before (press Esc first to expand).
  - Anything else gets Monaco's normal Tab.
- **Off switch:** `emmet` in the app settings, on by default. It is toggled from Edit › “Tab 展开 Emmet 缩写 / Expand
  Emmet abbreviations with Tab” and from the palette. The first expansion ever shows a status-bar hint that names
  this switch; `emmetHintShown` records that it was shown.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- The package is plain JS, so no per-platform build is needed. The capability cases (`html-emmet-*`, `css-emmet-*`)
  run inside the packaged app on both CI platforms (S06 workflow, `tests/e2e/language.spec.ts`).
- Upgrading `emmet` means changing the pinned version and re-running the capability suite. A change in expansion
  output shows up as a failing case, not as a silent change for users.
- `src/renderer/editor/emmet.d.ts` declares the two functions used. The package ships types, but its `exports` map
  does not expose them.
