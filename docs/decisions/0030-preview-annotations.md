# 0030 — Preview annotations for the AI assistant

- **Status:** accepted
- **Date:** 2026-10-16
- **Feature:** S41.1 (design), S41.2–S41.7 (implementation)

## Context

The owner asked (2026-10-16) that a beginner can point at part of the running page — "make this button bigger" — and
have the AI assistant change the matching code. Beginners think in what they see, not in files and selectors; the hard
part for them is finding _where_ in `index.html` / `style.css` the thing on screen comes from. So an annotation must
carry a note, what was pointed at, and where that is in the source, and it must reach the assistant as context the
user can read first (decision 0025: nothing is sent behind the user's back, code needs the project's consent).

Constraints: the preview is untrusted code in a sandboxed `WebContentsView` without preload or IDE IPC (decision
0009); user HTML is never rendered in the React DOM; main must stay responsive for hostile pages (decision 0026's
budgets); project folders stay ordinary; zh-CN + en; keyboard access; no colour-only state.

## Options considered

**Picking an element**

1. A script or preload in the page that listens for clicks and draws a highlight — rejected: it is a bridge into the
   page and the page can observe, block or fake it (preview isolation).
2. Drawing an overlay in the workbench over the page — impossible: the native view is always above the React DOM.
3. **The DevTools protocol's own inspect mode** (`Overlay.setInspectMode` `searchForNode`) on the protocol session main
   already holds for the page guard (decision 0016) — **chosen**. Chromium draws the highlight and the tag/size
   tooltip in its overlay layer, outside the page's DOM; while inspecting, mouse input goes to the inspector, not to
   the page (the page's click handlers do not run, so picking a "Delete" button deletes nothing). The pick arrives in
   main as `Overlay.inspectNodeRequested { backendNodeId }`; main resolves that node into the isolated world of
   decision 0026 (`DOM.resolveNode` with that world's context id) and describes it there with a bounded script
   (`Runtime.callFunctionOn`): page script cannot see or influence it. Inspect mode ends on a pick, Esc (seen by main
   in `before-input-event`, never by the page), Cancel, a navigation, Stop, or after 2 minutes.
4. **Keyboard alternative** (accessibility): "Choose from a list" — the isolated world lists up to 200 notable
   elements (landmarks, headings, buttons, links, form fields, images, elements with an id) as text; the user picks one
   in a keyboard listbox. Elements are named by their **child-index path** from `<html>` (numbers only), which main
   resolves again in the isolated world. The same path re-finds the element later to show it.

**Drawing a region** — the owner's "draw a region" option. The workbench cannot draw over the native view, so
"Draw a region" freezes the stage: main captures the page (`capturePage`, as decision 0026), the renderer shows that
PNG as an `<img>` in place of the hidden view and the user drags a rectangle (or moves/resizes it with the arrow keys
and confirms with Enter). Main turns the rectangle (fractions of the viewport) into the smallest element that contains
it, using `elementsFromPoint` in the isolated world, and keeps the rectangle with the annotation. A region therefore
maps to source like an element does; its note says "this area".

**Mapping to source**

1. Ask the page (`data-` attributes injected by the static server) — rejected: serving modified files would make the
   preview differ from the user's files and break "project folders stay ordinary" in spirit.
2. **Re-locate in main from what the browser reports — chosen.** The isolated world reports, for the element: tag, id,
   classes, a short text, a unique CSS selector, its rectangle, its **ancestry** (tag + nth-of-type per level), and the
   project style sheets' rules that match it (`el.matches(rule.selectorText)` over same-origin `document.styleSheets`,
   bounded). Main reads the page's `.html` file (the project file the preview URL maps to; never outside the root) and
   builds a small position-tracking HTML tree (`src/preview/source-locate.ts`: void elements, raw text, comments,
   implied end tags of `p`/`li`/`td`…). It matches the element by ancestry (exact), then by id, then by tag + classes
   - text (approximate). Script-created elements have no match: the annotation says so ("not found in the HTML — it may
     be created by a script") and the assistant gets the selector instead. CSS rules are located in their `.css` file (or
     the n-th `<style>` of the page) by their selector text, giving file + line range. Every location says whether it is
     exact or approximate.

**Storage** — in app data, `annotations/<projectKey(realRoot)>.json` (the same hash chats and history use), atomic
writes, at most 200 annotations per project, notes ≤ 2 000 characters; corrupt files are moved aside. Kept across
restarts like saved chats (owner preference for per-project AI data in app data, S39), never in the project folder.
The source location is re-computed from the files on disk whenever annotations are listed or sent, so an edited file
does not leave a stale line range; an annotation whose element can no longer be found says so.

**Showing and editing** — an "Annotations" strip in the preview pane, in the layout flow under the toolbar (so the
native view never covers it): a numbered list of the page's annotations with the note (editable), what it points at
(`button#send "发送"`) and where it is (`index.html line 14 · style.css lines 20–24`), all as text with an icon and a
word for state (found / approximate / not found) — never colour alone. "Show" highlights the element with
`Overlay.highlightNode` (Chromium's overlay again, not the page DOM) for a few seconds. Every action is a button
reachable with Tab; the pick mode is announced in a live region and Esc cancels it.

**Handing to the AI** — a new context item kind `annotation` (src/shared/ipc/ai-contract.ts). Main builds its text
(`annotationContextText`: the note, the element, the HTML location with a short numbered excerpt, the matched CSS rules
with excerpts; capped) and the renderer shows it in an "Annotation" chip — exactly what is sent. "Ask AI" on an
annotation (or "Ask AI about all" for a page) opens the chat in **agent** mode with the chip(s) and the note as the
prompt; nothing is sent until the user presses Send, and sending needs the project's consent. In the request it is
framed like file text (`<annotation>` tag + `neutralizeData`; agent: the nonce frame) — the note is the user's words,
but the element text and code come from the project and the page. The agent's instructions say to change the named
location (and prefer the listed CSS rule for visual changes). A proposal whose edit lies inside an annotation's HTML
or CSS range is marked "in the annotated part" on its card, so the beginner can check the assistant changed the right
place.

## Decision

As described: protocol inspect mode + isolated world for picking (no page script, no page-visible change), a
keyboard list and a frozen-screenshot region as alternatives, main-side source location by ancestry/id/heuristics,
per-project app-data storage, an `annotation` context item built in main and shown verbatim, agent mode by default.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- `tests/e2e/preview-annotations.spec.ts` (Windows x64 locally, macOS arm64 in the CI matrix): picking with the
  mouse does not run the page's click handler; isolation facts (sandbox, no preload, partition, no bridge globals, no
  new page globals, no DOM mutation seen by a page `MutationObserver`) are identical before and after picking and
  showing; the annotation is listed with its source location; Ask AI → fake provider → the proposal edits the
  annotated CSS rule and is marked "in the annotated part". The project path has Chinese characters and spaces.
- Unit tests for the locator (ancestry, id, approximate, implied end tags, script-created elements, CSS rules,
  `<style>` blocks, CRLF) and the store (atomic, caps, corrupt files, newer versions).
- Limits: elements inside iframes, shadow roots and canvas drawings cannot be located in source (the annotation keeps
  the selector and says so). Generated markup that differs from the file (implicit `<tbody>`, elements moved by
  script) gives an approximate or no match — never a silent wrong "exact".
- DOM and Overlay protocol domains are enabled only while picking or highlighting and disabled afterwards, so a page
  with a huge, changing DOM costs main nothing the rest of the time.
