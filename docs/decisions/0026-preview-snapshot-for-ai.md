# 0026 — Preview snapshot for the AI assistant

- **Status:** accepted
- **Date:** 2026-10-15
- **Feature:** S38.1, S38.2

## Context

S38 makes chat and agent "preview-aware": they should see what the user's page shows (its outline, its errors and a
screenshot), so a beginner can ask "why does my button do nothing?". The preview is untrusted code in a sandboxed
`WebContentsView` with no preload, a per-project partition and no IDE IPC (decision 0009, AGENTS.md "preview
isolation"); main already holds a DevTools protocol session on it for the page guard (decision 0016). Whatever reads the
page must not weaken that isolation, must stay bounded for hostile pages (huge DOM, busy loop) and must treat the page's
text as untrusted data (it can contain prompt-injection text).

## Options considered

1. **A preload or IPC into the preview** that reports the DOM — rejected: it gives the page a bridge, the exact thing
   preview isolation forbids.
2. **`Runtime.evaluate` in the page's main world** — rejected: the page can observe and influence it (prototype and
   getter overrides, `Error.prepareStackTrace`, timing of its own globals).
3. **CDP `DOMSnapshot.captureSnapshot` / `DOM.getDocument` / `Accessibility.getFullAXTree`** (no script at all) —
   rejected as the primary path: they return the page's strings and trees unbounded (no limit on breadth, string
   length or node count), and main would have to parse the whole result. A 150 000-element page with a 2 MB text node
   would cost main tens of MB of JSON and noticeable stalls; main stalls block all IDE input.
4. **`Runtime.evaluate` in an isolated world** created by main with `Page.createIsolatedWorld` (no universal access)
   on the existing protocol session — **chosen** for the outline. An isolated world shares only the DOM with the page:
   its globals and DOM wrappers are separate, so page script cannot see the script, its variables or its result, and
   prototype/getter overrides in the page's world do not reach it (proved by `篡改.html` in the e2e spec). The script only
   reads (no DOM writes, events, storage or network; a page `MutationObserver` sees nothing) and bounds itself: at most
   20 000 elements visited, 300 items, 160 characters per item, 400 ms of its own time; item text is read from the
   first text nodes only, never a huge subtree's whole `textContent`. Main validates and caps the result again
   (`parseOutline`, `formatOutline`: ≤ 12 000 characters) and waits at most 1.5 s.
5. Screenshot through **`webContents.capturePage()`** (a copy of the composited frame; no page script), scaled in main to
   ≤ 1024 px on the longest side, refused above 1.5 MB of PNG, waited for at most 2 s. Not taken while the view is
   hidden.

## Decision

- `src/preview/page-snapshot.ts` + `PreviewManager.pageSnapshot(projectId, { screenshot })`: path of the shown page
  inside the project, title (≤ 200 chars), outline (headings, links, buttons, form fields with labels, images with
  alt; hidden ones marked), optional PNG. One snapshot at a time per preview (callers share it). Nothing is asked of the
  page when the preview is not `running`/`refreshing`, or when the watchdog's ping has been unanswered for 500 ms (the
  page's main thread is busy): the answer is "not available" at once. Otherwise each part has its time budget. No new
  permission, preload, IPC into the preview, network, or page-world script; the page guard's session is reused (the
  flood guard's `Runtime.terminateExecution` may end a running outline script: that snapshot is then "not available").
- AI side (S38.2): agent read-only tools `get_page_outline` and `get_page_screenshot`; `get_console` names project files
  (`script.js:3`) instead of preview URLs; the chat gets a **Preview** context chip that shows exactly the text that
  will be sent (path, title, outline, recent errors) and the screenshot thumbnail. Main keeps the screenshot of a chip
  (by id, per window, a few at most) so the request sends the image the user saw; the renderer never sends image bytes.
- Page content is untrusted data: framed like file text (chat: `<preview>` context tag + `neutralizeData`; agent: the
  per-run nonce frame + `neutralizeData`), never logged (logs get sizes, timings and codes only), and it cannot approve
  proposals (only `ai:resolve-proposal` from the workbench can) or add tools (the tool list is fixed).
- Sending a snapshot needs the project's AI consent, like code. Images go to providers as image blocks (Anthropic:
  `image` blocks in the user turn or inside `tool_result`; OpenAI Chat Completions: `image_url` parts in a user message,
  because tool messages cannot carry images). Models that cannot take images get a text-only fallback (the outline and a
  note); Anthropic models are treated as image-capable, OpenAI models by id (`modelAcceptsImages`).

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- `tests/e2e/preview-snapshot.spec.ts` (Windows x64 locally, macOS arm64 in the CI matrix) proves: isolation facts are
  identical before and after a snapshot (same view and partition, sandbox, context isolation, no Node, no preload, no
  bridge globals, no new page globals); a page overriding DOM prototypes cannot change the outline nor observe a
  mutation; a 150 000-element page gives a truncated, capped snapshot in well under 4 s while main keeps answering; a
  busy page gives "not available" within the budget and an unresponsive one at once.
- Found while testing: a watchdog ping sent to a document that was being replaced was never answered, so a page could
  stay "unresponsive" forever after a navigation; the ping is now dropped when the new document commits.
- Shadow DOM, iframes and canvas content are not in the outline (the screenshot shows them). Future work could add
  them within the same bounds.
