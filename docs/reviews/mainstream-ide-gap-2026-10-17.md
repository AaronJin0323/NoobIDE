# NoobIDE versus mainstream IDEs — functional gap assessment and improvement plan

- **Date:** 2026-10-17 · **Requested by:** owner · **Branch:** `claude/noobide-vs-mainstream-ides-310020`
- **Compared against:** Visual Studio Code (stock, plus the extensions a web beginner is usually told to install:
  Live Server / Live Preview, Prettier, ESLint) and JetBrains IntelliJ IDEA Ultimate / WebStorm (the JetBrains web
  stack; IntelliJ Community has no HTML/CSS/JS tooling of note).
- **Evidence boundary.** NoobIDE facts come from this checkout at `90a9fc5`: `harness/features.json` (222 features,
  statuses as of today), `docs/capabilities.md` (the only validated language claims), `src/shared/commands.ts`
  (the command registry), `src/workspace/file-ops.ts`, `src/renderer/editor/CodeEditor.tsx`,
  `src/preview/preview-manager.ts` and the module READMEs. I did not run the packaged app for this review; where a
  Monaco default probably provides something but no test proves it, the table says so. VS Code and JetBrains facts
  are general product knowledge, not re-verified today.
- **Frame.** PLAN §1 says v1 competes on how many beginners finish the ten-minute loop, not on depth parity, and
  PLAN §12 already sequences the big gaps (v0.2 editing, v0.3 Git, v0.4 frameworks/terminal, v0.5 debugger). This
  review therefore ranks gaps by **how soon a beginner building a static site hits them**, not by how large the
  feature is in VS Code.

## 1. Where NoobIDE stands today

Milestones M0–M6, M9–M12 and M14–M17 are complete apart from manual hardware checks; M7 (release pipeline) is
blocked on owner tasks (signing, physical Mac). Functionally the product is a finished static-site MVP:

| Area                | Shipped (feature ids)                                                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects and files  | Templates, open folder, recent projects, reveal in OS, create/rename/trash, never-overwrite, lazy tree, watcher, Chinese paths (S07–S08, S13, S20)                                            |
| Editing             | Tabs with preserved view state, Monaco HTML/CSS/JS, validated completion/hover/format, project-aware id/class/path completion, indentation detection, IME-safe inputs (S09, S18, S43, S35.4)  |
| Saving and recovery | Atomic autosave with state machine, external-change conflicts with diff, crash journal, per-file local history with diff-before-restore, session restore (S10–S13, S21)                       |
| Preview             | Loopback static server with path guard, sandboxed `WebContentsView`, auto/manual refresh, entry page, viewport width, external browser, detached DevTools, per-project storage (S04, S14–S15) |
| Errors              | Unified runtime + static ProblemRecords, console, go-to-code, 15 explained problem types, one-click typo fix (S16–S17, S19, S22)                                                              |
| Learning            | Walkthrough in a real project, glossary, file-role hints, unguided task (S23)                                                                                                                 |
| AI                  | Chat, explain, agent diffs through the save pipeline, inline edit, `/ai` line prompts, ghost text, preview annotations as context, saved chats, budgets (S31–S43)                             |
| Shell               | Command registry, palette, native menus, F6 region focus, themes, zoom, zh-CN/en, calm design pass (S24, S30, S40, S46)                                                                       |

### What NoobIDE does that VS Code and IntelliJ do not (keep and lean on)

- **Zero-setup isolated preview** with refresh gated on a confirmed write. VS Code needs an extension and a browser;
  WebStorm's built-in preview is not sandboxed from the IDE process the way a separate `WebContentsView` is.
- **Runtime and static problems in one list, explained in beginner language**, with the original error kept. Neither
  mainstream IDE explains a `ReferenceError` from the page it is previewing.
- **Preview annotations mapped to source** and handed to the AI. No equivalent in either IDE.
- **Recovery as three distinct, visible mechanisms** (undo, crash journal, local history). JetBrains has Local History;
  VS Code has a Timeline that depends on hot exit and is easy to miss.
- **Never-overwrite file operations and a start-preview consent** for external folders. Mainstream IDEs will happily
  overwrite on rename/move.
