# 0040 — Updating linked stylesheets without reloading the preview

- **Status:** accepted
- **Date:** 2026-10-17
- **Feature:** S54.1 (design), S54.2 (swap), S54.3 (fallback and reporting)
- **Extends:** 0019 (preview view sync), 0030 (preview annotations); relies on 0009, 0016, 0026

## Context

Every successful save reloads the preview (S10.5, S14.2). For a beginner tuning colours and spacing that throws away
what they typed into the page's form, the scroll position and any state the page's script built, so they have to
scroll back and re-type after every save. VS Code's Live Preview and IntelliJ's built-in preview update CSS in place;
the gap review (docs/reviews/mainstream-ide-gap-2026-10-17.md §4, item S54) asks for the same.

Constraints (AGENTS.md "Preview isolation", decisions 0009 / 0030): the page is untrusted code in a sandboxed
`WebContentsView` with **no preload**, no Node, context isolation, a per-project partition and **no IDE IPC**. The
usual live-reload technique — a websocket client script injected into the HTML that swaps `<link href>` — would add a
script to the page, a channel the page can talk to, and serve files that differ from the user's. All rejected.

## Options considered

1. **Injected live-reload client** (script tag added by the static server, or `executeJavaScript` in the page world)
   — rejected: page-world script and a page-reachable channel; the page can observe, block or fake it; served HTML
   would differ from the file.
2. **Isolated-world script that rewrites `<link href>` with a cache-busting query** (the world of decision 0026) —
   possible without a page-world script, but the page sees it: a `MutationObserver` reports the attribute change,
   `link.href` reads differently, and the extra request carries a query the user never wrote.
3. **The DevTools protocol's CSS domain over the page guard's existing protocol session — chosen.** Main already holds
   a protocol session for the page (decision 0016) and uses the DOM domain only while picking (decision 0030). For a
   swap main enables DOM + CSS briefly, receives a `CSS.styleSheetAdded` header for every stylesheet of the document
   (its `styleSheetId`, `sourceURL`, `frameId`, `ownerNode`, `isInline`), replaces the text of the matching sheets with
   `CSS.setStyleSheetText` (the text main read from the saved file on disk), and disables the domains again. This is
   what DevTools' Styles pane does. Nothing runs in the page, no element or attribute changes (the `<link>` node, its
   `href` and the page's `MutationObserver` see nothing), no request is made, no IPC is added; the stylesheet keeps
   its URL, so relative `url(...)` still resolves against the CSS file.

## Decision

**Which saves qualify.** Saves are collected between two refreshes (the S14.2 scheduler still waits for the typing
pause). When the automatic refresh fires and **every** saved file ends in `.css` (case-insensitive), main tries the
swap; otherwise it reloads as before. In manual refresh mode (S14.2) nothing happens on save — the page is marked
"Saved changes not shown" and the user's Refresh is a full reload, exactly as before.

**The swap** (`src/preview/css-swap.ts`, main only, structural Electron types so it is unit-tested):

