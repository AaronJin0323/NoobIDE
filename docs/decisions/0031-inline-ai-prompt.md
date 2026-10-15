# 0031 — Inline `/ai` prompts in the code editor

- **Status:** accepted
- **Date:** 2026-10-16

## Context

The owner asked (2026-10-16) that a beginner can type a request straight into the code, e.g.
`/ai 做一个点击后数字加一的按钮` or `/ai center this heading`, and have the AI write the code there: it reads the prompt,
the file, the cursor position, nearby code and what is blocking them (the file's current problems), shows the generated
code for Accept / Reject, and on Accept the `/ai` line is replaced by the code.

NoobIDE already has an inline edit (S35.1, Ctrl/Cmd+I, decision 0025): a review zone above the edited lines, an `edit`
request with bounded context, a line diff, Accept as one undo step saved through the file's save pipeline, and the
consent / no-key / AI-off handling. `/ai` is a new way into that zone, not a second review UI.

## Decision

**What counts as an `/ai` prompt.** Only in `html`, `css` and `javascript` models, and only while AI surfaces are shown
(a key is stored and AI is on). A prompt is a line whose text, after optional leading spaces/tabs, is `/ai` followed by
at least one space, tab or full-width space (U+3000, what a Chinese IME types) and a non-empty request:
`^[ \t]*/ai[ \t　]+(\S.*)$`. Case-sensitive, at the start of the line only, never inside a longer line. A bare
`/ai` (no request yet) shows a hint, nothing else.

**It never collides with real code.**

- `/ai` at the start of a line is not valid CSS, and in JavaScript only a regular-expression literal or a division
  continuation could start that way — neither is beginner code. In HTML it would be visible text, which is exactly
  what the warning below tells the user.
- **Plain Enter runs a prompt only when the line is _armed_:** the user typed, pasted or undid text on that line in
  this editor since the file opened, the cursor is at the end of the line (trailing spaces allowed), there is exactly
  one cursor and no selection, no suggestion widget or inline suggestion is showing, and no IME composition is open
  (Enter that confirms a Pinyin candidate never runs the prompt). An `/ai` line that came from disk is never armed, so
  Enter on existing text behaves as before. Shift+Enter always inserts a normal line break.
- **Ctrl+Enter (⌘Enter on macOS)** runs the prompt on the cursor's line, armed or not (it is an explicit command; on
  any other line Monaco's own Ctrl/⌘+Enter keeps working). The editor's context menu offers **"Run this /ai prompt"**
  on such a line too.

**It is never saved as a half-finished prompt without the user knowing.** Every `/ai` line carries

- an end-of-line hint in words (e.g. "⏎ AI 写代码 · Ctrl+Enter" / "⏎ let AI write it · Ctrl+Enter"), not colour
  alone, and
- a warning marker (owner `noobide-ai-prompt`, code `ai-prompt-pending`) with a translated message, so it is underlined,
  read out by the hover, counted in Problems, and explained by a diagnostics rule ("this line is your AI request, not
  code; it is saved into the file as plain text until you run or delete it").

The save pipeline, autosave and crash recovery are **not** changed: a buffer with an `/ai` line is saved, autosaved
and journalled like any other text, because user text is sacred (never silently dropped or held back) and the line is
the user's own typing. Hiding it from disk would break the rule that the file on disk is what the editor shows.

**Context sent.** The request is the existing `edit` request with two optional fields:

- `mode: 'generate'` — the `/ai` line is the replaced range, `selection` is sent empty, and the system prompt is the
  generate variant: "write new code at the marked place for this request; reply with only the code, indented to fit".
- `problems` — up to 8 of the file's current problems (static markers of the file plus runtime/console/resource
  problems attributed to it), nearest to the prompt line first, errors before warnings, without problems on `/ai`
  lines themselves (the prompt's own syntax error is noise). Each is `{ line?, severity, source, code, message }`,
  message cut to 500 characters. They are project/page data and go inside a `<problems>` frame (neutralised like every
  other data frame).

Nearby code: up to 200 lines / 12 000 characters on each side of the prompt (a whole beginner file, usually), larger
than Ctrl+I's 40 lines because generation needs the file's ids, classes and functions. The prompt text is the
instruction; answers follow the UI locale (comments in Simplified Chinese for zh-CN), as for inline edit. Consent works
as for inline edit: the zone asks first in a project without consent, and nothing is sent before.

**Preview: the inline edit zone's diff, not ghost text.** The zone opens above the `/ai` line, already filled with the
request and sent at once; the answer is shown as the existing line diff (the `/ai` line removed, the generated lines
added), with Accept / Reject / Stop and the outcome in words. Ghost text was rejected: it cannot show what is removed,
is hard to read for multi-line answers, is Tab-accepted (easy to accept by accident) and conflicts with inline
completions on the same line.

**Undo, autosave, local history and the save pipeline stay separate.**

- Accept replaces the tracked `/ai` line with the code as **one** undo step (`pushStackElement` before and after one
  edit operation) and only while the line still reads what was sent (otherwise "stale", nothing changes). Ctrl/⌘+Z
  restores the `/ai` line exactly.
- Accept then saves through the file's own save pipeline (atomic write, local history snapshot, journal) like S35.1:
  the AI never writes to disk itself.
- Reject, Esc and Stop change nothing: the `/ai` line stays, with its hint and warning.
- No new persistent state: armed lines are editor decorations, gone with the model.

**Privacy and logs.** Nothing new is logged; the service logs the request as `edit` (ids, tokens, codes only). Prompts,
code and problem messages are never logged. Nothing is written into the project folder except by Accept's ordinary
save.

## Consequences

- `AiRequest` `edit` gains optional `mode` and `problems` (parser keeps exact keys, bounds both). Older renderers
  without them behave as before.
- A diagnostics rule and translated marker text are added; the hint and context-menu label are new i18n keys.
- An `/ai` line in an HTML text node that the user _wants_ on the page shows a warning they can ignore; Enter on it is
  untouched unless they edited that line in this session (then Shift+Enter gives a plain line break).
- Tests: pure detection/arming/context rules (unit), parser + prompt framing + fake provider (unit), and a Playwright
  e2e against the scripted provider that proves an English and a Chinese prompt, problem context reaching the model,
  Accept, Reject, one-step undo, Enter not hijacked on an unarmed line or during IME composition.