- **Chinese-first UI with beginner glossary** and a guided ten-minute loop. VS Code's walkthroughs are about the
  editor, not about building a page.

## 2. Functional gap matrix

Legend for the NoobIDE column: **Yes** = shipped and proven · **Partial** = exists but hidden, unproven or limited ·
**No** = absent · **Excluded** = out of scope by PLAN §4. Priority: **P1** = a beginner hits it in week one of a
static site · **P2** = within the first month or when the site grows past a few files · **P3** = professional
feature, low beginner value or deliberately excluded.

### 2.1 Projects and files

| Capability                                                      | VS Code             | WebStorm / IntelliJ  | NoobIDE               | Priority | Notes                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------- | -------------------- | --------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Move files/folders (drag in tree, "Move to…")                   | Yes                 | Yes, reference-aware | **No**                | **P1**   | `file-ops.ts` exports create, rename, trash only. Moving `logo.png` into `images/` is a day-one task.                                                 |
| Copy / paste / duplicate in tree                                | Yes                 | Yes                  | **No**                | P2       | "Duplicate page" is how beginners make a second page.                                                                                                 |
| Multi-select in tree (delete several)                           | Yes                 | Yes                  | **No**                | P3       |                                                                                                                                                       |
| Import external files (drag from Finder/Explorer, "Add files…") | Yes (drop)          | Yes (drop/copy)      | **No**                | **P1**   | PLAN §12 v0.2 "resource import". Today the user must leave the IDE to add an image.                                                                   |
| Image / asset viewer                                            | Yes (image preview) | Yes                  | **No**                | P2       | Binary files are refused with a notice (`text-codec.ts`), which is correct for safety but leaves no way to see the picture or copy its relative path. |
| Quick open by file name (Ctrl+P / Shift+Shift)                  | Yes                 | Yes                  | **No**                | P2       | The palette (S40.5) lists commands only.                                                                                                              |
| Multiple windows / projects at once                             | Yes                 | Yes                  | **No**                | P3       | Single `BrowserWindow` (`main.ts:220`). Fine for v1.                                                                                                  |
| Multi-root workspaces                                           | Yes                 | Modules              | Excluded              | P3       |                                                                                                                                                       |
| Workspace trust                                                 | Yes                 | Yes                  | Yes (preview consent) | —        | NoobIDE's is narrower and clearer.                                                                                                                    |
| Markdown preview (README)                                       | Yes                 | Yes                  | **No**                | P3       | Templates ship without README today; low value.                                                                                                       |

### 2.2 Editing