1. Pre-checks on the saved text, read from disk inside the project root (`resolveInRoot`, realpath-checked) and at
   most 1 MiB, decoded as strict UTF-8 (a file in another encoding reloads, so the page's own charset rules apply): a
   small tokenizer (comments, strings, braces) finds a **syntax error** (unclosed `{`, a stray `}`, an unclosed
   comment or string) and an **`@import`** anywhere outside comments and strings. A file the static server would
   refuse (a dotfile or dot-folder) cannot be linked by the page: `not-linked`.
2. `DOM.enable` + `CSS.enable` through the picker's counted DOM user (0030: DOM is on only while something needs it),
   collecting the `CSS.styleSheetAdded` headers; `Page.getFrameTree` gives the main frame id.
3. Matching: a header matches a saved file when its `sourceURL` (query and hash ignored) is on the preview's own
   origin and maps to the saved project path. Every saved file must match at least one header of the **main frame**
   with an `ownerNode` (a `<link>`) and not `isInline`; a match in another frame, or a matching header without an
   owner node (the sheet is pulled in by an `@import` of another sheet), means fallback. A header with
   `hasSourceURL` (page CSS that names itself with a `/*# sourceURL=… */` comment) never matches. Child protocol
   sessions (out-of-process iframes, workers) are ignored.
4. `CSS.setStyleSheetText` for each matching sheet, then the domains are disabled. Each command is bounded (2 s); the
   whole swap is bounded too (5 s); once that runs out no further sheet is changed and the page reloads.
5. The page's generation (S16.3) does not change: no navigation happened, so problems of the page are not marked
   stale and the console stays as it is.

**Fallback = full reload, and it is said.** The reload is the S14.2 automatic refresh (`reloadIgnoringCache`, new
generation). Cases:

| Case                                                                                                     | Reason code  |
| -------------------------------------------------------------------------------------------------------- | ------------ |
| The save includes HTML, JavaScript or any other non-CSS file (an inline `<style>` is part of the HTML)   | `not-css`    |
| A saved CSS file is not linked by the page with `<link>` (e.g. loaded by script, or not used at all)     | `not-linked` |
| A saved CSS file uses `@import`, or is itself pulled in through an `@import` chain                       | `import`     |
| A saved CSS file is also used inside an `<iframe>` of the page                                           | `frame`      |
| The saved CSS has a syntax error (also reported to Problems, below)                                      | `syntax`     |
| The swap failed: protocol unavailable (guard not installed), a command failed or timed out, file too big | `failed`     |
| The file is not UTF-8, cannot be read, or the page was loading, hung or showing a missing page (404)     | `failed`     |

For `syntax` and `failed` main also records an IDE warning for the new page load (source `console`, the CSS file and
line, localised message starting "NoobIDE:"), so it reaches Problems through the S16.2 capture adapter like any page
record; it is attributed to the reloaded page's generation, so it is not stale (and dropped if that reload does not
happen or fails). The "page was loading" case only states the reason in the toolbar, without a Problems record. The console flood guard and rate
limits of decision 0016 are untouched: the swap adds no page output (the one IDE record per fallback goes through
the same bounded log buffer). Saves are applied one update at a time; an update that finds nothing new to apply (an
earlier one took its saves) does nothing.

**Toolbar wording** (next to the state pill, a `role="status"` text, so it is announced and never colour-only; it
is shown only for updates caused by a save and cleared by the next start, navigation or manual refresh):

| Outcome             | zh-CN                          | en                                 |
| ------------------- | ------------------------------ | ---------------------------------- |
| swap applied        | 样式已更新（页面没有重新加载） | Styles updated (page not reloaded) |
| reload (any reason) | 页面已重新加载                 | Page reloaded                      |

The reload text carries the reason as its tooltip / description:

| Reason       | zh-CN                                                      | en                                                              |
| ------------ | ---------------------------------------------------------- | --------------------------------------------------------------- |
| `not-css`    | 保存的文件里有 HTML、JavaScript 或其他文件，需要重新加载。 | The save included HTML, JavaScript or other files.              |
| `not-linked` | 页面没有用 <link> 引用保存的 CSS 文件。                    | The page does not link the saved CSS file with <link>.          |
| `import`     | 这个 CSS 用到了 @import，只能重新加载。                    | The CSS uses @import, which needs a reload.                     |
| `frame`      | 页面里的 iframe 也用了这个 CSS，只能重新加载。             | An iframe in the page also uses this CSS, which needs a reload. |
| `syntax`     | CSS 里有语法错误，请看“问题”面板。                         | The CSS has a syntax error; see Problems.                       |
| `failed`     | 没能直接换上新样式，所以重新加载了页面。                   | The new styles could not be applied in place.                   |

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- A CSS-only save keeps typed form input, scroll position and script state. `tests/e2e/preview-css-swap.spec.ts`
  (Windows x64 locally, macOS arm64 in the CI matrix, project path with Chinese characters and spaces) proves: no
  main-frame navigation (`did-start-navigation` count and `performance.timeOrigin` unchanged), input value and
  `scrollY` survive a colour change, the computed colour changes; HTML/JS saves, `@import` and broken CSS reload and
  say so in zh-CN and en; broken CSS reaches Problems; manual mode waits for the user. The existing isolation e2e
  (`preview-isolation.spec.ts`: no preload, no Node, no IDE IPC from the page) stays green with hot swap on.
- Edits the page made to that stylesheet through CSSOM (`insertRule`) are replaced by the file's text — the same as
  a reload would. Stylesheet objects the page holds stay the same objects; their rule lists change.
- A sheet linked with a different spelling of the path (`Style.css` for `style.css` on Windows) does not match and
  reloads: a reload is always correct, a swap is only an optimisation.
- The swap is as safe as DevTools' Styles pane: it changes only author CSS text; CSS cannot run script.
