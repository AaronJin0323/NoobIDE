# UI/UX improvement plan — lessons from the Claude Desktop study (M18)

Owner request 2026-10-17: go through [Caho1/open-claude-ui](https://github.com/Caho1/open-claude-ui), find what
NoobIDE's UI/UX can take from it, and turn that into a plan. This document is the plan. The backlog entries are
milestone **M18**, sessions **S47–S50** in [harness/features.json](../../harness/features.json). Nothing here is
implemented yet; every feature is `todo`.

## 1. What the source is, and how far to trust it

`open-claude-ui` (MIT) is a third-party reverse-engineering of the Claude Desktop client: a 3,000-line manual in
eight chapters (`docs/v1/01–08`), a second volume on Claude Desktop 2.0 (`docs/v2/01–06`), 30 React/Tailwind code
samples (`code-examples/`) and a CDN-loaded Storybook. It documents a **chat product**, not an IDE, and it is a
repository of _ideas and constants_, not of code we can ship:

- It depends on Tailwind, Framer Motion and lucide icons; NoobIDE has no animation library and bundles its own
  icon set (`workbench/icons.tsx`). We port values into CSS custom properties, never class strings or components.
- It contradicts itself in places (button size ladders in §2.1.1, §7, §8.4 all differ; spring preset names are
  swapped between `ClaudeMotionPresets.ts` and chapter 08; skeleton sweep is 1.8 s in one file and 2.0 s in
  another). Where we adopt a number we pick one and record it in the token table, not in a citation.
- Its Storybook pulls Tailwind, Babel and Google Fonts from CDNs. NoobIDE is offline-first; the Storybook is read,
  not shipped.
- Its brand accent is clay orange `#d97757`. NoobIDE's brand is monochrome (decision 0034). No accent colour is
  copied.

What is worth copying is the **engineering physics** underneath the visuals: dead zones, cooldowns, thresholds,
mask curves, keyboard rules, IME guards, growth bounds, and the discipline of compositor-only CSS motion. Those
transfer to any desktop app and most of them are missing from NoobIDE today.

## 2. Method

1. One read-only subagent catalogued the source repo chapter by chapter with the concrete constants
   (section 9 of its report lists 38 transferable ideas and 10 things not to copy).
2. One read-only subagent surveyed the NoobIDE renderer: tokens, motion, layout, every component, a11y,
   responsiveness, test conventions, and the open items in M16/M17 and the archived HIG work.
3. The two were reconciled against the constraints NoobIDE already committed to: the calm design spec
   ([calm-design-spec.md](calm-design-spec.md), decision [0034](../decisions/0034-calm-design-language.md)), the
   mechanical `design-rules.test.ts`, the AGENTS.md invariants (offline, i18n, not-colour-alone, restricted IPC,
   preview isolation), and the M16 rule that key features stay visible.
4. Everything that survived became a feature with acceptance criteria that the existing test conventions can
   prove (pure models, `renderToStaticMarkup`, design-rules scan, axe, key-features-visible at 1280×720 and
   640×480, glass.spec reduced-motion / forced-colours checks).

Baseline for this plan: `npm run verify` green at the branch point (2734 unit tests).

## 3. Where NoobIDE already stands

S46 (calm language) already did the part of the study that is about _looking_ calm: warm neutrals, four radii,
weight-400 type, one overlay shadow, flat buttons, frosted overlays only, no gradients, a scan that forbids
drifting back. The source agrees with that direction on every principle (surfaces 1–3% apart, no borders inside
borders, ghost controls inside framed containers, secondary information by colour not weight).

What NoobIDE does **not** have yet, and the source does, is the behavioural layer:

| Area                | NoobIDE today (file:line from the survey)                                                                        | Source technique                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| AI chat scrolling   | `ChatPanel.tsx:168-173` scrolls to the end on every streamed chunk, unconditionally (the comment says otherwise) | 150 ms input cooldown, 40 px pin tolerance, `behavior: auto`, "jump to latest"     |
| AI composer         | fixed `rows=3`, 60–200 px, manual `resize: vertical` (`ai-chat.css:310-322`)                                     | `field-sizing: content` with mirror fallback, 44 px → 40 svh                       |
| IME guard           | stage 1 only (`isComposing` / keyCode 229, `workbench/ime.ts`)                                                   | stage 2: swallow Enter ≤ 500 ms after `compositionend` on WebKit; Escape contained |
| Splitter            | drag + keyboard; no dead zone, no double-click reset, no Escape rollback, no collapse (`Splitter.tsx`)           | 4 px dead zone, double-click 50/50, Escape restore, collapse threshold, shield     |
| Scroll-edge masks   | 2-stop, 20 px, on three lists (`glass.css:253-281`)                                                              | 7-stop x^1.5 mask, 28 px, native `scroll()` timeline plus sensor fallback          |
| Motion tokens       | 120 / 200 ms, three curves; literal `0.1s` on the tree twisty (`styles.css:1464`)                                | 60 / 120 / 200 / 300 / 450 ms, named curves per purpose                            |
| Reduced motion      | one block for overlays; smooth tab scroll and panels not covered                                                 | (also weak in the source; NoobIDE should do better)                                |
| Panels and notices  | appear and disappear instantly; no enter/exit motion                                                             | grid `0fr → 1fr` accordion, block-enter, chip stagger                              |
| Console             | 200 lines, no pinning, no search, no copy (`ConsoleView.tsx`)                                                    | same scroll latch as chat                                                          |
| Roving focus        | tab bar and tree only; rail, segmented controls, toolbars are all tab stops                                      | roving tabindex hook: Tab exits, arrows move, Home/End, RTL                        |
| Code blocks in chat | caption + Copy; no highlighting, no insert (`Markdown.tsx`)                                                      | header with language, copy decay animation, tabular gutter                         |
| Dialogs             | each hand-built; backdrop and focus-return differ; archived `Sheet.tsx` unused (S45.9)                           | one dialog anatomy, dvh height cap, nested-dialog dimming                          |
| Notices             | success/info notices styled danger (`EntryNotice.tsx:218`, `TransferNotice`); no motion                          | tone-first anatomy                                                                 |
| Density             | one size                                                                                                         | compact / comfortable token set (v2)                                               |
| Mentions / commands | none in chat; `/ai` only in the editor                                                                           | `/` and `@` trigger grammar with CJK punctuation stripping                         |
| Draft loss          | unsent chat text is lost on crash                                                                                | zero-loss input ledger (v2)                                                        |
| Provider errors     | shown once; no retry pacing                                                                                      | 429/503 backoff with jitter, countdown, max 3 automatic retries                    |

## 4. Rules for transplanting

1. **Decision 0034 wins.** No scaling on press or hover (the scan bans `scale(` outside keyframes), no gradients,
   no glow loops, no coloured shadows, no clay accent, no capsules except counters. Where the source animates
   with scale on interaction we animate background, opacity or transform-translate instead.
2. **Compositor-only motion.** The source's own v2 moved from JS springs to CSS because streaming locked the main
   thread. NoobIDE stays at zero animation dependencies: durations, `cubic-bezier()` and `linear()` curves as
   tokens, `@keyframes`, `transition`, scroll-driven animations with `@supports` fallbacks.
3. **Reduced motion is a first-class path**, not an afterthought as in the source. Every new animation has a
   `prefers-reduced-motion` reduction and an e2e assertion.
4. **Offline.** No font, icon or library is fetched. Syntax colouring in chat uses the bundled Monaco colorizer.
5. **Not colour alone.** Every new state (pinned/unpinned scroll, pending/running/applied, collapsed splitter)
   has an icon or word. Every new control is keyboard-reachable and has an accessible name in zh-CN and en.
6. **Invariants untouched.** The preview stays a native `WebContentsView` with no DOM channel; the source's
   iframe shield and `postMessage` user-activation gate do **not** apply (NoobIDE's bridge is main-process
   `console-message`, which is already stronger). Project folders stay ordinary: drafts and recents go to
   app-data, never into the project.
7. **Numbers get one home.** Every constant adopted below is a token or a named constant with a unit test, so the
   source's internal contradictions do not leak in.

## 5. Improvement tracks

Priority: **P1** = fixes a real defect or a daily friction for a beginner; **P2** = raises perceived quality;
**P3** = nice to have, do when adjacent code is open. Each track is one backlog session.

### Track A (S47) — Motion, scroll edges and type details

**A1 · Motion token ladder and a global reduced-motion gate (P1).** Source: v1 §1.6, v2 §4.3, `cds-theme.css`
155–165. Extend `styles.css :root` with `--dur-instant: 60ms`, keep `--dur-fast: 120ms` and `--dur-base: 200ms`,
add `--dur-sheet: 300ms` and `--dur-slow: 450ms`; name the curves by purpose (`--ease-swift` for hover,
`--ease-expand` for grid accordions, `--ease-enter` for block entry, keep `--ease-smooth` / `--ease-snappy`). The
design-rules scan gains two rules: no literal duration and no literal `cubic-bezier`/`linear` outside `:root`.
Reduced motion becomes one `@media` block that sets `--dur-*` to `0ms`, switches overlay keyframes to fade, and
turns `scrollBy({behavior:'smooth'})` into `auto` (TabBar.tsx:94). Monaco gets `smoothScrolling: false` under the
same query.

**A2 · Panel, drawer and notice enter/exit (P2).** Source: v1 §3.2 (`grid-template-rows: 0fr ↔ 1fr`), v1 §4.1
`timeline-block-enter`, v2 §2.5 `sibling-index()` stagger. The files drawer (narrow), the chat panel, the
walkthrough band, the problems panel and notices in `.app-notice-stack` get an enter and an exit. Collapsible
groups (problem sections, the preview "Advanced" disclosure, the AI "thinking"/steps fold) use the grid trick so
no height is measured and nothing jumps while content streams; while an answer streams the fold is held open
(the source's mutex). Context chips enter with a 30 ms stagger capped at 8. All of it is gated by A1 and must not
move the layout `FRAME` (top bar 52, strip 32, gap 8) or break `key-features-visible.spec.ts`.

**A3 · Seven-stop scroll-edge masks (P2).** Source: v1 §4.3, `ScrollFadeContainer.tsx`. Replace the 2-stop 20 px
mask with the 7-stop ladder (5 / 15 / 30 / 50 / 70 / 85 / 100 % alpha at 15 / 30 / 45 / 60 / 75 / 87 / 100 % of a
28 px fade), keep the native `animation-timeline: scroll(self)` path behind `@supports`, and add the sensor
fallback (fade = 0 when `scrollTop <= 2` or within 2 px of the bottom). Apply it to the file tree, problems body,
chat log, console, palette list, walkthrough text and the tab strip's hidden side (which today has its own 20 px
mask).

**A4 · Counters and micro-feedback (P3).** Source: v1 §2.3, §5.5.4. `font-variant-numeric: tabular-nums` on
every changing number (problem counts, console counts, cursor position, token/char counters). The chat "Copied"
state fades with `saved-check-decay` (hold to 75 %, fade and settle) over 2.5 s instead of switching back. A 6 px
status dot with a 1.2 s opacity pulse (static under reduced motion) marks "running" on the preview state pill and
"thinking" in the chat status line, always next to the word.

**A5 · Type and wrapping details (P2).** Source: v1 §1.5, v1 §6.5.3. `text-wrap: balance` on dialog and welcome
headings, `text-wrap: pretty` on prose (chat answers, lessons, problem explanations); the CJK anti-split combo
(`overflow-wrap: anywhere; word-break: normal; min-width: 0`) on every path, file name and URL so a Chinese file
name with spaces never splits vertically in a 220 px sidebar; inline icons next to text aligned at `-0.125em`
(`-0.075em` for 11–12 px) instead of per-component nudges; the font stacks list PingFang SC / Microsoft YaHei
explicitly after the UI face. **Not** adopted: the dark-mode weight compensation (`font-variation-settings`),
because the system fonts on zh-CN Windows are not variable and the spec already sets weight 400.

### Track B (S48) — AI chat panel engine

**B1 · Streaming scroll latch (P1, defect).** Source: v1 §6.4, `useClaudeScrollPinning.ts`. Any wheel, touch,
key or pointer-down on the log stamps `lastUserInputAt` and unpins; new content scrolls only when
`performance.now() - lastUserInputAt > 150` and the log is within 40 px of the bottom; scrolling uses
`behavior: 'auto'`; a "回到最新 / Jump to latest" button (icon + word, `role=status` count of new messages)
appears when the user is more than 120 px up. Fixes the yank in `ChatPanel.tsx:168-173`. Pure model
`scroll-latch.ts` with unit tests, reused by the console (C4).

**B2 · Auto-growing composer (P1).** Source: v1 §3.3.3. `field-sizing: content` where supported, a hidden mirror
element otherwise; minimum 44 px, maximum `min(40svh, 200px)` so the preview column stays visible; the manual
resize handle goes. Enter / Shift+Enter rules unchanged.

**B3 · IME guard stage 2 and Escape containment (P1 for zh-CN).** Source: v1 §3.3.2. `workbench/ime.ts` gains a
`compositionend` timestamp; on WebKit (macOS) an Enter within 500 ms of it is ignored unless Ctrl/⌘ is held;
Escape while a candidate list was just open is stopped so it cannot close the panel or dialog behind it. Applies
to chat, inline edit, rename, wizard, palette and annotation notes through the one guard. Extends the S35.4
Electron regression and the native IME checklist in `MANUAL-CHECKS.md`.

**B4 · `@file` mentions and `/` commands in the composer (P2).** Source: v1 §3.3.1. Trigger grammar: `/` at the
start or after whitespace opens the command list (same registry and matcher as the palette, `palette-model.ts`);
`@` opens a project file list (type-ahead over the file-tree model); trailing punctuation including CJK marks
(`，。、；：！？…`) is stripped; backslashes normalise to `/`; at most 256 mentions, 1024 chars per path. Keyboard:
Up/Down wrap, Enter or Tab accept, Escape closes without closing the panel. A mention becomes an existing context
chip, so the three Add buttons stay visible (M16 rule).

**B5 · Code blocks that do something (P1).** Source: v1 §5.5.4, `CodeBlock.tsx`. Header with the language in
lowercase and an optional file name, a tabular-nums gutter, no wrapping, horizontal scroll; syntax colours from
`monaco.editor.colorize` with the current theme (offline); actions **Copy**, **Insert at cursor** and **Replace
selection** (the last two only when an editor is open and the language matches or is plain), each going through
the existing edit path so undo and save state behave. Copy feedback per A4.

**B6 · Long messages and quiet actions (P3).** Source: v1 §3.1. User messages taller than 300 px collapse behind a
3 rem fade with "展开 / Show more"; a per-message action row (copy, re-ask, quote) is hidden until hover and
revealed by `focus-within`, so it stays keyboard-reachable without visual noise.

**B7 · Zero-loss drafts and provider backoff (P2).** Source: v2 §2.3, v1 §6.7. The unsent composer text and
context chips are written to app-data per conversation (debounced 300 ms) and restored after a crash or restart
with a status line saying so; a send that fails keeps the text and offers "重试 / Retry now". On HTTP 429 and 503
the client waits `min(max(base, 5 s) · 2^(n-1) · jitter 0.85–1.15, 600 s)` with a visible countdown, retries at
most 3 times automatically, then waits for the user. Never written into the project folder.

**B8 · Proposal and approval card tones (P2).** Source: v1 §3.5. `AgentProposalCard` / `ProposalReview` map the
existing states (`pending`, `applying`, `applied`, `failed`, `rejected`, `expired` in `agent-decisions.ts`) to one
tone each: pending gets the only prominent border and the single primary action, running is neutral with the
status dot, applied/failed/rejected use the `--ok/--danger/--muted` soft fills with icon and word. The structured
input (file, range) and the result (lines changed, save state) are disclosures, closed by default.

### Track C (S49) — Layout physics and navigation

**C1 · Splitter physics (P1).** Source: v1 §5.3, `ArtifactsSplitPaneResizer.tsx`. A drag starts only after 4 px of
movement (clicks on the grip no longer nudge); double-click resets the files width to 220 and the editor share to
0.5; Escape during a drag restores the start value; dragging the files splitter under 120 px collapses the panel
(same state as `toggle-files`, with the rail button showing it) and dragging it back out reopens it; `aria-valuetext`
is announced in words. Because pointer events over the native preview go to the `WebContentsView`, the drag sets
the existing `covered` state after the dead zone and shows the last S38.1 snapshot in the stage until release, so
the preview never swallows the drag. No wheel or scroll change.

**C2 · Roving focus for toolbars and groups (P1, a11y).** Source: v1 §6.6, `useClaudeRovingFocus.ts`. One hook
`useRovingFocus({ orientation, loop, rtl })`: Tab and Shift+Tab always leave the group; arrows move within it;
Home/End and PageUp/PageDown jump; only the active item is `tabIndex=0`; `focus({ preventScroll: true })`.
Applied to the rail, the Code/Preview switch, the viewport switch, the preview `role=toolbar`, the chat
add-context group and the proposal action row. F6 region order unchanged; an axe scan and a unit test per group.

**C3 · File tree type-ahead and file-type icons (P2).** Type-ahead on printable keys selects the next row whose
name starts with the buffer (1 s reset, IME-guarded); icons by extension (html, css, js, json, image, font, text,
other) at the one 1.5 px stroke in `icons.tsx`, with the role label unchanged. No drag-and-drop in this plan
(see §7).

**C4 · Console pinning, search and copy (P2).** Reuse B1's latch for the console; a search field filters lines
(case-insensitive, zh-CN safe); "Copy line" on each row and "Copy all visible" in the toolbar; "Jump to latest"
with the pending count. The 200-line window and the dropped/throttled count stay as they are.

**C5 · Palette recents and a tab overflow list (P3).** The command palette ranks the last 8 run commands first
(app-data, per user) and shows them when the query is empty; the tab bar's overflow gets a "所有标签 / All tabs"
menu listing every open file with its state word, closable from the list.

**C6 · Container-query ladder and hit-box compensation (P2).** Source: v1 §6.5, v2 §2.8. The preview toolbar
and the chat composer "chin" become named containers with four tiers (≥ 576 px full; < 480 px drop kbd hints and
secondary actions; < 384 px icon-only with 4 rem label ellipsis; < 320 px 4 px padding and
`max-width: max(6rem, calc(100cqw - 4rem))`). Every 28 px row control gets a negative `margin-block` so the hit
target is at least 32 px without changing the visual row. Key-features-visible passes at all five sizes.

### Track D (S50) — Dialogs, notices and surfaces

**D1 · One Sheet (P1, finishes S45.9).** Rebuild the archived `Sheet.tsx` on the calm rules: title, one-line
description, scrolling content, trailing actions (Cancel before the default; destructive verbs drawn destructive),
Escape, focus trap and return, backdrop click configurable per dialog, max height
`calc(100dvh - 2 × max(32px, titlebar inset))`, a nested dialog dims and blurs its parent by 2 px. History,
recovery, create-project, delete-confirm, about, glossary, AI settings and the palette adopt it. The archived
`PreviewMoreMenu` and `AddContextMenu` stay dropped (M16).

**D2 · Notice anatomy and tones (P1, defect).** One `Notice` (from the archive): tone icon, one-line title, at most
one sentence, details behind a disclosure, actions trailing with one primary. `EntryNotice`'s success state and
`TransferNotice` stop using the danger fill. Enter/exit per A2. Whether a pure confirmation (`role=status`, never
an alert) may auto-dismiss after 8 s is an owner decision (§8); the default in this plan is **no timers**.

**D3 · Rings, chamfer and shadows within the calm spec (P2).** Source: v1 §1.4.1, v2 §2.7. State changes use inset
`box-shadow` rings instead of border changes so rows and tabs never shift by a pixel; overlays in dark get a
1 px inner highlight (`glassStroke`) instead of a lighter border; the one overlay shadow derives from the surface
via `color-mix` so both themes share a recipe; disabled controls follow the spec (muted text + inset 1 px line
ring, no `opacity: .5`); the selected tab uses `--raised` as specified; welcome template cards get a hover fill
and ring, no scale. The design-rules scan gains a "no border change on `:hover`/`[aria-selected]`" rule.

**D4 · Density setting (P2).** Source: v2 §3.3. Tokens `--control-h` (28 / 32), `--row-h` (28 / 32),
`--radius-control` (6 / 8) selected by `data-density="compact|comfortable"` on `<html>`, chosen in the View menu
and the palette, persisted in settings. Default stays comfortable (beginners); compact is for small laptops.
`key-features-visible.spec.ts` runs at both densities.

**D5 · macOS traffic-light geometry under zoom (P3, manual-mac).** Source: v1 §6.1,
`createClaudeMainWindow.ts`. `setWindowButtonPosition` recomputed on `zoom-changed` so the lights stay centred in
the 52 px bar at every zoom; window `backgroundColor` already follows the theme (S46.2). Verified with the
S46.9 manual check.

## 6. Deliberately not copied

| Source item                                                   | Why not                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Clay accent, personal-tint bubbles, warm `#d97757` focus glow | Monochrome brand (0034); focus is the single 2 px outline                        |
| Press scale `.975`, overshoot springs, 15-stop `linear()` pop | 0034 bans pressed-state scaling; the scan enforces it                            |
| Ambient glow canvas loop, shimmer text, 1.8/2.2 s halo        | rAF loop on a laptop; contradicts "quiet by default"                             |
| Framer Motion, Tailwind, lucide                               | No animation dependency; tokens already exist; icons are bundled                 |
| Token gauge, model/effort switcher, prompt-cache bars         | Chat-product concerns; NoobIDE's provider settings are a dialog                  |
| Voice, AudioWorklet, synthetic sounds                         | Out of MVP scope; sound in a learning IDE is noise                               |
| Cowork multi-agent canvas, BroadcastChannel sync              | Excluded by PLAN §4                                                              |
| iframe sandbox shield and `postMessage` user-activation gate  | Preview is a native view with a main-process bridge; no DOM channel exists       |
| Variable-font icon axes, dark-mode weight compensation        | Needs a variable font; zh-CN Windows system fonts are not                        |
| Cool canvas (`#fcfcfb` / `#151515`) from v2                   | Owner chose warm neutrals in S46; raised as a question in §8, not changed here   |
| Sidebar session drag-and-drop with ghost tilt                 | No reorderable list in NoobIDE yet; tab reorder is a candidate, not in this plan |
| The Storybook                                                 | CDN-loaded; offline rule                                                         |

## 7. Ideas noted, not planned

Tab drag-to-reorder (needs the 4 px dead-zone drag model from C1 first); a floating selection pill for Explain /
Edit with AI (PROGRESS Session 23); bottom-sheet chat in narrow windows; native Mica/vibrancy behind `--bg`
(Session 26); Monaco-side diff viewer with `gridRow: span N` alignment for streaming proposals (the current Monaco
diff editor already aligns; revisit if proposals stream).

## 8. Owner decisions needed before S47 starts

1. **Canvas temperature.** The source's v2 cooled its canvas because warm paper tints muddy syntax and diff
   colours. NoobIDE's editor sits on `--panel` (`#FFFFFF` / `#232220`) inside a warm `--bg`. Keep warm (default
   of this plan) or move `--panel` dark to a neutral `#1F1F1E`? Decide after looking at a diff in dark mode.