| Capability                                    | VS Code                      | WebStorm / IntelliJ | NoobIDE                             | Priority | Notes                                                                                                                                                                                  |
| --------------------------------------------- | ---------------------------- | ------------------- | ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find / replace in file, discoverable          | Menu + Ctrl+F/H              | Menu + Ctrl+F/R     | **Partial**                         | **P1**   | Only Monaco's default widget by keyboard. No menu item, palette command, toolbar button or i18n string exists (`commands.ts`, `en.ts`). PLAN §4 lists find/replace as required for v1. |
| Find in files / replace across project        | Yes                          | Yes                 | **No**                              | **P1**   | PLAN §12 v0.2. Needed as soon as a class name is used in two pages.                                                                                                                    |
| Go to line                                    | Yes                          | Yes                 | Partial (Monaco Ctrl+G, unsurfaced) | P3       | Problems → go-to-code covers the main case.                                                                                                                                            |
| Toggle line/block comment, discoverable       | Menu                         | Menu                | Partial (Monaco Ctrl+/)             | P2       | PLAN §4 "comments" is a v1 requirement; needs a menu entry and a glossary term.                                                                                                        |
| Multi-cursor, column selection                | Yes                          | Yes                 | Partial (Monaco defaults)           | P3       | Fine to leave unsurfaced.                                                                                                                                                              |
| Emmet abbreviations (`!`, `ul>li*3`)          | Built in                     | Built in            | **No**                              | P2       | Taught in most beginner HTML courses; pure-JS packages exist.                                                                                                                          |
| Snippets                                      | User + extension snippets    | Live templates      | Partial (4 beginner snippets)       | P3       | Extend only with evidence from the beginner study.                                                                                                                                     |
| Auto-rename paired HTML tags, wrap with tag   | Yes (linked editing) / Emmet | Yes                 | **No**                              | P2       | Monaco supports `linkedEditing`; not enabled or validated.                                                                                                                             |
| Colour swatches and picker in CSS             | Yes                          | Gutter icons        | Partial                             | P2       | PLAN §2 promises "colour hints"; Monaco's CSS service can provide decorators but `docs/capabilities.md` has no case, so it is not claimable.                                           |
| Formatting                                    | Prettier ext / built in      | Built in            | Yes (button + shortcut)             | —        | Format-on-save is not offered; keep optional.                                                                                                                                          |
| Word wrap toggle, font family                 | Yes                          | Yes                 | **No**                              | P3       | Settings hold locale, theme, font size, restore-session only.                                                                                                                          |
| Split editor (HTML beside CSS)                | Yes                          | Yes                 | **No**                              | P3       | One Monaco instance for all tabs. Preview already takes the second column; defer.                                                                                                      |
| Bracket pairs, folding, indent guides         | Yes                          | Yes                 | Yes (Monaco)                        | —        |                                                                                                                                                                                        |
| Go to definition / references / rename symbol | Yes (TS service)             | Yes                 | **No** (explicitly not claimed)     | P2       | PLAN §12 v0.2. The TS worker already knows project scripts (S18.4), so the cost is mostly validation and UI.                                                                           |
| Outline / structure view, breadcrumbs         | Yes                          | Yes                 | **No**                              | P3       |                                                                                                                                                                                        |
| Keyboard shortcut customisation               | Yes                          | Yes                 | **No**                              | P3       |                                                                                                                                                                                        |
| Recently closed tabs, back/forward navigation | Yes                          | Yes                 | **No**                              | P3       |                                                                                                                                                                                        |

### 2.3 Running, previewing and debugging

| Capability                                  | VS Code             | WebStorm / IntelliJ      | NoobIDE               | Priority | Notes                                                                                               |
| ------------------------------------------- | ------------------- | ------------------------ | --------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| Built-in isolated live preview              | Extension           | Built in (not sandboxed) | **Yes, stronger**     | —        |                                                                                                     |
| Refresh after save, auto/manual             | Extension           | Yes                      | Yes                   | —        |                                                                                                     |
| CSS change without full reload (state kept) | Live Server reloads | Yes (Live Edit)          | **No**                | P2       | PLAN §3 lists it for after v1. Beginners lose form state and scroll position on every colour tweak. |
| Element → source mapping                    | No                  | Partial                  | Yes (annotations)     | —        |                                                                                                     |
| Chromium DevTools                           | Browser             | Via extension            | Yes (detached button) | —        |                                                                                                     |
| Breakpoint debugger                         | Built in            | Built in                 | Excluded (v0.5)       | P3       | `console.log` plus explained errors covers the beginner case.                                       |
| Device width switch                         | No                  | No                       | Yes                   | —        |                                                                                                     |
| Network / resource failures                 | DevTools            | DevTools                 | Yes (as problems)     | —        |                                                                                                     |

### 2.4 Diagnostics and quick fixes

| Capability                                                         | VS Code                | WebStorm / IntelliJ | NoobIDE                                   | Priority | Notes                                                                                   |
| ------------------------------------------------------------------ | ---------------------- | ------------------- | ----------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| Problems panel                                                     | Yes                    | Yes                 | Yes, with explanations                    | —        |                                                                                         |
| HTML structural checks (unclosed tag, duplicate id, missing `alt`) | Extension (HTMLHint)   | Built in            | Partial (`html-check.ts`, 15 rules)       | P2       | Expand the rule set with the most common beginner mistakes.                             |
| CSS checks (unknown property, invalid value)                       | Built in (CSS service) | Built in            | Partial (Monaco markers flow through S19) | P2       | Confirm which markers are surfaced and explained.                                       |
| Quick fixes / intentions (lightbulb, Alt+Enter)                    | Yes                    | Rich                | Partial (one typo fix + AI fix)           | P2       | Broken `src`/`href` → "create file" or "pick file" would remove a top beginner failure. |
| Spelling in strings/comments                                       | Extension              | Built in            | **No**                                    | P3       |                                                                                         |

### 2.5 Version control, terminal, extensibility, collaboration

| Capability                            | VS Code            | WebStorm / IntelliJ     | NoobIDE         | Priority  | Notes                                                                              |
| ------------------------------------- | ------------------ | ----------------------- | --------------- | --------- | ---------------------------------------------------------------------------------- |
| Per-file local history                | Timeline           | Local History           | Yes             | —         |                                                                                    |
| Whole-project snapshot / checkpoint   | No (Git)           | Local History (project) | **No**          | P2        | PLAN §7 "after v1". A named checkpoint before an experiment is the beginner's Git. |
| Git status, diff, commit, history     | Built in           | Built in                | Excluded (v0.3) | P3 for v1 | Keep sequenced after checkpoints.                                                  |
| Integrated terminal, npm, tasks       | Yes                | Yes                     | Excluded (v0.4) | P3        |                                                                                    |
| Extension marketplace                 | Yes                | Yes                     | Excluded        | P3        | PLAN §5: marketplace access is not available to forks anyway.                      |
| AI assistant                          | Copilot (paid ext) | AI Assistant (paid)     | Yes (own key)   | —         |                                                                                    |
| Live Share / Code With Me, remote dev | Yes                | Yes                     | Excluded        | P3        |                                                                                    |
| Publish / deploy                      | Extensions         | Deployment tool         | Excluded        | P3        | "Export a zip to send to a friend" is the beginner-sized version; idea only.       |

### 2.6 Shell and personalisation

| Capability             | VS Code             | WebStorm / IntelliJ | NoobIDE             | Priority | Notes                                                                                   |
| ---------------------- | ------------------- | ------------------- | ------------------- | -------- | --------------------------------------------------------------------------------------- |
| Command palette        | Yes                 | Search Everywhere   | Yes (commands only) | —        | Extend to files and symbols rather than build new UI.                                   |
| Settings UI depth      | Hundreds            | Hundreds            | Six settings + AI   | —        | Deliberate (PLAN §3). Add only word wrap and autosave delay if the study asks for them. |
| Themes                 | Many                | Many                | Light/dark          | P3       |                                                                                         |
| Localisation           | Language packs      | Language packs      | zh-CN/en            | —        |                                                                                         |
| Accessibility          | Strong              | Strong              | Pass done (S24.3)   | —        |                                                                                         |
| Walkthrough / learning | Editor walkthroughs | Features Trainer    | Yes, project-based  | —        |                                                                                         |

## 3. Gaps that matter, ranked

1. **File management is incomplete for a real project** — no move, no copy/duplicate, no import of outside files, no
   image viewer. A beginner adding a photo to their homepage cannot finish inside NoobIDE. (P1, §2.1)
2. **Search is missing or hidden** — find/replace in file has no visible entry; there is no find-in-files or
   quick-open. This blocks the PLAN §4 v1 requirement and every multi-file edit. (P1, §2.2)
3. **HTML/CSS authoring aids that courses assume** — Emmet, paired-tag rename, colour picker, comment toggling in the
   menu. Each is cheap because Monaco or a pure-JS package supplies the engine. (P2, §2.2)
4. **The edit → see loop reloads the page for a CSS change**, losing state. The mainstream answer is CSS injection.
   (P2, §2.3)
5. **Static checks and quick fixes stop at 15 rules and one fix.** Broken relative paths, duplicate ids and missing
   `alt` are not explained with a fix. (P2, §2.4)
6. **No project-wide checkpoint** before Git arrives in v0.3. (P2, §2.5)
7. **JS navigation and rename** are explicitly unclaimed although the worker already has the files. (P2, §2.2)
8. Everything else (split editor, outline, multi-window, keybinding editor, Git, terminal, debugger, marketplace) is
   P3: either excluded by PLAN §4 with reasons that still hold, or of little value until the beginner study shows
   otherwise.

**Caveat.** H.3 (wireframe walk-through) and H.6 (five-beginner study) are still `todo`. The ranking above is an
engineering reading of PLAN §2 and §4; the study may reorder items 3–7 and should run before v0.2 is committed to.