2. **Auto-dismiss.** Allow pure confirmations (`role=status`) to dismiss after 8 s with a pause on hover and focus?
   Default: no timers (PLAN §3: never steal or interrupt).
3. **Density default.** Comfortable (this plan) or compact on displays ≤ 1366 px wide?
4. **Scope of B4.** `/` commands only, or `@file` mentions too, in the first pass?

## 9. Backlog mapping and order

| Session | Title                                  | Depends on | Features            |
| ------- | -------------------------------------- | ---------- | ------------------- |
| S47     | Motion, scroll edges and type details  | S46        | S47.1–S47.5 (A1–A5) |
| S48     | AI chat panel engine                   | S47        | S48.1–S48.8 (B1–B8) |
| S49     | Layout physics and navigation          | S47        | S49.1–S49.6 (C1–C6) |
| S50     | Dialogs, notices, surfaces and density | S47, S45   | S50.1–S50.5 (D1–D5) |

S48, S49 and S50 are independent of each other and can run in parallel worktrees once S47 (tokens and the
scan rules) has landed. Within each session the P1 items come first. Suggested first sitting: S47.1 → S48.1 →
S48.2 → S50.2, which removes the three defects (scroll yank, fixed composer, danger-styled success notices)
and installs the motion gate everything else relies on.

## 10. Verification strategy

- **Models first.** Scroll latch, trigger grammar, backoff, type-ahead, density tokens and splitter thresholds are
  pure functions with unit tests beside them (`*.test.ts`), the way `layout.ts` and `palette-model.ts` are
  tested today.
- **Markup.** Components render through `renderToStaticMarkup` to assert roles, names, tones and words
  (both locales).
- **Stylesheets.** `design-rules.test.ts` gains rules for literal durations and easings, border changes on state,
  and the new token names; `tokens.test.ts` keeps contrast on any new soft fill.
- **Electron e2e.** One spec per track: reduced-motion (`emulateMedia`), key-features-visible at five sizes and
  two densities, axe with no serious or critical findings, the S35.4 IME regression extended for B3, and a
  chat-stream spec that scrolls up during a fake stream and asserts the view stays put.
- **Manual.** D5 and the visual pass on real hardware go to `harness/MANUAL-CHECKS.md` as `needs_manual_check`.