## 4. Improvement plan

Proposed as a new milestone **M19 — Everyday editing parity (PLAN §12 v0.2)** with sessions S51–S57 (M18 and S47–S50 are taken by the UI/UX refinement work on PR #14, so the ids here start after them), to be added to
`harness/features.json` on the owner's say-so so that verify tracks them. Order follows the ranking; each session is
a solo-developer estimate at PLAN's "30 productive hours per week" and includes tests. Every session must keep the
AGENTS.md invariants: atomic never-overwrite writes, trash not delete, preview isolation, restricted IPC,
`src/platform` for OS differences, i18n for every string, no network.

### S51 — Find, replace and quick open (≈1 week) — P1

- Surface Monaco find/replace: Edit menu items, palette commands, `Ctrl/Cmd+F`, `Ctrl+H` / `⌥⌘F`, and "replace"
  obeying the file's indentation and the save pipeline (a replace-all is one undo step and one history snapshot).
- Find in files panel in the bottom region beside Problems: literal and regex, case and whole-word toggles, results
  grouped by file with context lines, click → go to code, "Replace in files" with a per-file preview and apply
  through `save-controller` (unsaved buffers searched in memory, disk files via a bounded streaming scan in main
  that respects `src/workspace/ignore.ts`, skips binaries and caps file size).
- Quick open: the existing palette gains a "files" mode (`Ctrl/Cmd+P`) with fuzzy match over the tree index
  from S43.4.
- Acceptance: integration test on a 2 000-file fixture with Chinese paths and spaces (results under 1 s, main not
  blocked); e2e: replace a class name across three files, preview refreshes once, local history has a snapshot per
  file; keyboard-only operation; zh-CN and en strings.

### S52 — Complete file management (≈1.5 weeks) — P1

- Move: drag-and-drop in the tree and a "Move to…" dialog; folders too; collisions are refused like rename (S08.4).
  Open tabs, models, recovery journal entries and history identity follow the new path (decision 0006).
- Copy/paste and Duplicate (`page.html` → `page copy.html`, naming per the platform rules in `file-names.ts`).
- Multi-select for trash and move.
- Import from outside: drop from Finder/Explorer onto the tree, and "Add files…" / "Add image…" dialogs that copy
  (never link) into the chosen folder, refusing overwrites and explaining size or type limits.
- Image viewer tab for png/jpg/gif/svg/webp/ico: dimensions, byte size, a "Copy `<img>` tag" and "Copy relative
  path" action; served through the app protocol, never through the preview server. Fonts and other binaries keep
  the current refusal notice.
- Acceptance: file-op tests for every operation under Chinese paths; watcher replay test for an external move;
  e2e: drop an image, insert it with completion, see it in the preview; a11y: all operations reachable from the
  context menu and keyboard.

### S53 — HTML/CSS authoring aids (≈1 week) — P2

- Emmet expansion for HTML and CSS on Tab, with a status-bar hint the first time it fires; decision record for
  the package choice (pure JS, pinned, licence checked) and an off switch.
- Enable Monaco `linkedEditing` (rename paired tags) and validate it; "Wrap with tag" command.
- Colour decorators and the Monaco colour picker validated as capability cases, so PLAN §2's "colour hints" can be
  claimed; add a glossary entry.
- Toggle comment in the Edit menu and palette; "Format on save" as an opt-in setting.
- Acceptance: new rows in `docs/capabilities.md` backed by cases in `tests/fixtures/lang-capabilities/cases.json`;
  e2e in the packaged app offline.

### S54 — CSS without reload (≈1 week) — P2

- When a save touches only `.css` files and the page is running, replace the matching `<link>` stylesheet(s) through
  the existing preview protocol in the isolated world; full reload remains the path for HTML/JS and for any
  failure, and the toolbar says which happened.
- Decision record extending 0019/0030: no new IPC exposed to the page, no inline script injection.
- Acceptance: e2e proves form input and scroll position survive a colour change; fault test proves a broken CSS file
  falls back to reload and reports the problem; console flood limits unchanged.

### S55 — More beginner checks and quick fixes (≈1.5 weeks) — P2

- Rules 16–25 chosen from the H.6 study where available, otherwise: broken relative `src`/`href`, duplicate `id`,
  missing `alt`, unclosed/mismatched tag, unknown CSS property, missing unit, `onclick` referencing an undefined
  function, script loaded before the element it needs, `querySelector` returning null at runtime, mixed-case file
  name on a case-sensitive host (ties to the portability scan).
- Fixes offered on the problem card and in the editor lightbulb: create the missing file from a template, pick an
  existing file, add `alt`, close the tag, rename to the defined id/class. All fixes are ordinary edits (undoable,
  autosaved, snapshotted).
- Acceptance: each rule has a positive and a negative fixture; explanation texts reviewed for honesty (PLAN §9).

### S56 — Project checkpoints (≈1 week) — P2

- "Save a checkpoint" names a whole-project snapshot in app data (reusing the S21 store, content-addressed to avoid
  duplicates); list, compare file-by-file, restore all or one file; a checkpoint is taken automatically before an
  agent proposal is applied and before "Restore" from history.
- Acceptance: integration tests for size limits and corruption tolerance; e2e: checkpoint, break three files,
  restore, preview shows the old page; wording distinguishes checkpoint from local history and from undo.

### S57 — JavaScript navigation and rename (≈1 week) — P2

- Go to definition, find references and rename inside the project's scripts, limited to what the TS worker proves;
  HTML inline `<script>` stays unclaimed unless a case passes. Rename is applied through the save pipeline across
  files with a preview, like S51's replace.
- Acceptance: capability cases for definition/references/rename across two files; a case that documents the known
  limit (inline scripts) so help text cannot over-claim.

### Later, unchanged from PLAN §12

- **v0.3 Git** after S56 shows whether beginners use checkpoints: status, diff, commit, history with the same
  diff-before-action pattern; remote auth later.
- **v0.4 Frameworks and terminal**, **v0.5 Debugger**: entry criteria in PLAN §12 still apply; nothing in this
  review argues for pulling them forward.
- P3 shell items (split editor, outline, multi-window, keybinding editor, markdown preview, more themes) wait for a
  demonstrated need in the beta (H.7).

### Suggested sequence

| Order | Session                     | Why here                                                               |
| ----- | --------------------------- | ---------------------------------------------------------------------- |
| 1     | S51 Find/replace/quick open | Closes a PLAN §4 v1 requirement; smallest and unblocks multi-file work |
| 2     | S52 File management         | Day-one blocker for any page with images                               |
| 3     | S53 Authoring aids          | Cheap wins that make the editor feel like what tutorials show          |
| 4     | S55 Checks and fixes        | Builds directly on the product's strongest differentiator              |
| 5     | S54 CSS without reload      | Highest technical risk of the set; isolate it after the quick wins     |
| 6     | S56 Checkpoints             | Prerequisite mental model for v0.3 Git                                 |
| 7     | S57 JS navigation           | Lowest beginner urgency of the P2 set                                  |

Total: roughly 8 weeks solo. It fits PLAN §12's 3–6 week v0.2 estimate only if S54 and S57 slip to a v0.2.1.

## 5. Not recommended (and why)

- **Copying VS Code's settings and keybinding surfaces.** PLAN §3 forbids moving controls by inferred skill level and
  §1 names configuration load as a beginner failure mode. Add settings one at a time with evidence.
- **An extension marketplace or VS Code extension compatibility.** Monaco cannot host extensions and the Marketplace
  terms exclude other products (PLAN §5). Curated built-ins beat an empty store.
- **A full DAP debugger before run management is stable.** PLAN §12 v0.5 entry criteria.
- **Replacing the custom workbench with Theia/Code-OSS to get parity "for free".** The product's differentiators
  (isolated preview, explained problems, never-overwrite, recovery UX) are the custom parts; the parity gaps above
  are each about a week of work, far below a platform migration.

## 6. Owner decisions needed

1. Approve M19/S51–S57 for `features.json` (adding is allowed; nothing is removed or weakened).
2. Decide whether v0.2 waits for the H.6 beginner study or starts with S51/S52, which the study is unlikely to
   reorder.
3. Package policy for Emmet (S53): a pure-JS dependency is allowed by AGENTS.md but still needs a decision record.
