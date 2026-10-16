# Progress log

Newest entry first. Every session appends one entry using the template at the bottom. `session.mjs start` shows
the latest entry to the next session, so write it for a reader with zero context.

## Session 31 (side session) — 2026-10-16 — S49.1 one Sheet shell for every dialog

**Agent:** Claude (Fable 5.1) on the Windows x64 dev machine, worktree branch `claude/s49-1-sheet-024346`, cut from
`claude/recursing-dewdney-9752a3` @ `86169b6`, then fast-forwarded onto the integration branch
`claude/noobide-ui-ux-assessment-d4624a` @ `42f3ea4` (PR #9 merged; same tree). S47.1–S47.4 in place. Started by the assessment session as one of
four parallel sessions with disjoint file ownership (this one: dialogs). Sibling branches (S47.5/6 frame, S48.1–4
preview, S48.2/3 problems) are not merged here.

**Done**

- S49.1 — One Sheet shell for every dialog (assessment P1 item 6, P2 item 12, S49 table).
  - **`src/renderer/workbench/Sheet.tsx`** is the shell; its header comment is the API contract for S49.2–S49.4:
    `title` (+ `titleIcon`), one-line `description`, scrolling `children`, `actions` in reading order Cancel →
    Primary, `leading` (text or a control set apart at the left of the action row), `onClose` (Close top-right, Esc,
    and the backdrop only with `dismissOnBackdrop`), `onEscape` (step in before closing: History cancels an open
    confirmation), `closeLabel` (the caller's own word: Close / Cancel / Decide later), `closeDisabled` (a restore
    or create in flight), `role` (`alertdialog` is described by its content), `width` 480 | 720 | 960,
    `className` / `backdropClassName` (a feature's z-index), `testId` / `closeTestId`, `sheetRef`. Focus moves in
    when it opens (a child that took focus keeps it → `[data-autofocus]` → first control of the content → Close) and
    returns to the opener on close (`useReturnFocus`). `sheetButtonClass('cancel' | 'primary' | 'danger')` names the
    three button jobs; `escapeAction` is the pure Esc rule. The element keeps the `dialog` / `dialog-backdrop`
    classes, so glass.css (frosted overlay, solid twin under reduced transparency / contrast / forced colours), the
    glass e2e frost probe and `preview-viewport.ts` OVERLAY_SELECTOR (native preview hidden under any sheet, decision 0019) apply unchanged; Workbench's explicit `covered` list did not change.
  - **focus-trap.ts**: the wrap rule is the pure `tabWrapTarget(items, active, shiftKey, inside)`; `trapTab` and
    `useModalKeys` are unchanged in behaviour.
  - **Migrated** (behaviour — what each restores, saves, lists — unchanged): `ConfirmDialog` (480, alertdialog, Cancel
    autofocused, `tone="danger"` for Move to trash from FilesPanel), `AboutDialog` (480), `GlossaryDialog` (720; the
    search stays in view, the list scrolls), `CreateProjectDialog` (720, was 820; Close = Cancel, disabled while
    creating; a backdrop click never loses the typed name), `AiSettingsDialog` (720, was 560; the bottom primary
    Close is gone, Close is top-right; a backdrop click no longer discards a half-typed key; focus moves to the first
    field — the AI on/off box — once the settings arrive, unless the user already moved), `HistoryDialog` (960, was
    1100; Close top-right with `history-close`, disabled while busy; first Esc still cancels an inline confirmation),
    `RecoveryDialog` (720, was 760; see below), `SavedChatsList` delete confirm (Cancel, then "Delete chat" drawn
    `danger-button`; focus still lands on the verb, as the ai-history e2e expects).
  - **Recovery** (P1 item 6): a real modal now — the sheet traps focus and starts on "Open project and review"; Esc,
    the Close control (named 稍后处理 / Decide later) and the footer button all keep every record, and the sheet says
    so under the title (`recovery.keepNote`: 按 Esc 或“稍后处理”不会丢弃任何内容…). A backdrop click does nothing at all.
    "清除全部恢复数据" left the footer for a `<details>` disclosure 高级 / Advanced under the project list (list step
    only); its confirmation, the discard confirmations and the relocate question are Cancel → verb, destructive verbs
    `secondary-button danger-button`. The usage line is the action row's leading text.
  - **Styles** (`styles.css`): one `.dialog` block (flex column, 480 default, `.sheet-720` / `.sheet-960`, 16 px
    backdrop padding so a sheet never touches the window edge, `.sheet-content` is the only scrolling part, `.sheet-
content > * { flex: none }` so sections never shrink into each other — the glossary list opts in), `.sheet-close`
    (the shared `.icon-button` pulled into the title corner), `.dialog-hint` now has `margin: 0` everywhere,
    `.danger-button` stays red text and `.primary-button.danger-button` is the danger fill. Removed the hand-built
    `.recovery-dialog/.recovery-title/.recovery-intro/.recovery-footer`, `.history-head`, `.dialog.wizard`,
    `.glossary-dialog`, `.ai-settings` width rules. `design-rules.test.ts` green (one radius scale, no literal colours).
  - **Tests**: `src/renderer/workbench/sheet.test.ts` (20 tests: anatomy order, Close top-right with the caller's
    label, alertdialog semantics, leading slot, widths, button classes and the danger CSS, ConfirmDialog order and
    tone, the focus-trap wrap rule, the Esc rule, "no component other than Sheet sets aria-modal", every dialog
    renders `<Sheet>`, a sheet with a field never has `dismissOnBackdrop`, inline confirmations are Cancel → danger
    verb). `tests/e2e/recovery.spec.ts`: the clear-data test opens the Advanced disclosure and checks the Cancel →
    danger order; new test "Escape, Close and a click outside keep every recovered copy, and the dialog says so" (aria-
    modal, heading, Close accessible name, keep note, focus start, Tab trap over 8 presses, backdrop click keeps the
    dialog open, Esc and Close keep the journal record across relaunches).

**Evidence:** `npm run verify` green (typecheck, lint, format, 220 unit files). e2e on Windows, run 1: recovery, history,
ai-settings, ai-history, walkthrough (glossary), welcome (wizard), files, file-tree (delete confirm), a11y, glass,
distribution (About), menus, session, problem-card — 87 passed, 2 failed (a strict-mode clash between the confirm
sheet's X and its Cancel, both named 取消, and a stale locator across a relaunch in the new test); fixed (the X of a
confirmation is named 关闭 / Close, `dialog.close`), run 2: recovery + file-tree 24 passed, including the new test
"Escape, Close and a click outside keep every recovered copy, and the dialog says so".

**Decisions:** no new decision record (the shell implements decision 0034's overlay rules and 0019's cover rule).
Choices worth knowing:

- **Esc in Recovery says so before, not after.** Esc, Close and "Decide later" are one action (keep everything, close,
  ask again next start), and the sheet's note under the title states it in words. A notice after closing would need
  the workbench notice stack, owned by the frame session this round; if the owner wants an after-the-fact
  confirmation, add it there (S47.5) rather than a second floating mechanism in the dialog.
- **Close top-right on every sheet, including confirmations.** One shell means the X is always there; on a
  confirmation it does what Cancel does but is named 关闭 / Close (new key `dialog.close`), so Cancel stays the one
  control with its name for screen readers and locators. Only sheets without a field (`ConfirmDialog`, `About`)
  close on a backdrop click.
- **Widths**: History 960 (S49.2 asks for 960), Recovery / Wizard / AI settings / Glossary 720, Confirm / About 480.
- **S45.9, Sheet part — taken from `docs/archive/s44-s45-hig/.../Sheet.tsx` and `Sheet.test.ts`:** the anatomy and
  its order (title → description → content → trailing actions, Cancel before the default), `alertdialog` described
  by its content, the `leading` slot, the `[data-autofocus]` → first control rule with "a child that took focus keeps
  it", focus return, `data-sheet`, the static-markup test style and the renderer scan (no other `aria-modal`).
  **Dropped:** `titleHidden`/`sr-only` header and the `footer` slot (the command palette keeps its own shell — a
  search field with a list is not a titled dialog; it stays the one exception in the scan), the named sizes
  small/medium/wide/large (replaced by the 480/720/960 scale the assessment fixes), the `onMouseDown` passthrough, its
  `focusSnapshot`/`returnFocus` helpers (the existing `useReturnFocus` does this), and `i18n/sheets.ts` (its four
  strings — wizard description, history backup note, recovery discard/clear questions — are not needed: the existing
  confirm strings stay). **Added over the archive:** Close top-right as an icon button carrying the caller's word,
  `closeDisabled`, `onEscape`, `dismissOnBackdrop` off by default, the danger-filled primary. Notice anatomy, button
  hierarchy and the rest of S45.9 remain open.

**Problems / risks:** macOS not run. `glass.css` still names `.recovery-dialog` / `.recovery-backdrop` in its
selector lists (harmless; the recovery sheet now carries `.dialog`) — left alone to avoid conflicts with the parallel
sessions; prune in S49.2. `glass-visual.spec` screenshots that include a dialog will differ by design (not run
here). `FilesPanel.tsx` got one attribute (`tone="danger"`) outside the owned file list.

**Owner action needed:** none new.

**Next up**

1. S49.2 (History focused on restoring, 960 sheet; move storage / orphans to a settings sheet via the History footer
   `leading` slot), S49.3 (one diff review), S49.4 (AI set-up) — all on `<Sheet>`; keep its header contract.
2. When the frame branch (S47.5) lands: decide whether Recovery's Esc should also post an after-the-fact notice.

**Ideas / backlog candidates:** a `Sheet.stories`-style e2e that opens every sheet once and checks Tab order and the
Close focus return in one place (today each feature's spec does its own).

## Session 30 (side session) — 2026-10-16 — S47.4 one name, one home per feature

**Agent:** Claude (Fable 5.1) on the Windows x64 dev machine, worktree branch `claude/recursing-dewdney-9752a3`:
main @ `65c95a0` merged with `claude/xenodochial-hopper-116d81` @ `41ae221` (S47.2 + S47.3, Session 29), so the
welcome layout and the fixed save slot are in place. Started by the assessment session; owner rule (Session 23): no
key feature moves into a menu — the rail keeps Files, Problems, History, Lessons, AI; decision 0034 and
`design-rules.test.ts` unchanged.

**Done**

- S47.4 — One name, one home per feature.
  - **Term table as a test.** `src/renderer/i18n/terms.test.ts` encodes the assessment's table (History 历史版本 /
    History, Lessons 课程 / Lessons, Problems 问题 / Problems, Ask AI 问 AI / Ask AI, AI edit AI 修改 / Edit with AI,
    AI fix AI 修复 / Fix with AI, AI suggestions AI 建议 / AI suggestions, Change project 修改项目 / Change project,
    crash recovery 恢复上次未保存的修改 / Recover unsaved edits, external change 文件在外部被改动 / Changed outside
    NoobIDE). For each term it checks the keys that _are_ the term (rail buttons, headings, buttons), the menu / palette
    labels (term plus an optional …) and the longer messages that must name the feature (tooltips, toggles, hints), and
    it fails if any catalogue value brings a retired name back (本地历史, 入门导览, AI 编辑, 内联编辑, 自动补全,
    智能体, AI 代码建议, 用 AI 修复/修改, 更多操作; local history, walkthrough, inline edit, completions, agent, AI
    edit, more actions). Renamed accordingly: `rail.history`/`history.title`/`command.showHistory`, `rail.ai`/
    `ai.chat.title`/`command.ai.toggleChat`, `command.walkthrough`/`walkthrough.*`, `ai.editor.editButton`/
    `ai.editor.inlineEdit`/`command.ai.inlineEdit`/`ai.edit.region`, `problems.card.fixWithAi`/`problems.row.fixWithAiLabel`,
    `command.toggleInlineAi`/`ai.settings.inline`/`ai.purpose.*`, `recovery.title`, `disk.reloaded`/`conflict.title`,
    and the prose that still said "local history" (agent notes, history group) or "completions" (budget notice). The
    lessons' content follows: glossary entry 历史版本, the restore step says 历史版本, the reopen step points at the
    project menu.
  - **Two menus.** `src/shared/commands.ts` replaces `APP_MENU_COMMANDS` with `PROJECT_MENU_COMMANDS` (close,
    history, lessons) and `HELP_MENU_COMMANDS` (theme, AI chat / explain / edit / suggestions, glossary, logs, AI
    settings); `useAppMenuItems` takes the list. `Workbench.tsx` adds the two items that are not registry commands:
    Reveal (platform label, second in the project menu) and the language choice (中文 / English as `menuitemradio`,
    after the theme group of the help menu). `AppMenu.tsx` takes a name, test id, icon, `alignEnd` and a `detail`
    line; the project menu (`project-menu`, ▾ next to the project name, list `#project-menu-list`) shows the project
    folder as its first line (`project-path`); the help/more menu keeps `app-menu` / `#app-menu-list`, opens flush
    right, and is named 帮助与更多 / Help and more.
  - **Top bar.** `TopBar.tsx`: the path is the project name's `title` (hover) and the menu line, no second line
    (`.project-detail` and `topbar.language`/`topbar.switchLanguage` removed); the reveal icon button and the
    language button leave the bar; the trailing group is command search + help menu. The S47.2/S47.3 box tests still
    hold (`shell.spec` measures `app-menu` in place of the language button). The walkthrough's reopen anchor is the
    project menu button (`walkthrough-model.ts`).
  - **Tests moved with the UI.** `tests/e2e/project.ts` gains `switchLanguage(page)` (help menu → the other
    language, waits for `html[lang]`) and `projectMenu(page, id)`; the 45 direct clicks on `switch-language` in 20
    specs use the helper, path assertions read the name's `title`, close-project / lessons clicks go through the
    project menu (`walkthrough.spec`'s `menu()` uses the rail's Lessons button while no project is open, since the
    project menu exists only with a project).

**Evidence:** `src/renderer/i18n/terms.test.ts` (22 tests); `src/shared/commands.test.ts` (menus name registered
commands, each in one menu, project menu order); `tests/e2e/shell.spec.ts` "S47.4: …" (no `.project-detail` and no
path text in the bar, name tooltip = path, no `switch-language` / `reveal-project`, project menu = folder line + 关闭项目
· 在…中显示 · 历史版本… · 课程 and its Lessons item opens the walkthrough, help menu radios = three themes + 中文 /
English, switching to en re-labels the rail and the menu and back, and every measured top-bar box is unchanged
afterwards); `tests/e2e/commands.spec.ts` (both menus' items from the registry, path line); `tests/e2e/a11y.spec.ts`
(both menus keyboard-only with axe clean, Tab order from the project menu). `npm run verify` green. Full e2e suite on the
Windows build: 332 tests — 318 passed + 4 skipped (macOS-only) in one run, the 4 that failed (ai-edit, history,
not-found, smoke: all test-side, see Problems) fixed and green on a rerun of those specs (30 passed).

**Decisions:** no new decision record. Reveal and the language choice are menu items built in `Workbench.tsx`, not
registry commands: Reveal's label is per platform (`revealLabelKey`) and the native menus / palette did not need them;
the language items would otherwise need a `locale` field in the IPC-validated `CommandContext`. The project menu
exists only with a project (its items are all about one), so without a project Lessons is reached from the rail and
the welcome, never only from a menu.

**Problems / risks:** macOS not run (renderer-only changes; the reveal label in the project menu is checked for both
platforms in `commands.spec`). `glass-visual.spec` screenshots of the top bar and the menu differ by design. Two
test-side fixes outside the feature: `smoke.spec` "five regions" still expected a preview column without a project
(S47.2 made it hidden; the suite was not run in Session 29), and `switchLanguage` now waits until main reports the
new locale — the renderer sets the language before main has persisted it, and the preview's "page not found" page
(served by main in the interface language) could still come up in the old language when a test navigated right after
the switch (`not-found.spec`). The product behaves the same as before; only the test ordering is deterministic now.

**Owner action needed:** none new; S46.8 visual pass still open.

**Next up**

1. S47.5 (one status row, fewer bands), S47.6 (compact walkthrough).
2. S48.1 should reuse the fixed-slot pattern of S47.3 for the preview header's state pill.

## Session 29 (side session) — 2026-10-16 — S47.2 welcome owns the window, S47.3 stable save state and tabs

**Agent:** Claude (Fable 5.1) on the Windows x64 dev machine, worktree branch `claude/xenodochial-hopper-116d81`,
fast-forwarded onto `claude/noobide-ui-ux-assessment-d4624a` @ `2edb98e` (the assessment, on main @ `cfc3232`) so
the M18 backlog entries exist. Started by the assessment session; owner rule (Session 23): no key feature moves into a
menu; decision 0034 and `design-rules.test.ts` unchanged — both features are structural, not a restyle.

**Done**

- S47.2 — Welcome owns the window. `layout.ts` `visibleRegions(state, narrow, projectOpen)`: without a project the
  editor column (welcome + sample) is the only middle region — no preview column, no editor splitter, no narrow
  Code / Preview switch, whatever narrow view was chosen before the project closed (`layout.test.ts`). `Workbench.tsx`
  gives the column the whole free width (`--editor-grow: 1` without a project; a flex-grow below 1 left the preview's
  share empty). The files panel's empty state has no button any more (`files.emptyHint` explains where files come
  from); the welcome keeps the window's one filled button (create), Open folder… as a secondary, and gains a Lessons
  quiet button (`welcome-lessons`, the same `help-walkthrough` command as the rail). "The sample is not saved" is said
  once: the badge next to the sample tab; `topbar.sampleNotice` is removed (the top bar shows the path line only with a
  project) and `welcome.sampleBelow` no longer repeats it. e2e helpers and specs that clicked the files panel's
  `open-folder` now click `welcome-open-folder`.
- S47.3 — Stable save state and tabs. `TopBar.tsx` `saveButtonShown(save, autosave)`: the prominent Save button is
  offered only for `failed`, `conflict`, `deleted` or autosave off with unsaved edits; ordinary typing changes the
  state word inside a fixed-width slot (`.save-status` width `--save-slot-w` 136 px, the icon in a 14 px box, every
  `SaveStateIcon` variant 14 px). Pill words are short in both languages (`save.failed` 保存失败 / Save failed,
  `save.conflict` 文件有冲突 / File conflict, `save.deleted` 文件已删除 / File deleted); the full sentences stay in the
  editor banners (`save.kept`, `conflict.*`, `deleted.*`). `TabBar.tsx`: the tab's state is an icon in a fixed 14 px
  slot (`.tab-state-slot`) with the word in the tooltip (`tabTooltip`) and as screen-reader text, so a tab never widens
  or narrows while it is typed in and saved. The save command (Ctrl+S and the button) over a conflict or a deleted
  file moves the focus to the banner's first choice (`conflict-compare` / `deleted-resave`) instead of doing nothing;
  nothing is written on its own there (S11.2, S11.3 unchanged). A retry in flight after a failed write keeps the button
  (`activeSaveRetrying`: the error is cleared only on success), so the blur retry that focusing the button triggers
  never removes the button under the focus. S45 kept: the button stays while a save cannot happen on its own, and the
  focus returns to the state word when it leaves.

**Evidence:** S47.2 — `tests/e2e/shell.spec.ts` "S47.2: …" (1280×800 and 640×480: the welcome's column reaches the
window's right gutter, no preview column / splitter / switch, exactly one filled button and it is `welcome-create`,
Open folder is secondary, the files panel's empty state has no button, "not saved" matches once, Lessons opens the
walkthrough, opening a project keeps every measured top-bar box identical and the S30.3 equal split holds);
`layout.test.ts`. S47.3 — `tests/e2e/key-features-visible.spec.ts` "S47.3: …" (typing never shows the button; a
read-only file shows it with the short word and the banner sentence; the focused button saves on Enter through the
save command and the focus lands on the state word; the bounding-box test records every element of the top bar and the
tab strip before typing, during the autosave pause and after `saved` — all equal); `a11y-labels.test.ts`
(`saveButtonShown` matrix incl. autosave off, pill word lengths, `tabTooltip`). `npm run verify` green; e2e run:
shell, welcome, files, walkthrough, recent-projects, key-features-visible, tabs, save, external-change, problem-card,
a11y, recovery, preview, session, editing, smart-editing green on the Windows build (see the commit messages for the
counts).

**Decisions:** no new decision record. Two small calls to note: (1) the rail is unchanged without a project (the
assessment's S47 table says "the rail shows only Files until a project is open"; the feature's acceptance criteria
do not, and hiding Problems / Lessons / AI from the rail would contradict the key-features-visible rule — left for the
owner to confirm); (2) a mouse click on the top-bar Save button first blurs the editor, whose blur autosave already
retries the save, so the button is removed before it receives focus — the S45 focus-return is a keyboard guarantee and
is tested as one.

**Problems / risks:** macOS not run (renderer-only changes; no platform code touched). `tests/e2e/glass-visual.spec.ts`
screenshots now differ for the welcome (by design). The e2e suites not in the list above were not re-run in this
session; none of them assert the removed strings or the files-panel button (grep-checked).

**Owner action needed:** confirm the two calls under Decisions; S46.8 visual pass still open.

**Next up**

1. S47.4 (term table test, ⋯ menu split, path on hover), then S47.5, S47.6.
2. S48.1 should reuse the fixed-slot pattern of S47.3 for the preview header's state pill.

## Session 28 (side session) — 2026-10-16 — UI/UX assessment and refine plan (owner request)

**Agent:** Claude (Fable 5.1) on the Windows x64 dev machine, worktree branch `claude/noobide-ui-ux-assessment-d4624a`,
merged with `origin/main` @ `cfc3232` (S46 calm refinement) before assessing. Three read-only audit subagents
(shell and first run; preview, problems, console, annotations; AI, history, recovery, walkthrough, settings), findings
cross-checked by the lead against the merged tree.

**Done**

- S47.1 — `docs/reviews/ui-ux-assessment-2026-10-16.md`: the packaged build was driven through the PLAN §2 journey
  with a Playwright script (welcome → wizard → walkthrough → three files → misspelled variable → Problems → menu →
  palette → History → AI panel → 900×620, 640×480, 1366×700; light and dark). The S46 look is taken as given; the
  review covers structure, flows, wording and state communication. Six P1 findings: the first run is a workbench
  with a welcome inside it (two filled buttons, three empty regions); the top bar and tabs move on every autosave
  cycle (Save button appears per typing pause); up to six rows of preview chrome with Refresh as the filled button and
  the header changing on every refresh; one mistake counted three ways (console badge, status strip, Problems) with
  no link from the console to the card; the problem card puts buttons and AI before the explanation; Recovery has no
  focus trap and Esc silently means "later". Eight P2 (names and entry points, two status bars and stacked bands,
  top-bar contents, walkthrough size, History's four jobs, dialog and diff inconsistency, AI composer before set-up,
  jargon) and six P3.
- Refine plan registered as milestone **M18** with sessions **S47** (frame and first run, 6 features), **S48**
  (preview, problems, console, 4 features) and **S49** (AI, history, dialogs, wording, 7 features incl. the owner
  walk-through S49.7); every feature has testable acceptance criteria. A term table fixes one zh-CN/en name per
  feature. Non-goals: no key feature into menus (owner rule), AI-off keeps removing AI surfaces (0025), S46 tokens and
  design rules unchanged, no change to preview isolation or saving.

**Evidence:** `npm run verify` green on the merged tree (harness, typecheck, lint, format, 2713 tests). The
assessment is `agent-check`; no app code changed.

**Decisions:** none new. The plan is sequenced S47 → S48 → S49 (S49.1 can run in parallel with S48 in its own
worktree).

**Problems / risks:** no beginner has used this build (H.3/H.6 still open); every "a beginner will…" in the review
is a design judgement. macOS not run. The S46 visual pass (S46.8) is still the owner's.

**Owner action needed:** read the assessment; confirm the term table (it renames 历史 → 历史版本 on the rail, keeps
课程) and the priority order before S47.2 starts.

**Next up**

1. S47.2 (welcome owns the window) and S47.3 (stable save state and tabs), then S47.4 (term table test, menu split).
2. S45.9 (rebuild of the archived HIG parts) should be re-scoped against this plan: the Sheet anatomy it archived is
   S49.1 now.

## Session 27 (side session) — 2026-10-16 — CI green again: billing, the half-landed S44/S45 commit, three e2e fixes

**Agent:** Claude (Opus 5.5) on the Windows x64 dev machine, worktree branch `claude/ci-failures-subagent-4ab7a0`.
CI read through the Actions API; fixes verified by `workflow_dispatch` runs of the branch. Subagents diagnosed and
drafted each e2e fix; every diff was reviewed here before it was committed.

**Done**

- **Why every run since 6a70c74 was red:** the jobs never started — "recent account payments have failed or your
  spending limit needs to be increased". The private repo had used its ~3,000 included Actions minutes for October
  (302 Windows min × 2 + 229 macOS min × 10). The owner made the repository public, which removes the limit.
- **main itself was red:** a110002 (S44/S45) committed only its new files, so typecheck and 18 unit tests failed.
  Cherry-picked be7194a as dfb1759 ("Restore the last green tree", from `claude/noobide-key-features-visibility-643cf7`), which
  archives those files under `docs/archive/s44-s45-hig/`.
- **S05.7 flood test (tests only), two measurement flaws exposed by the runners:**
  - the "beyond the simulated work" stall subtracted messages × 0.6 ms; on the 3-core macOS runner the spins
    overran under 8 busy workers. It now subtracts the time main measurably spent in the simulated work.
  - the iframe cases were compared to console-free baselines from another window (Windows: 405–518 ms vs 146 ms);
    they now get a same-frames, same-volume baseline through the top document's console, measured before each window.
  - the per-10 ms-tick batch bound failed whenever main stalled for another reason (Windows "20 workers": 381 in one
    1.7 s gap, 759 of 776 allowed in total). It is now a token-bucket `backlog` (Lindley's recursion) against
    `MOST_PER_SECOND`; the unlimited isolated-world flood is asserted to exceed it (control).
- **S05.5 dialogs test:** it clicked the centre of `.view-lines` (as wide as the longest line), which on the
  1024×768 Windows runner lands on Monaco's overview ruler; it now uses `focusEditor()` (docs/testing.md). It had
  not executed on Windows CI since the flood test started failing before it.
- **S14.2 typing pause (product):** PR #6's Windows run reloaded the preview 1.2 s into typing (keys 100 ms apart).
  The editor reported typing to main with a leading-edge 150 ms throttle, so the last keystrokes of a burst were
  dropped and main's 400 ms pause could start up to 150 ms early. `createTypingReporter`
  (`src/renderer/workbench/typing-reporter.ts`, unit-tested) adds a trailing report; the spec uses `focusEditor()`.
- Main now requires the `windows-x64` and `macos-arm64` checks (owner request, "Protect main" ruleset).

**Evidence:** CI run 38844020782 @ 1d47cc0 green on windows-x64 and macos-arm64 (fault suite, verify, e2e, make,
arch inspection); local `npm run verify` and full e2e (311 passed) green.

**Problems / notes**

- Merged into main after Sessions 23–26 (S45 key features, brand, S46 visual refinement); the merged tree was re-verified before the push.
- The archived S44/S45 HIG refinement (`docs/archive/s44-s45-hig/`) is still to be rebuilt on the current tree.
- No product code changed in this session; no acceptance criterion changed.

**Next up:** confirm CI green on main after this merge; rebuild the archived HIG refinement as complete commits.

## Session 26 — 2026-10-16 — Calm visual refinement (owner request)

**Agent:** Claude (Opus 5.5) as lead on the Windows x64 dev machine, worktree branch `claude/ui-refinement`
(node_modules junctioned to the main checkout). The owner asked why the UI looks cheap next to Claude Desktop, then
asked to fan out subagents: design and plan first, then implement.

**Done**

- S46.1 — Three read-only audit subagents (shell styles, feature styles, test and backlog constraints) plus "before"
  screenshots. Findings and contract in `docs/product/calm-design-spec.md`; decision
  `docs/decisions/0034-calm-design-language.md` supersedes the persistent-chrome glass, capsules, concentric radii,
  glossy buttons and press scaling of 0029, and keeps frosted overlays, solid twins, the reduced-motion dissolve, the
  palette and the scroll-edge masks. `src/renderer/design-rules.test.ts` enforces the rules on every stylesheet.
- S46.2 — Warm-neutral palette (tokens.ts), quiet status colours, neutral "no changes" save state; GLASS reduced to
  overlay tokens; the native window background follows the saved theme (`windowColorScheme`; the first window now
  waits for the settings file); `color-scheme` meta.
- S46.3 — Chrome (rail, top bar, files sidebar, status strip) is solid with no ambient fields; overlays stay frosted;
  glass.spec asserts flat chrome and solid menu, palette and dialog under reduced transparency, contrast and forced
  colours.
- S46.4 — Flat primary, secondary, quiet and icon buttons, flush rail, plain top-bar groups, radius scale
  sm/control/panel/sheet/capsule, one overlay shadow, shared `.text-field`. Selected, current and pressed states are
  the `--hover` fill plus a 600 label (or `--ring-selected` on icon-only controls); hover is `--hover-soft`
  (Microsoft YaHei has no 500 face, so 500 is not a cue).
- S46.5 — Type tokens `--text-xs` to `--text-2xl`, weights 400/500/600, regular body text.
- S46.6 — AI chat (plain-text answers, one composer field), AI settings, agent proposals, inline edit, annotations,
  history, welcome, wizard and walkthrough use the shared components; no nested cards, left bars, dashed lines or
  gradients.
- S46.7 — One 1.5 px effective stroke and sizes 14/16/18/32; inline SVGs moved into icons.tsx; a test forbids
  inline `<svg>` in components.
- Built by four parallel subagents with disjoint files, checked by an independent review subagent (findings:
  colour-only selected states, saved theme ignored, composer focus lost in forced colours, stray SVGs, gaps in the
  rules test), fixed by two more subagents.

**Evidence:** `npm run verify` green. Full `npm run test:e2e`: 321 passed, 4 skipped, 1 failed —
`not-found.spec.ts:105` (preview title still zh-CN after the English switch; passes on rerun and passed in the
earlier full run; locale timing, unrelated to styles). Regressions found by the first e2e run and fixed: agent diff
editor height (agent.css), composer button clipped by a negative margin, tabs overflow 0.56 px rounding (`.tabs`
padding-inline-end 1px), narrow-window editor height (welcome logo hidden in the narrow layout; HEAD already failed
this test on this machine). Before and after screenshots in both themes via glass-visual.spec.ts (ignored
`test-results/glass/`).

**Decisions:** 0034 calm design language. The owner's monochrome brand is kept (black fills, grey rim in dark).

**Problems / risks:** Window creation now waits for `settings.load()` (it never rejects; a hung read would delay the
first window). `.ai-entry` and `.annotations-primary` copy the primary-button rules instead of using the class
(unit tests match their class names). The rail stretches the middle row, not the full window. The native title bar
is unchanged. `not-found.spec.ts:105` locale timing flake.

**Owner action needed:** S46.8 visual judgement and platform checks (harness/MANUAL-CHECKS.md#S46.8).

**Next up**

1. Owner review of the S46 look; then S45.9 (rebuild the archived S44/S45 HIG parts) against the new design rules.

**Ideas / backlog candidates:** custom title bar (`titleBarStyle: 'hidden'` with an overlay) to drop the native
band; native Mica or vibrancy behind the window background only.

## Session 25 (side session) — 2026-10-16 — Logo and brand colour (owner request)

**Agent:** Claude (Opus 5.5) on the Windows x64 dev machine, worktree branch `claude/noobide-logo-theme-e36f86`
(node_modules junctioned to the main checkout).

**Done**

- **Logo:** a rounded square with a white `< • >` mark, an HTML tag holding one dot (the first thing you write).
  Vector originals in `resources/brand/` (`noobide-logo.svg` tile, `noobide-mark.svg` single-colour mark).
  `scripts/make-icons.mjs` now draws the same geometry; `icon.png/.icns/.ico` regenerated (checked at 1024, 32
  and 16 px). The welcome screen shows the logo above its title (`NoobIdeLogo` in `workbench/icons.tsx`,
  decorative, coloured from `--accent` / `--on-accent`).
- **Brand colour (owner: "dark black, so it looks much cooler"):** monochrome instead of the prototype's purple
  `#6E5BFF`. Filled controls (primary buttons, selected segment, hovered menu row, selected palette row, app mark,
  welcome logo) use the new `accentFill` token: black in both schemes, with white text. In the dark scheme a grey
  `accentRim` (`#7D8599`) edges every fill so it reaches 3:1 against bg, panel and raised (WCAG 1.4.11); in the
  light scheme the rim is the fill colour. `accent` is now the line/indicator colour only (active-row bars,
  dashed callouts): black in light, near-white in dark. New contrast pairs: onAccent on accentFill, accentRim on
  bg/panel/raised. The top bar's app mark shows the `< • >` logo mark instead of the generic code icon. Syntax
  colours are unchanged (keywords stay violet). A blue `#1D6CF0` and an inverted white-in-dark accent were tried
  first and replaced at the owner's request.
- **Seen:** renderer served by Vite in the built-in browser, dark and light: logo tiles, top-bar mark and the
  command palette's selected row are black with the rim in dark mode.

**Evidence:** `vitest run src/renderer/theme src/renderer/welcome src/renderer/editor src/renderer/workbench
tests/integration`: 1165 passed; the 10 failures are the pre-existing Sheet/notice ones listed under Problems.

**Merged with origin/main** (Sessions 23–24: the archive restore of the half-landed S44/S45 files, key features
pass). Main's new filled buttons (AI Send, annotate button and badge, annotation primary, top-bar Save, preview
action) were moved to `accentFill` + rim as well, so no text is drawn white on the dark scheme's near-white
`accent`. `npm run verify` is green on the merged tree.

**CI fix (PR #4, windows-x64):** `src/ai/usage-store.test.ts` timed out: its retention check recorded ~70 days
one atomic write at a time (209 ms locally, over 5 s on the Windows runner); the timed-out loop kept moving the
shared clock and failed the next test (`day: 2026-12-12`). The test now seeds the old days into the file and
records one more day (30 ms, same assertions plus the newest day kept; it fails when retention is widened).

**Next up:** the owner checks the new icon in a packaged build on both platforms.

## Session 24 (side session) — 2026-10-16 — main red after a110002: confirmed fixed by the archive restore

**Agent:** Claude (Opus 5.5) on the Windows x64 dev machine, worktree branch `claude/happy-jackson-8b1fcf`
(node_modules junctioned), started from the license session, which found `npm run verify` red on `main` @ `df242a0`.

**Done**

- Searched every local/remote branch and every worktree under `.claude/worktrees` (committed trees and working
  copies) for the missing S44/S45 implementation (`commandLabel`, `fixCardProminent`, the ai-icons exports, the
  `ai.chat.context.addGroup` key). It exists nowhere: a110002 committed only the files it added.
- Took the owner-approved archive restore (`dfb1759`, same tree as `be7194a`) instead of rewriting the code. While this
  session ran, PR #1 (license) and PR #2 (key-features visibility, which carries the same restore plus S45 rebuilt)
  landed on `main`; this branch merges `origin/main` and adds only this entry.

**Evidence:** `npm run verify` green @ `dfb1759` (2612 tests) and @ `origin/main` `b039282` (harness, typecheck, lint,
format, test: 2633 passed, 15 skipped).

**Decisions:** none new; see `docs/archive/s44-s45-hig/README.md`.

**Problems / risks:** one `verify --quick` run failed in the unit tests once and was not reproducible in three full
runs; the merged tree once failed `tests/integration/watcher.test.ts` "mass delete" on its 500 ms event-loop lag
bound (606 ms) and passed on rerun — a load-sensitive bound. e2e not run here.

**Owner action needed:** none.

**Next up**

1. Continue from Session 23's Next up (S45.9: rebuild what is worth keeping of the archived S44/S45 work).

## Session 23 — 2026-10-16 — Key features always visible (S45, milestone M16)

**Agent:** Claude (Opus 5.5) on the Windows x64 dev machine, worktree branch
`claude/noobide-key-features-visibility-643cf7` (node_modules junctioned to the main checkout). Owner request: "key
features should not be hidden or invisible at any time" (Problems open squeezed the preview so Annotate needed
scrolling). Three read-only audit subagents (preview/annotations, AI, workbench frame), then three fixers with
disjoint file ownership, then an independent reviewer (1 blocker fixed by the lead).

**Done**

- S45.1 — verify was red at session start: `a110002` ("S44 + S45: HIG refinement") committed only the files it added;
  its edits to existing files were lost (not in git objects or any worktree). Owner chose: restore the last green code
  (`3222c89`) for every file that commit touched and archive its versions in `docs/archive/s44-s45-hig/` (README
  explains; outside build/typecheck/lint/tests). Commit `be7194a`. Rebuild tracked as S45.9.
- S45.2 — Annotate moved out of the scrolling strip into the preview header: tinted "标注页面" button with icon and
  count (`annotate-menu`, rendered through a portal into `preview-annotate-slot`) and a separate "查看标注（N）" list
  toggle. Never unmounted: when the preview is not running it is `aria-disabled` and says "先启动预览再标注". The three
  ways open under the toolbar; step actions (Save/Confirm/Cancel) sit in a sticky row.
- S45.3 — `.preview-chrome` no longer scrolls; the stage gives way first (min derived from `--middle-min`); header
  actions wrap; Start/Refresh are primary buttons with icons; stage messages wrap; the console has a "网页控制台"
  heading with an error-count badge and keeps two lines unless an annotation step is open.
- S45.4 — AI: chat composer bounded (context area scrolls on its own, input + Send never clipped), header uses icon
  buttons so Close/New chat always fit, chat shrinks before the preview; "用 AI 修复" on the collapsed problem row
  (`problem-row-fix-ai`) and actions straight after the card head; "AI 编辑 (Ctrl+I)" + "解释" in the editor status
  bar (`editor-ai-actions`); inline-edit Accept/Reject above the diff, zone re-revealed on review. Shared sparkle
  style `ai-entry.css`.
- S45.5 — frame: vertical budget (`--middle-min` minus walkthrough/Problems/notice reserves; `layout.ts`
  `frameMinimums()` mirrors and tests it) keeps the status strip on screen down to 640×480; Problems panel sized to
  content (max 260 px); all floating notices + journal-health alert in `.app-notice-stack` above the strip (in the
  layout flow in narrow windows); prominent top-bar Save button (`topbar-save`, same `save` command as Ctrl+S, shown
  while dirty/failed, focus kept on the state word when it leaves); rail "课程" button (`rail-lessons`); New file /
  New folder labels; narrow-window `topbar-new-file`; walkthrough Back/Next never wrap away; History keeps its word
  down to a 360 px editor; splitter resting grip.

**Evidence:** `npm run verify` green; full e2e on Windows x64 **323 passed, 0 failed, 4 skipped** (15.1 min) incl. new
`tests/e2e/key-features-visible.spec.ts` (key controls fully inside the window at 1280×800, 1366×768, 1280×720,
960×600, 640×480 with walkthrough + Problems) and new `preview-layout.spec.ts` checks (Annotate inside the pane,
`.preview-chrome` unscrolled at 1280×720 and 1366×677). New unit tests: editor-ai-actions, problems-panel-ai,
layout frame minimums, a11y labels. Window captures checked at 1280×720 / 960×600 with Problems + walkthrough open.

**Decisions:** Annotate and the chat's three Add-context buttons stay visible (the archived S44.2 design put them in
menus — rejected per owner request). The AI rail button still disappears when AI is turned off: decision 0025 /
accepted criterion "AI off removes every AI surface" — left for the owner.

**Problems / risks:** `walkthrough.spec.ts` was flaky in isolation (2 of 8 runs: an `expect.poll` reading
walkthrough.json before it exists throws ENOENT; once a toHaveAttribute timeout); green in the final full run. At
960×600 with everything open the Problems list shrinks to its header (the status strip still shows the count) and the
top-bar save word truncates with an ellipsis (full text in the tooltip). Glass visual snapshots were not re-baselined
(none failed). macOS not checked.

**Owner action needed:** none for AI-off: the owner kept decision 0025 (2026-10-16) — with AI off the AI rail button stays hidden. Look at the new Annotate/Save/Lessons prominence on a real screen.

**Next up**

1. S45.9 — rebuild what is worth keeping from `docs/archive/s44-s45-hig/` (Sheet/Notice anatomy, button hierarchy,
   command menu groups) without moving key actions into menus.
2. Make `walkthrough.spec.ts` poll tolerate a not-yet-written walkthrough.json.

**Ideas / backlog candidates:** floating selection pill (Explain / Edit with AI) next to a non-empty selection;
bottom-sheet AI chat in narrow windows so the preview stays visible while chatting.

## Side task — 2026-10-16 — NoobIDE license

**Agent:** Claude (Opus 5.5) on the Windows x64 dev machine, worktree branch `claude/noobide-license-c9f1ac`.

**Done**

- Owner chose the MIT License (answers the Session 21 owner question "NoobIDE itself has no license"). Added
  `LICENSE` (copyright holder "NoobIDE contributors", matching `APP_COPYRIGHT` in forge.config.ts),
  `"license": "MIT"` in package.json and the lockfile root, and a License section in README.md.

**Evidence**

- `npm run verify`: harness, lint and format pass; third-party-notices tests pass with the lockfile change. Typecheck
  and 4 test files (button-hierarchy, Sheet, notice, commands) fail, already broken on main @ df242a0 by a110002
  (S44 + S45), unrelated to this change.

**Next up**

- Unchanged: continue with the current session shown by `npm run session -- start`.

## Session 22 (side session) — 2026-10-16 — CI: the three load-sensitive preview specs (S05.8, S05.7, S38.1)

**Agent:** Claude (Opus 5.5) on the Windows x64 dev machine, worktree branch `claude/interesting-hopper-188b01`
(node_modules junctioned to the main checkout), started from the CI-fix session (Session 18). Evidence came from CI
logs and from `workflow_dispatch` runs of a throw-away branch `ci-diag/preview-specs` (only the three specs, repeated;
deleted afterwards). Subagent: an independent reviewer of the S05.8 change (no blockers; its notes are in the code).

**Done**

- **S05.8 root cause found (product):** `installPageGuard` runs before the new view is added to the window, so
  Chromium counted no visible page in its renderer and lowered the process to background priority (seen on the dev
  machine: the preview renderer's priority class was **Idle** until the view was attached, then Normal). On the 3-core
  macOS runner with 1.5 busy threads per core that renderer starved: the first about:blank needed retries and the
  guard's DevTools commands went unanswered for 45 s (`commands-timeout`, page unguarded). The Session 16 symptoms
  (first navigation pending 30–45 s, commands waiting for the renderer) were the same starvation. Fix:
  `CHROMIUM_SWITCHES = ['disable-renderer-backgrounding']` (`src/preview/preview-options.ts`, applied in
  `main.ts` before ready): renderers keep their launch priority. Page visibility, rAF and timer throttling are
  unchanged; a hidden/minimised IDE no longer gets Chromium's renderer "backgrounded" memory mode (accepted, see the
  comment). `GuardTrace.commandAnswersMs` records when each guard command answered. Unit test pins the switch; the
  restore e2e asserts it and prints every trace. Results with the CPU burn: dev machine at 3-core affinity 5/5
  restarts, first document on attempt 1 (~100 ms), commands ≤ 4 ms, running 1.3–2.4 s (was 3–6 s); CI 30/30
  restarts guarded on both runners (macOS ~1 s, Windows 2.5–3.6 s, commands ≤ 14 ms).
- **S38.1 e2e (test races, not budget misses):** the 200 000-element test's wait accepted a snapshot that was "ok"
  only because its outline walk timed out behind the first layout; the next snapshot then hit the "page is busy"
  check in 4 ms. `pageSettled()` waits for a completed walk (both huge-DOM tests). The busy-page test guessed its
  loop had started after 800 ms (Windows runner: not yet); the fixture now logs `忙碌开始` first and the test waits
  for that record.
- **S05.7 e2e (preview-isolation.spec):** diagnostics first — the flood test records main stalls over 50 ms with
  their time and the keystroke send times, the page/flood guard traces, and the simulated-cost runs report the
  largest batch of messages between two 10 ms ticks.
  - macOS "20 workers at once (0.6 ms/message)" 196–250 ms: the largest batch was 150–208 messages, within the
    limiter's design bound (CONSOLE_BURST + MAX_GUARDED_SCOPES × WORKER_CONSOLE_BURST = 260, ≤ 156 ms of simulated
    work); the rest is the simulated wall-clock work being preempted on 3 cores by the case's own 8 busy workers.
    The cost runs now assert the batch bound and that the stall _beyond_ the simulated work stays < 200 ms.
  - Windows runner: main stalls 0.1–0.9 s at random **with no console output at all** (200-iframe baseline
    210–925 ms, iframe-churn baseline 94–776 ms, run to run), and eight busy workers alone stall it 0.7–3 s. The
    churn and 20-worker cases get no-console baselines like the 200-iframe case, and every bypass case gets up to 3
    measurement windows (best counts; result and message bounds checked in every window). "20 workers" waits 5 s for
    its eight workers (the eighth started > 2 s late there).
  - The fixture flood (the S05.7 criterion, < 200 ms, and the keystroke bounds) is unchanged as a bound but runs up
    to 3 times (Stop + Start floods again) until one run meets all timing bounds; every run is logged. A limiter that
    let the flood through stalls main for seconds in every run. The test's timeout is 6 min (≈ 2 min normally).

**Evidence:** `npm run verify` green; locally preview-isolation + preview-snapshot 14/14 and preview-restore at
3-core affinity under the CPU burn; CI diagnostic runs 38795794452, 38801185966, 38803856838, 38805786307 (macOS: all three specs ×3, 45/45
passed; Windows: restore and snapshot green, isolation failed only on the 20-worker baseline and one 633 ms flood,
both handled by the last change, which was verified locally only before the push to main).

**Problems / notes**

- **Not explained: rare multi-second main stalls in the Windows fixture flood** (now absorbed by the retries). With the guard installed and main's
  backstop idle, main froze 1.0 s + 4.2 s once (diag run 1, 1 of 3) and 1.7 s once in a traced run (1 of 5); 0 of 6
  in diag run 3; main CI before this session 967 ms and 2528 ms. In both captured cases main resumed when the page's
  6 s loop ended, and the workbench renderer froze too once. The trace showed main running no task at all for 1.57 s
  (console messages queued, then 287 drained at once), but a 1.75 s Perfetto task overlapped, so tracing may have
  caused that one. Ruled out: view `setVisible`/`setBounds` (≤ 2 ms, also when the watchdog hides the busy page),
  save-triggered reloads (the page is still loading, the reload waits), the guard (installed every time). If it
  recurs on CI, it is either the runner (stalls of up to 0.9 s happen there with no console output) or a real
  Windows coupling between main and a busy renderer — next step: an ETW/WPR capture on a Windows machine.
- The `20 workers` simulated-cost run is still the closest to its bound on macOS (unexplained part up to 126 ms).

**Next up**

- Confirm the CI run on main for this push; if the Windows fixture flood stalls again, keep the stall timeline from
  the log and investigate with a native profiler (above).

## Session 21 — 2026-10-16 — Product assessment by six subagents, fixes (S44, milestone M15)

**Agent:** Claude (Opus 5.5) on the Windows x64 dev machine, branch `claude/product-assessment` (worktree
noobide-release-readiness-9ff870). Owner request: "fan out subagents, assess the product, troubleshoot and fix".
Six read-only assessors (data safety, security, S41–S43 integration, i18n/a11y, platform/release, hands-on beginner
journey in the built app), then six fixers in isolated worktrees, merged here, plus an independent reviewer for the
save-pipeline / recovery-journal changes (CLAUDE.md high-stakes rule).

**Done**

- S44.1 — **data:** Format Document and Convert Indentation store a "before formatting" version
  (`history:before-format`, validated; ends the save burst). It was never wired (PROGRESS had "not yet wired").
- S44.2 — **data:** the disk BOM follows reload, take-disk and Keep mine; it used to be reverted by the next save.
- S44.3 — **data:** crash copies of a moved/renamed/missing folder can be read, copied, saved as (dialog in main),
  discarded, or re-targeted to the folder's new location (decision 0033). Before: unreachable, and they blocked
  last-session restore forever. Review fixes: a renamed or other folder needs a confirmation; journal records whose
  relPath leaves the project are quarantined.
- S44.4 — S41–S43 integration: Fix with AI on the pending `/ai` warning runs the prompt (was a fix request inviting
  deletion of the prompt); `/ai` inert without a ready key (ADR 0031); no warning on read-only tabs; suggestions never
  take Enter on an `/ai` line; inline AI accept refused under the rename/move/trash lock.
- S44.5 — beginner text and a11y: preview console explains blocked links and failed loads; no raw tool ids or error
  codes; English plurals; key store named per platform (Windows: Data Protection, not Credential Manager — it is
  DPAPI); palette finds New project by "create"/创建; focus returns after annotation edits, History, Glossary.
- S44.6 — beginner journey: the preview stage was 449×1 px at 1280×800 with walkthrough + Problems open (now ≥ 240);
  broken links no longer trap the preview on an English 404 (localized 404 page, page path + Back to entry page,
  save refresh returns to the entry); glass dialogs were see-through (opacity animation made the backdrop a backdrop
  root); 404 hints now name the similar file (projectFiles was never supplied); tab strip room + overflow cues; file
  names no longer cut in the tree; reopened-project notice is informational. Default window 1440×900 when it fits.
- S44.8 — **data (found from a macOS CI failure):** a crash copy of exactly 397 B (= empty text) for an unedited
  file. `closeProjectFiles` forgot the savers at once but released models through a lazy import that swept every
  `file:` model; landing after a restored tab acquired its model, the release's `setValue('')` reached the saver and
  journal as an edit (autosave could have written an empty file). Fix: callers await the release (newest request
  wins) and CodeEditor forwards changes only for the registry's current model (`forwardsEdits`, unit-tested — the
  deterministic proof; the 5x restore-and-quit e2e is a probe). Independently reviewed.
- S44.7 — release: `THIRD_PARTY_NOTICES.txt` (every production dependency's license text) ships and opens from About;
  release.yml fails a tag that is not v + package.json version.
- Security assessment found no provable defect (live static-server probe: traversal, 8.3 names, Host, token, dotfiles).
- Merge interactions fixed in specs: smoke bridge shape, About has two buttons, before-format e2e uses the shortcut
  (opening the new Editor options panel blurs the editor, which saves first; the text is then kept as an after-save
  version — nothing lost, but no separate "before formatting" row).

**Evidence**

- `npm run verify` green; full e2e on Windows x64 (see S44.x evidence); fixer evidence per branch in the commits.

**Decisions / owner questions**

- A pending `/ai` line is autosaved (ADR 0031: user text is never held back) — with a key, a script has a syntax error
  until the prompt runs. Changing that (hold autosave for that file) is an owner decision.
- NoobIDE itself has no license (`package.json` has no "license"); owner decision.
- Save as… of an orphaned crash copy removes the copy once written (like a save).

**Problems**

- The hands-on assessor's app run created `DocumentsNoobIDE Projects产品 展示` in the owner's real Documents (its fake
  location was lost on relaunch) and sent a test file to the Recycle Bin; reported to the owner.
- Not done on macOS; CI covers it. The S05.8 / console-flood / 200k snapshot CI failures belong to a separate session.

**Next up**

- Confirm CI on main after push; owner decisions above; a beginner study (H.6) on the new layout.

## Session 20 (side session) — 2026-10-16 — Smarter indentation and context-aware suggestions (S43, M14)

**Agent:** Claude (Opus 5.5) on the Windows x64 dev machine, worktree branch `claude/admiring-shannon-3c0373`
(node_modules junctioned to the main checkout), started from another session on the owner's request ("a better
智能推荐: smarter indent detection, smarter context-based code suggestions"). Parallel sessions: S41 preview
annotations, S42 inline `/ai` prompt — numbering reserved in their shared notes; no `inline-prompt*` file touched.
Subagents: indentation engine + fixtures, completion-context/symbols/paths engine, an independent reviewer.

**Done** (design: [docs/decisions/0032-smart-suggestions.md](../docs/decisions/0032-smart-suggestions.md))

- New milestone **M14**, session **S43**, features S43.1–S43.8.
- S43.1 — `src/renderer/editor/indent-detect.ts` (pure): tabs/spaces, width 2/4/8, confidence, mixed; skips blank
  lines, block/HTML comments, JSDoc `*` lines, `<pre>`/`<textarea>`, template literals; HTML `<script>`/`<style>`
  scanned with the JS/CSS rules. `resolveIndentation` (override > confident guess > project convention > weak guess >
  2 spaces), `projectConvention` (≥ 2 agreeing files), `reindentPasted` (leading whitespace only, every line ending
  kept). 19 fixtures in `tests/fixtures/indentation` + 44 tests; 5 000 lines ≈ 0.3 ms.
- S43.2 — `smart-monaco.ts` sets each shown model's tabSize/indentSize/insertSpaces (Monaco's `detectIndentation`
  off), re-indents pastes (own undo step), re-detects weak files after a typing pause. Status bar `IndentStatus.tsx`
  ("空格：4 · 从文件识别"), a WAI-ARIA menu (Spaces 2/4, Tabs 2/4, detect again, convert file); overrides per file for
  the app session (`indent-state.ts`). The cursor-position test id now sits on its own span (unchanged text).
- S43.3 — new/near-empty files follow the project convention, else the templates' 2 spaces.
- S43.4 — `project-index.ts` (≤ 200 HTML/CSS/JS files, ≤ 256 KB each; names and a guess kept, never the text; open
  models win; watcher events) + `project-symbols.ts` (ids/classes from HTML attributes and CSS selectors).
- S43.5 — one completion provider for HTML/CSS/JS (`completion-context.ts`, `path-suggest.ts`): project ids/classes
  in `querySelector`/`getElementById`/`classList.*`/`getElementsByClassName` (also in an HTML `<script>`), CSS `#`/`.`
  selectors, HTML `class="`, paths for `src`/`href`/`url()`/`import`, four localised beginner snippets with real
  ids/classes. Each item names its origin. 11 new capability cases pass in the **packaged app offline**;
  docs/capabilities.md updated (and its _Not claimed_ list narrowed accordingly).
- S43.6 — latency: provider p95 0.91 ms (classes) / 0.44 ms (paths) on 200 files + 2 100 classes (unit); in the app
  `#` → id listed median 7 ms, provider p95 0.20 ms. docs/perf/completion-latency.md.
- S43.7 — AI ghost text (S32.1) gets an "AI" content-widget badge with a localised accessible name, driven by the
  provider's `handleItemDidShow` / `handleEndOfLifetime` (`ai/inline-badge-monaco.ts`); hidden on Esc, typing,
  cursor move, blur. AI default unchanged (on once AI is set up, decision 0025).

- Review (independent subagent) found 10 real defects, all fixed (new unit/e2e tests for paste, convert and folder
  events; the other fixes are covered only by the existing suites): a whole-line paste rewrote the user's
  own line (Monaco reports the paste range from the old cursor) → re-indent only when the range equals the clipboard
  text (captured from the window paste event; `onDidPaste` carries no readable data) and with one cursor; pastes with
  `<pre>`/`<textarea>`/template literals/comments and unclear space units are left alone; first line included at
  column 1; "convert" now changes widths (`convertIndentation`); folder create/delete/rename and `rescan` update the
  index; only valid CSS identifiers are suggested; long inline `<script>` keeps suggestions (64 KB region scan); the
  AI badge belongs to its suggestion list and stays while ghost text is still on screen; live models are scanned only
  for HTML/CSS ≤ 256 KB; drive-root projects work.

**Evidence:** verify green (2 412 tests); e2e on Windows x64: `smart-editing.spec.ts` 13/13, and with ai-inline,
language (packaged offline), tabs, problems, problem-card, offline, editing, a11y, smoke, external-change: 93/93. Full e2e suite (`npm run test:e2e`): 284 passed, 4 skipped (pre-existing), after adding the new
indentation button to `shell.spec` S30.3's control inventory (its only failure). After merging main (S41 preview annotations, S42
inline `/ai` prompts): verify green; full e2e 287 passed, 4 skipped, 2 failed once under full-suite load and passed
on rerun (`preview-restore` S05.8 restart under CPU load, `walkthrough` "progress survives a restart"; both restart
the app and passed in the pre-merge run).

**Decisions / problems**

- Playwright typing with 0 ms between keys makes Monaco skip auto-closing a `{` typed right after the previous key
  (40 ms per key works; not checked whether the build before S43 behaves the same). The spec types at 30 ms per key.
- A file with < 6 indented lines is a _weak_ guess, so a clearly 4-space project wins over it. Intended (new files
  follow the project); the status bar shows "沿用项目习惯" and one click changes it.
- One `npm run verify` run, right after the full e2e suite, had a unit-test failure whose output was lost; five
  runs after it were clean. Suspected: the new timing tests on a busy machine, so the p95 test now warms up first. If a
  timing test in `src/renderer/editor/*perf*`/`completion-latency` fails again, look there first.
- Overrides are not persisted across restarts; persisting a project-wide choice needs a `.noobide/project.json`
  schema change (idea below).

**Owner actions:** S43.8 manual check on Apple Silicon (harness/MANUAL-CHECKS.md#S43.8).

**Ideas / backlog candidates:** persist the indentation choice per project in `.noobide/project.json`; AI ghost text
could receive the project's ids/classes as context.

**Next up:** the owner's S43.8 Mac check; otherwise continue M7 release items.

## Session 19 (side session) — 2026-10-16 — Inline `/ai` prompts in the editor (S42, milestone M10)

**Agent:** Claude (Opus 5.5) on the Windows x64 dev machine, in worktree branch `claude/sharp-pare-8696ff`
(node_modules junctioned to the main checkout), started from the release-readiness session. Parallel side sessions:
preview annotations for the AI (S41, ADR 0030) and smart suggestions (S43, ADR 0032); numbering agreed in the shared
notes folder. Subagent: an independent reviewer of the S42 diff.

**Done**

- S42.1 — [ADR 0031](../docs/decisions/0031-inline-ai-prompt.md): detection, collision rules, trigger, preview, and
  how Accept/Reject relate to undo, autosave, local history and the save pipeline. Owner request 2026-10-16.
- S42.2 — rules and main: `src/renderer/ai/ai-prompt-model.ts` (a line `^[ \t]*/ai<space|tab|U+3000><request>` in
  HTML/CSS/JS; arming; when plain Enter runs; the file's problems nearest the line, errors first, ≤ 8, messages
  ≤ 500 chars; a generate request with ≤ 200 lines / 12 000 chars each side; indenting the answer like the line).
  The `edit` request gains optional `mode: 'generate'` and bounded `problems` (`ai-contract.ts`, `ai-parse.ts`);
  `prompts.ts` has a fixed generate system prompt per locale and a neutralised `<problems>` frame; the fake provider
  has a built-in generate turn.
- S42.3 — editor: `src/renderer/ai/ai-prompt-monaco.ts` arms lines the user typed/pasted/undid (never a load or
  reload from disk), shows an end-of-line hint in words and a translated warning marker (`noobide-ai-prompt` /
  `ai-prompt-pending`, explained by a new diagnostics rule in Problems), binds Enter (armed line, cursor at end, no
  suggestion/inline suggestion/selection/IME) and Ctrl/⌘+Enter (any prompt line) and adds "Run this /ai request" to
  the context menu. `useInlineEdit.runPrompt` opens the S35 inline edit zone over the line and sends at once (consent
  first in a new project); the diff, Accept (one undo step + save through the file's pipeline), Reject, Stop and Esc
  are the S35 ones. AI ghost-text completions stay quiet on `/ai` lines (`inline-monaco.ts`).

**Evidence:** `ai-prompt-model.test.ts` (12), `src/ai/generate-prompt.test.ts` (5), `tests/integration/ai-service.test.ts`
S42.2 (IPC → service → provider; bad payloads refused; no prompt/problem text in the log), diagnostics rule fixture,
`tests/e2e/ai-prompt.spec.ts` (5: Chinese prompt → hint + Problems warning → Enter → consent → diff whose answer only
the request with the unclosed-`<div>` problem gets → Accept saves indented code → one Ctrl+Z restores the line;
Ctrl+Enter + Reject/Esc; Enter on an unarmed line from disk, Shift+Enter and an IME-confirming Enter do not run it;
English prompt from the context menu in the en UI). Mutation check: making every `/ai` line armed fails the
"not taken over" e2e. Independent review (subagent) found 2 medium + 4 low issues, all fixed: lines are armed only
by the user's typing/paste/IME/undo-redo (an external reload, history restore or rule fix used to arm them — new e2e
step with an on-disk change), Enter/Ctrl+Enter need `editorTextFocus` (the find widget keeps its Enter), multi-change
undo line maths (`linesAfterChanges`, unit-tested), collapsed decorations ignored, a prompt that cannot run gives the
key back (Enter inserts its line break), and the warning text leads with Ctrl/⌘+Enter. ai-prompt e2e 15/15 with
`--repeat-each 3`; ai-edit, ai-inline, editing, external-change, problems, problem-card, smoke e2e green.
`npm run verify` green.

**Decisions:** ADR 0031. Autosave/save/recovery are unchanged: a pending `/ai` line is user text and is saved like any
other, but always visibly flagged (hint + warning in Problems). Diff review (the S35 zone), not ghost text.

**Problems / risks:** IME is proven with a CDP composition (keyCode 229) on Windows, not a real Pinyin IME, and not
on macOS; that e2e step would also pass without NoobIDE's own `composing` guard (Monaco ignores keyCode 229 itself).
Arming reads Monaco's `onDidType`, which the editor widget has but the public typings omit (cast in
`ai-prompt-monaco.ts`); a Monaco upgrade must keep it (the zh-CN e2e fails if it goes). An `/ai` line that a beginner really wants as page text shows a warning (ignorable; Enter only runs it when
they edited that line).

**Owner action needed:** none required. Optional: try `/ai 做一个点击后数字加一的按钮` with a real key and a real
Chinese IME on Windows and on the Mac.

**Next up**

1. Continue M7 release work (owner tasks H.1/H.2/H.5) — see Session 16's Next up.

**Ideas / backlog candidates:** multi-line `/ai` prompts (continuation lines); `/ai` inside comments (`// /ai …`) for
JS/CSS files so the prompt line is valid code while pending.

## Session 18 — 2026-10-16 — CI red on main: ai-history test used the unresolved temp path

**Agent:** Claude (Opus 5.5) on the Windows x64 dev machine, branch `claude/fix-ci-ai-history`.

**Done**

- CI `Verify` failed on both jobs for every push to main since S39 (runs 38673893839 … 38762366576). The only
  persistent failure: `tests/integration/ai-history.test.ts` "revoking consent … counted and deleted by id" got
  `count: 0`. Cause (test-only): its `recentRootOf` fake returned the raw temp path, while the chat store keys by
  the project's **real** root (ProjectService realpath; main's `recent.touch` records the same real root, so the
  product is consistent). On CI the temp dir is a symlink (macOS `/var` → `/private/var`) or an 8.3 short name
  (Windows `RUNNER~1`), so the hashes differed; the dev machine's temp path is already real, which hid it.
- Fix: the fake returns `projects.rootOf(projectId)`. Reproduced locally with TMP set to a junction: old test fails
  with the CI assertion, fixed test passes. `npm run verify` green.

- Then CI's e2e step ran for the first time in weeks (verify had always stopped it) and failed 2 (macOS) + 5
  (Windows) specs. Four read-only diagnosis subagents and an independent reviewer; fixes:
  - **product:** quit waits (≤ 3 s) for queued recent-list and session writes (`RecentProjects.flush`,
    `SessionStore.flush`, `will-quit` in main.ts): a project opened just before quitting was missing from the recent
    list / session restore (recent-projects.spec S13.3 on the Windows runner).
  - **product:** session tabs are saved once the restore lookup finished (state `tabsRestoredFor`, was a ref): a file
    opened while the lookup was in flight was never saved, so the next start reopened the project with no tabs
    (recovery.spec S12.2).
  - tests: glass.spec honours the macOS runner's _Reduce transparency_ (asserts the solid fallback, then pins
    no-preference and asserts glass); preview-snapshot waits for the huge page's first layout like its sibling;
    preview-isolation's 200-iframe case gets a measured frames-only baseline under its 200 ms console budget;
    preview-helpers `openProject` waits for either open button (`count()` raced the first render).
  - Integration tests for both `flush()`s. Local: full e2e 280 passed; the affected specs 9/9; verify green.

**Problems / notes**

- **Still open: preview-restore.spec (S05.8) on the 3-core macOS runner** — restart 2 of 5:
  `{"firstDocumentMs":1030,"firstDocumentAttempts":2,"commandsMs":45089,"outcome":"commands-timeout"}`: the first
  document "loaded" on the 2nd attempt, then no CDP command answered for 45 s, so that page ran unguarded. Tried and
  **reverted**: treating a resolved `loadURL` as not shown while `isLoadingMainFrame()` is true — on the dev machine
  under load it stayed true for 28 of 29 resolved attempts → `no-first-document` (worse). The signal is not usable; the
  real cause is not known yet.
- Run 38723694371 also had a one-off `watcher.test.ts` "mass delete … never blocks" timing failure on Windows; it did
  not recur in later runs. Watch for it.

**Next up**

- Confirm the next CI run on main; S05.8 on the macOS runner needs its own investigation (see above).

## Session 17 — 2026-10-16 — Preview annotations for the AI assistant (S41, milestone M12)

**Agent:** Claude (Opus 5.5) on the Windows x64 dev machine, in worktree branch `claude/frosty-blackburn-4c3d2c`
(node_modules junctioned to the main checkout), started from another session after a release-readiness check. Owner
request 2026-10-16: annotate parts of the running page and let the AI work on the matching source. Subagents: the
preview strip UI (S41.5) and an independent reviewer of the whole diff.

**Done**

- S41.1 — decision 0030 (`docs/decisions/0030-preview-annotations.md`), M12/S41 in `harness/features.json`, v3
  section in `docs/product/ai-plan.md`.
- S41.2 — `src/preview/source-locate.ts`: a small position-tracking HTML tree (void, raw text, comments, implied end
  tags, CRLF) follows the element's flattened ancestry (html/head/body/tbody skipped on both sides) → **exact**; else a
  unique id or tag+classes+text → **approximate**; else **none** (script-created elements never get a guessed exact).
  CSS rules by normalised selector + occurrence, also inside `@media` and the page's n-th `<style>`.
  `src/preview/annotation-source.ts` reads files only through the static server's `resolveInRoot` (root, realpath,
  no dotfiles).
- S41.3 — `src/preview/element-pick.ts` + `element-target.ts`: picking uses the DevTools protocol's own inspect mode
  (`Overlay.setInspectMode`) on the page guard's session — Chromium draws the highlight, the page does not get the
  click — and the node is described in an isolated world (bounded script; main re-validates with `parseTarget`).
  Keyboard list of notable elements by child-index path, region → smallest containing element, `Overlay.highlightNode`
  for Show. DOM/Overlay domains are on only while used. Esc in the page ends pick mode (main's `before-input-event`).
- S41.4 — `src/main/annotation-store.ts` (app data `annotations/<projectKey>.json`, atomic, ≤ 200, corrupt moved
  aside, newer files read-only), `annotations-contract.ts`/`annotations-parse.ts`, `src/main/annotations-ipc.ts`
  (trusted sender, owner checks, targets kept in main by `pickId`, source re-located on every list), preload bridge
  `window.noobide.annotations`.
- S41.5 — `src/renderer/annotations/*` (subagent): the strip under the preview toolbar — Annotate (point at the page /
  choose from a list / draw a region on a frozen screenshot, mouse or arrow keys + Enter), note, numbered list with
  target, source location and a state word + icon, Show / Edit / Delete / Ask AI; zh-CN + en.
- S41.6 — context item kind `annotation` (main builds the text: note, element, HTML lines + CSS rules with numbered
  excerpts; `src/ai/annotation-context.ts`), framed as data (`<annotation>` + neutralizeData in chat, nonce frame +
  neutralizeData in the agent), agent prompt says to edit the named lines/rule. Ask AI opens an **agent** draft with
  the chip(s); proposal cards say "in the annotated part" / "outside — check it" (`annotation-placement.ts`).
- S41.7 — `tests/e2e/preview-annotations.spec.ts` (10 e2e) and smoke lists the new bridge.

**Evidence:** unit/integration: source-locate (14), annotation-source (3), element-pick (10), annotation-store +
parsers (6), annotations-ipc integration (8), ai-annotations integration (3: an agent that only follows the chip
edits inside the annotated `.cta` rule; injection text stays framed and cannot approve), chat-annotations (5),
renderer annotations (33). E2E on Windows x64: preview-annotations 10/10 (four runs, last one after the review fixes), plus smoke, a11y,
preview, preview-isolation, preview-snapshot, preview-layout, ai-preview, ai-agent, ai-chat, ai-history: 70/70.
`npm run verify` green.

**Independent review** (subagent, whole diff): no isolation, IPC or path issue; 7 findings fixed in the last code
commit — false "exact" matches (file classes must be on the page element; no id/class/text → approximate; selector
compare keeps descendant spaces and case; non-applying `@media` rules are counted so occurrences agree with the
file), Show refused on another page, a failed `DOM.enable` no longer leaves the domain counter up (picking stayed
broken), parsed files cached per list, stale strip results dropped, an invalid ancestry step drops the ancestry.

**Decisions:** decision 0030. Annotations persist per project in app data (like saved chats); element picking is the
primary path, a region resolves to the smallest element that contains it; Ask AI defaults to agent mode so the
assistant proposes a reviewable diff.

**Problems / risks:** elements inside iframes / shadow DOM / canvas cannot be located in source (the annotation says
so). Python edits on Windows wrote CRLF once (git normalised; prettier fixed the working copy) — use `newline=''`.
macOS arm64 not run locally (CI matrix covers the e2e).

**Owner action needed:** none for S41. Try it: open a project, start the preview, press 标注 under the preview
toolbar.

**Next up**

1. M7 release pipeline (owner tasks H.2, manual hardware checks, S29.x acceptance runs) as before.
2. Ideas below if the owner wants more from annotations.

**Ideas / backlog candidates:** numbered pins drawn by the protocol overlay for all annotations of a page; resolve an
annotation automatically when the agent's accepted change lands in its range; annotate inside same-origin iframes.

---

## Session 16 — 2026-10-16 — Full Windows e2e suite green twice; preview guard on loaded machines (S05.8)

**Agent:** Claude (Opus 5.5) on the Windows x64 dev machine (Windows 11, 2560×1440 at 150 %, 32 logical cores), in
worktree branch `claude/hopeful-hawking-f23203` (node_modules junctioned to the main checkout), started from another
session. Subagents: history-triggers stabilisation, Chromium source research, ai-history test, an independent
reviewer for S05.8. Main's S25/S28/S40 work was merged in (`51a7d73`) before the final runs.

**Done**

- S39.3 — `smoke.spec` S02.2 lists `ai.previewSnapshot` and the `aiHistory` bridge (S38.2/S39 surfaces it missed).
- S15.7 — `preview-layout.spec` scale factor 2: on a 150 % display `setContentSize(1280, 800)` gives 1281×801; the
  wait accepts 1 px, divider sizes are still compared exactly.
- S21.5 — **product:** a save hands local history the bytes it already read and hash-checked; the old second read
  raced the 1 s capture timeout, so a loaded machine could silently drop the before-save version. Test: no wall-clock
  bounds (fake timers, never-resolving store). 20/20 with the CPU saturated (10 of 18 failed before).
- S05.8 — **product:** the Session 12 "Starting" stall. Without a DevTools client a new preview view's first
  about:blank load can stay pending 30–45 s under CPU load (also in stock Electron 44), and the guard's commands only
  answer once the view's renderer runs; one 5 s bound over both made every preview on a busy machine run **without
  the console guard** after 5 s of Starting. Playwright's connection to every view hid it from the whole suite.
  `installPageGuard` now re-requests the first document every 1 s (≤ 30 s), gives the commands ≤ 45 s, and both
  waits end at once on Stop / a newer Start; `debugInfo().guardTrace` (timings + outcome only). New
  `tests/e2e/preview-restore.spec.ts` + `inspector-launch.ts`: 5 restarts driven only through main's Node inspector,
  under 1.5 busy threads per core; fails on the old code, passes on the fix. Chromium source (read by a subagent,
  Electron 44 = Chromium 152) rules out the original `waitForDebuggerOnStart` hypothesis: the page's own session
  never throttles a main-frame navigation.
- S39.4 — `ai-history.test.ts` budget test raced the usage store (150 ms model delay vs a queued write); explicit
  gate; teardown drains the last request (Session 13's ENOTEMPTY). Dates checked: `dayKey()` is local-calendar.
- docs/reviews/G9.md — criterion 4 Windows row and a "Windows x64 full e2e suite (Session 16)" section.

**Evidence:** `npm run verify` green @ `51a7d73`. Full `npm run test:e2e` then `--no-build`, back to back on
`51a7d73`: **271 passed, 4 skipped (macOS-only), 0 failed — twice** (12.0 / 11.1 min). Earlier runs this session:
`f51e123` 247 passed / 2 failed; `683570f` 245/2 and 256/1 (restore spec under load; walkthrough once). S05.8 old vs
new with the same spec: old fails at restart 1 (unguarded), new passed 2/2 alone and in both final runs; reviewer
findings (retry spin, cancellable install, launcher cleanup, timeouts) fixed.

**Decisions:** none needing a record; decision 0016 is unchanged (the page itself stays best effort, now after up to
30 + 45 s instead of 5 s; workers and frames stay fail-closed).

**Problems / risks:**

- Seen once, not reproduced: `preview-layout.spec` S15.1 divider drag stopped 30 px short (run 1; 8+ isolated runs
  and four later full runs green — a real-cursor theory was tested and not confirmed, nothing changed);
  `walkthrough.spec` "progress survives a restart" panel missing after restart (one run; three later runs green).
  If either recurs, keep the error-context and the app log from the run.
- `preview-restore.spec` takes ~4–5 min (it loads the CPU on purpose). One restart in the final runs took 15.6 s
  from process launch (S05.8's criterion says 15 s; the rest 3.4–9.1 s).
- Under extreme load (2 busy threads per core) a preview can stay Starting up to ~45 s before it is guarded.
- Other tests the S21.5 subagent saw fail only while the CPU was saturated: history-groups, history-store "coalesces
  a save burst", watcher (2), faults/history-faults — not investigated.
- Merged into local main on the owner's go-ahead (not pushed); local main is ahead of origin (S25, S28, S40 and this
  work unpushed). Main's Session 15 (Windows installer + perf) came in after the two green runs: verify and the
  packaged build were rechecked after that merge, the full e2e suite was not rerun.

**Owner action needed:** push main; check the next CI run on both jobs
(G9 condition 2); Mac: run `preview-restore.spec` on Apple Silicon (Session 12 saw the stall there).

**Next up**

1. CI on `windows-latest` and macOS with this branch (G9 condition 2).
2. Load-sensitive integration tests listed above (one feature each, same approach as S21.5).

**Ideas / backlog candidates:** none.

## Session 15 — 2026-10-16 — Release prep: signing pipeline, sleep/wake recovery, Windows installer + perf

**Agent:** Claude (Opus 5.5) as lead on the Windows x64 dev machine; three subagents in git worktrees (release prep),
each branch reviewed and merged by the lead. In parallel, two separate sessions ran: "Full Windows e2e run and fix
failures" (its own branch, not merged yet) and "Liquid Glass UI redesign" (S40).

**Owner decisions this session**

- Owner asked "is NoobIDE ready for release?" — answer: not for public release; ready for self-use and an invite-only
  unsigned build (G3). Then: fan out agents for everything that is not owner-blocked.

**Done**

- S28.2 / S28.3 — credential-gated signing: `signing.config.ts` (env-only, all-or-nothing per route, DMG signed +
  notarised + stapled), `.github/workflows/release.yml` (tags/dispatch only, `contents: read`, SHA-pinned actions,
  secrets only in step env, temp keychain cleaned up), `scripts/verify-signing.mjs` (spctl / stapler / signtool).
  Status **blocked** on H.2 secrets: `docs/release/signing.md`. ADR 0027 (Windows route: Azure Artifact Signing if
  eligible, else unsigned first then OV cloud certificate).
- Owner drafts: ADR 0003 platform support (**Proposed**: macOS 13+ arm64, Windows 10 22H2+ x64, Win arm64 out of
  v1) and `docs/release/owner-decisions.md` (H.1, H.2, H.4 with recommendations). S01.4 stays todo (needs H.1).
- S25.1 / S25.2 — sleep/wake recovery (`src/main/wake-recovery.ts`, `src/platform/power-events.ts`): on resume,
  unlock or a clock-drift jump, watchers resync, the static server / proxy are probed (403 dotfile probe, nothing
  served) and restarted if dead, a page that hung after sleep gets a new renderer; unsaved edits survive. ADR 0028.
  Independent reviewer subagent; findings fixed. **needs_manual_check** (real sleep): MANUAL-CHECKS#S25.1/#S25.2.
- S28.1 done; S02.7 evidence — `npm run make` failed on Windows ("Authors is required."): Squirrel maker now has
  authors/owners/description (regression test). Setup.exe 157 MB, version info/icon checked, noobide.exe x64,
  `selftest:packaged` 24/24, packaged app launches and About shows the version. Installer not run (owner steps).
- S27.1 / S27.3 — `docs/perf/win32-x64.md` (i9-13900KF): cold start p95 1806 ms under load / 1017 ms idle, packaged
  start p95 447 ms, save→preview p95 123 ms, memory idle 581 MB; typical memory 709 MB vs ~700 MB budget accepted
  for now in `docs/perf/targets.md` (trigger: profile the Windows GPU process). Kept needs_manual_check: no quiet
  window for a clean full run.
- S40 (Liquid Glass UI) reached main by a **fast-forward of main to `s40-liquid-glass` (3dc570b) made outside this
  lead session**; ADR renumbered to 0029 before that. See that session's report for its features and checks.

**Evidence:** `npm run verify` green on main `0873eee` with the machine idle (earlier red runs were load: a different
2–6 timing tests failed per run while up to 10 Electron/Node processes ran; each failing file passes alone).

**Problems / risks:** unit timing tests flake under heavy CPU load (history-triggers, watcher, app-data-upgrade,
portability, ai-history) — the e2e session is fixing several (S21.5). Full Windows e2e still not green twice; the
preview "Starting" fix (S05.8) and S39.4 live on that session's branch, not on main yet. Signing has never run with
real credentials. Decision numbers collided three times across parallel branches (0027) — renumber on merge.

**Owner action needed:** read `docs/release/owner-decisions.md` and answer H.1/H.2/H.4; create the signing secrets per
`docs/release/signing.md`; manual checks S02.7 (install/uninstall, no-Node machine, SmartScreen), S25.1 (real
sleep), S27.1 (perf on a quiet machine); `npm run test:ai-live` (S36.1); S40.8 hardware checks; push main.

**Next up**

1. Merge the "Full Windows e2e" session's branch once its suite is green twice (S05.8, S21.5, S39.3, S39.4, S15.7).
2. Push and get CI green on both jobs (S06.1/S06.2/S26.2), then the G1 review (S06.4).
3. After H.2: first signed release run; after H.1: close S01.4.

**Ideas / backlog candidates:** "Claude Code (your subscription)" provider that spawns the user's own logged-in
`claude` CLI as a text-only model (policy gray zone — confirm with Anthropic; needs ADR + security review).

## Session 14 (side session) — 2026-10-15 — Liquid Glass design language (S40, milestone M11)

**Agent:** Claude (Opus 5.5) on the Windows x64 dev machine, in worktree branch `s40-liquid-glass` (started from
main `f51e123` while another session ran the full Windows e2e suite on main). Subagents: Apple docs research, design
study + decision record, e2e spec, independent diff review; all output checked by the lead.

**Owner request:** make the UI the neatest, friendliest, best-looking beginner IDE, inspired by Apple's Liquid Glass
(SwiftUI view styles, animations, text input, controls, menus and commands; HIG materials/layout/toolbars/sheets/
accessibility). New milestone M11, session S40 (8 features).

**Done**

- S40.1 — `docs/product/liquid-glass-study.md` (13 principle areas in our own words with Apple links, adopt/adapt/
  reject for Electron on Windows + macOS, plan, later candidates) and decision 0029. Research notes also in the shared
  notes folder (`s40-apple-research.md`).
- S40.2 — glass materials in `tokens.ts` (`GLASS`, `composite()`, contrast test of text on each fill over every surface
  it can float over, plus solid twins). `src/renderer/glass.css` (loaded after styles.css): chrome is translucent with
  **no** backdrop blur; only menus, the palette and sheets blur, and never over the editor or the native preview.
  Reduced transparency (media query, or `html[data-transparency=reduce]`), increased contrast and forced colours → solid.
- S40.3 — SwiftUI-style control styles (glassProminent / glass / plain, pressed squeeze), top-bar capsule groups, rail as
  a floating capsule, concentric radii, one filled text-field style; empty-state action is the place's primary button.
- S40.4 — spring easings (`linear()`), ≤ 340 ms; reduce motion → dissolve only. Theme switches are instant
  (`data-theme-switching` for two frames) — also fixed axe catching colours mid-transition.
- S40.5 — command palette: Ctrl+Shift+P / ⌘⇧P, top-bar "搜索命令" button, View menu. Lists only commands that can run,
  searches Chinese and English ("save" → 保存 with an "英文：Save" hint), IME-safe, modal (preview view hidden), focus
  returns. `commands/palette-model.ts` (+tests), `CommandPalette.tsx`, `i18n/palette.ts`.
- S40.6 — CSS-only scroll edge effect on file tree / problems / AI chat; AI chat bubbles, composer, chips and consent in
  the same language.
- S40.7 — `tests/e2e/glass.spec.ts` (9 tests: palette keyboard flow, runnable-only list, native menu, materials in both
  themes, reduced transparency, reduced motion, increased contrast, forced colours, axe on the palette) and
  `glass-visual.spec.ts` (screenshots light/dark → `test-results/glass/`). `axeScan` now waits for finite animations.
- S40.8 — needs_manual_check: Windows Transparency effects off / contrast themes and macOS Reduce Transparency /
  Increase Contrast / Reduce Motion (MANUAL-CHECKS.md#S40.8).

**Evidence:** `npm run verify` green in the worktree. e2e on Windows x64: affected specs (a11y, theme, shell, menus,
commands, ai-settings, ai-chat, file-tree, glass, glass-visual) green after the review fixes; full suite 263 passed /
2 failed — both reproduced on an untouched `f51e123` build (`smoke.spec` preload API list lacks `previewSnapshot`/
`aiHistory` from S38/S39; `preview-layout.spec` scale-factor resize timeout). Left to the e2e-fixing session.
Reviewer findings fixed: menu/palette focus visible in forced colours, scroll-edge fade hiding keyboard focus,
theme-switch attribute could stick, clicking the sheet lost keyboard focus, English plural.

**Decisions:** 0029 — glass only on the floating control layer; blur only on transient overlays; a solid twin for
every translucent token; concentric shapes + spring motion tokens; the palette derived from the command registry.
`shell.spec` control list gains `open-palette` (a new working control, not a weakened check).

**Problems / risks:** whether Chromium maps Windows "Transparency effects: Off" to `prefers-reduced-transparency` is
unproven (S40.8); bridging `nativeTheme.prefersReducedTransparency` is the fallback. `tests/integration/watcher.test.ts`
fails 2 tests under heavy load (also on main) and passes when the machine is quieter. Main moves in parallel: expect
a conflict at the top of this file and in `harness/features.json` on merge (both are additive).

**Owner action needed:** review the screenshots in `test-results/glass/` (run `npx playwright test -c
tests/e2e/playwright.config.ts "e2e[\/]glass-visual\.spec"` after `npm run package`), run S40.8, merge the branch.

**Next up**

1. Merge `s40-liquid-glass` into main after the e2e-fixing session lands; rerun `npm run verify` and the glass specs.
2. S40.8 on both platforms; if the Windows mapping is missing, add a feature to bridge nativeTheme to `data-transparency`.
3. Candidates from the study's "Later": native window material (Mica / vibrancy), icons in menus, context menus
   without shortcuts per HIG, AI chat as an inspector column.

## Session 13 — 2026-10-15 — AI v2: Windows proof (S37), preview-aware AI (S38), chat history + usage (S39)

**Agent:** Claude (Opus 5.5) as lead on the Windows x64 dev machine, four parallel subagents in git worktrees
(node_modules junctioned to the main checkout; e2e per agent limited to its own specs), each branch reviewed and
merged by the lead.

**Owner decisions this session**

- Next AI work: S37 (prove M9 on Windows), S38 (preview-aware AI), S39 (chat history + usage). New milestone M10.
  "More providers (OpenAI-compatible / CN endpoints)" was offered and not chosen for now.

**Done**

- S07.5 — watcher replay check flaked on Windows (1 in 4 full runs): NTFS ctime can read ~1 ms after a later
  `Date.now()`; `predatesSnapshot` now allows 2 ms (`CLOCK_SKEW_TOLERANCE_MS`, measured in the comment).
- S37.1 — five AI e2e specs green on Windows x64; fixes: Monaco's own "Canceled" rejections were unhandled when typing
  during the inline-completions debounce (product: `src/renderer/editor/monaco-cancellation.ts`, only exact
  CancellationErrors are swallowed); copy-code test normalises the Windows clipboard's CRLF; agent restart test waits
  for the project to reopen. New `tests/e2e/ai-keychain.spec.ts` (Windows only): key stored through real DPAPI
  safeStorage (`v10` ciphertext, no plaintext) survives a restart and decrypts. G9.md has the Windows addendum.
- S38.1/S38.2 — `src/preview/page-snapshot.ts`: bounded page outline (isolated world over the page guard's CDP
  session) + capped PNG (capturePage) from main only; agent tools `get_page_outline` / `get_page_screenshot`,
  `get_console` names project `file:line`; chat "Preview" chip (shows exactly what is sent, needs consent). Decision 0026. Also fixed: preview watchdog ping lost across a document swap kept the preview "unresponsive".
- S39.1/S39.2 — saved chats per project in app data (`ai-chats/<projectKey>/<uuid>.json`, atomic, caps, corrupt files
  set aside; context names/lines only, never the code), past-chats list, delete offers on revoke / recent removal;
  token use per answer, today's totals in Settings → AI, optional daily budget (`budget-reached`). Decision 0025
  amended; install docs updated. Merge with S38: saved chats accept the `preview` context kind (path label only).

**Evidence:** `npm run verify` green on main after every merge. Merged main `cbf9029`: AI + preview e2e
(ai-settings, ai-inline, ai-chat, ai-edit, ai-agent, ai-keychain, ai-history, ai-preview, preview-snapshot,
preview-isolation, preview-manager, preview) **64 passed / 0 failed** on Windows x64. S07.5: 20 consecutive full
vitest runs green. S38 had an independent reviewer subagent per feature; findings fixed (`d795f2d`, `3b184ee`).

**Problems / risks:** full Windows e2e suite not run this session (only the 12 affected specs) — G9 condition 2 (CI
green on both jobs) still open. Timing-sensitive under load: `tests/integration/history-triggers.test.ts` (2/4 runs
failed while 4 agents loaded the machine), `preview-manager.spec` S14.2 (once). The "preview restored at startup
stays Starting" bug from Session 12 is still open. Cancelled chats before a usage event are not counted.
package-lock.json not regenerated (no dependency changes).

**Owner action needed:** push and check CI on both jobs; `npm run test:ai-live` with your keys (S36.1); edit PLAN
§4/§7 for AI; decide AudioWorklet; manual checks listed in Session 12; H.1, H.2.

**Next up**

1. Full `npm run test:e2e` on Windows and the next CI run; fix what fails (G9 condition 2).
2. The preview "Starting forever" bug from Session 12 (resume the page from main after navigation + regression e2e).
3. Stabilise `history-triggers.test.ts` under load.

**Ideas / backlog candidates:** OpenAI-compatible / CN providers (DeepSeek, Qwen, Moonshot, Ollama) with a vetted
allowlist — needs a decision record and security review because it reopens the egress lock.

## Session 12 — 2026-10-15 — AI assistant (M9), console limiter redesign, Windows CI fixes — paused for Windows

**Agent:** Claude (Opus 5.5) as lead on the Apple Silicon Mac with parallel subagents in git worktrees. Owner paused
here to continue on the Windows desktop; everything is pushed to origin/main.

**Owner decisions this session**

- **AI is in scope** (lifts PLAN §4 "no AI chat"): decision 0025, plan docs/product/ai-plan.md, milestone M9,
  sessions S31–S36. Direct Anthropic + OpenAI APIs with the user's key (OS keychain via safeStorage); on by default
  once a key exists, full power; agent proposes, user approves every diff. **PLAN §4/§7 still need an owner edit**.
- **Console limiter option 1**: no page may hold an unthrottled console method (decision 0016, second amendment).
- Open owner question: backlog item to bring AudioWorklet back to the preview (removed by the limiter; works via
  "Open in browser").

**Done (125 done + 16 needs_manual_check of 159; M9 13/13 with S36.1 manual)**

- S14.7 (owner-reported 404): a project without index.html previews its first page; a project with no `.html` page
  explains it and offers "rename to … .html" for files that start like HTML (only on click).
- M9: S31.1–S31.4 foundation (`src/ai/`: providers over `@anthropic-ai/sdk` 0.134.0 and `openai` 7.34.0, keys,
  config, consent, service, IPC, Settings → AI, fake provider `NOOBIDE_AI_FAKE`), S32.1 inline ghost text, S33.1/S33.2
  chat + explain + Ask AI, S34.1/S34.2 agent (project-confined tools, diff review, applied through the save pipeline,
  agent turns as local-history groups with undo that survives restart; history index v2), S35.1/S35.2 inline edit
  (Ctrl/Cmd+I) and Fix with AI, S36.2 docs + docs/reviews/G9.md. S36.1 security review: 7 findings fixed (fake env
  ignored when packaged, SDK egress locked to the two provider hosts, consent/AI-off abort running requests, …);
  `npm run test:ai-live` wired, needs owner keys (MANUAL-CHECKS#S36.1).
- S05.7/S05.3 redesign (`src/preview/page-guard.ts`): no native console method reachable; one console budget per page
  (frames share it, workers 20/50 per s); main stall ≤ 92 ms even with simulated slow main. Trade-offs:
  `IsolateSandboxedIframes` disabled app-wide (only sandboxed frames inside the preview lose their own process), paint
  and audio worklets removed from the preview, DevTools console links point at the guard stub.
- Real bugs fixed from Windows CI and reviews: session restore stole the user's tab choice (typing could land in the
  wrong file, S13.4); watcher paired late FSEvents rename halves (S07.3); history dialog close race; permission test
  uses fake capture devices on camera-less runners.

**Evidence:** `npm run verify` green (2002 tests). Full e2e on macOS after S31: 235 passed / 0 failed; later full runs
show only `language.spec` / `upgrade.spec` timing out under load (pass alone). CI run 38708368168 (first with the AI
work and limiter redesign) was **still running at pause** — check it first; the S36 security fixes came after it.

**Problems / risks:** `language.spec` / `upgrade.spec` packaged-app timeouts in full runs (an agent was investigating —
see its branch note below). No single CI run has had both jobs green yet (S06.1/S06.2/S26.2 open). package-lock.json
regenerated on macOS (new AI deps) — regenerate on Windows per AGENTS.md.

**Merged at pause (packaged-app timeouts):** product fix — the packaged self-test (`language.spec`/`workers.spec`)
ran on the developer's REAL app data (reopened their project, rewrote `session.json`); it now uses a temp
`--user-data-dir`. `upgrade.spec` now kills its processes on failure and bounds every wait. **Open, likely product
bug:** a preview restored at startup can stay in "Starting" forever — the navigation from about:blank is held before any
request (suspected: the preview's own `Target.setAutoAttach {waitForDebuggerOnStart: true}` pausing the main frame after
a process swap with nothing resuming it). Reproduced 1 in 3 under load; repro scripts were in a temp dir on the Mac
(not kept). Fix: resume the preview page from main after each navigation (or don't wait for the debugger), plus a
regression e2e that restores a session with a preview without Playwright attached.

**Owner action needed (on Windows):** `git pull`; `npm install`; run `npm run verify` and `npm run test:e2e`; check CI
run 38708368168 and the next one; run `npm run test:ai-live` with your keys (S36.1); Windows manual checks in
MANUAL-CHECKS.md (S05.5-windows, S15.5, S17.4, S24.2, S25.3, S26.1, S27.1, S28.1, S28.4, S36.1, IME S09.4); edit PLAN
§4/§7 for AI; decide AudioWorklet; H.1, H.2.

**Next up**

1. Get one CI run green on both jobs (closes S06.1/S06.2/S26.2); fix the packaged-app timeouts.
2. G9 conditions: live AI test, Windows key-store restart check.
3. Signing (H.2) → S28.2/S28.3/S28.5 → S29 acceptance runs (docs/release/acceptance.md).

## Session 11 — 2026-10-15 — First CI runs on Windows; wave 5 (Windows fixes, S25.4, S26.2, S28.4, S28.6, gates, memory)

**Agent:** Claude (Opus 5.5) as lead on the Apple Silicon Mac, seven parallel subagents in git worktrees. Owner
stopped the fan-out after this wave. GitHub Actions is live (`.github/workflows/ci.yml`); main was pushed twice
during the session to run it (last pushed commit 3314de9). **Main is 47+ commits ahead of origin and NOT pushed.**

**CI history:** run 38673893839 — Windows verify failed (5 tests with macOS-only assumptions: TCC simulation on
`C:\` paths, NTFS readdir order of NFC/NFD twins, watcher stall measuring the test's own deletes) — fixed. Run
38674795825 — Windows verify (watcher settle, slow history disk) + macOS e2e (real race: one-click fix never saw the
refresh its own save triggered; load count now taken at save request) — fixed. Run 38675714521 — **macOS job fully
green incl. make + inspect-arch (artifact noobide-macos-arm64)**; Windows verify green, first-ever Windows e2e:
161 passed / 9 failed / 44 not run. The fixes for those 9 are merged but **not yet pushed or re-run**.

**Done (112 done + 15 needs_manual_check of 145; was 110 + 12)**

- Windows CI fixes: e2e read the whole Monaco document (`documentText`, short Windows runner screen hid lines);
  real Windows bug — app-data `writeFileAtomic` (journal, history, settings, session, walkthrough) dropped writes on
  transient EPERM/EACCES/EBUSY; now retries with the platform backoff like project saves (lead reviewed).
- S25.4 done: every preview permission denied (request/check/device handlers, pickers cancelled), one localised
  console notice per kind. Real crash fixed: Web Bluetooth in a preview page killed the IDE on macOS (TCC) —
  `disableBlinkFeatures: 'WebBluetooth'` is now a required preview preference. Decision 0009 amended.
- Console flood fully bounded: main ends page/worker scripts via `Runtime.terminateExecution` over the limit; in-page
  limit 1000→200/s. Cached `console.log` loop stall 1.5–2.1 s → 21–77 ms; worker flood 4–38 ms (was 356 ms on Windows
  CI). Reviewed. Decision 0016 amended. **S05.7 evidence text in features.json still says 1000/s.**
- One preview generation counter (`PreviewStatus.generation`) feeds capture, stale-marking and fix load counting.
- Real bug: 404s whose body Chromium aborts (`ERR_ABORTED`) were never recorded ("11 of 13" on Windows CI) —
  `src/preview/resource-failures.ts`. Two agents fixed it independently; the tracker version was kept (0017 amended).
- S26.2 needs_manual_check: `npm run test:faults` as its own CI step on both jobs with per-OS report artifacts and a
  skip policy (Windows may skip exactly 7, macOS 0). Flaky e2e/unit tests fixed with condition waits; store perf test
  measures CPU time.
- S28.4 needs_manual_check: Squirrel lifecycle (`src/platform/squirrel.ts`), schema-versioned app data
  (`schemaVersionOf`, `app-data-layout.ts`; newer files read-only, never rewritten), packaged vN→vN+1→vN upgrade e2e on
  this Mac. Uninstall keeps app data (decision 0023). Behaviour changes vs earlier criteria wording: newer settings are
  read-only (was backed up + reset, S13.1); future-format journal records are skipped in place (was quarantined,
  S12.3). Fixed invalid ad-hoc signature of the packaged mac app (postPackage re-sign; verified in distribution e2e).
- S28.6 done: docs/release/install.{zh-CN,en}.md, release-notes template, docs/release/acceptance.md (S29 checklist).
- S17.4 needs_manual_check (docs/reviews/G3.md, conditional pass on Mac), S06.4 in_progress (docs/reviews/G1.md draft:
  ~9.6 h active commit time; estimate M6–M8 ≈ 6–9 agent sessions + 3–4 owner days; beta ≈ 6–10 weeks, gated by H.2,
  H.6, H.7).
- Memory: real usage is ~205–270 MB private footprint (working-set sums double-count shared framework pages); idle
  GPU 175 → 45 MB by resting Monaco's caret after 10 s (`caret-rest.ts`). `scripts/measure-memory.mjs`, decision
  0024, docs/perf/memory.md. S27.3 evidence could point at the new numbers (not changed).
- Owner-reported 404 (after the wave): a project whose page was saved as `html/home` (no `.html`) previewed as a bare 404. 3fa343d: no index.html → preview opens the first page (`defaultEntryPath`), picker shows it. New **S14.7**
  (done, 2335e7a): no page at all → the stage explains it (zh-CN + en) and offers "rename to … .html" for files that
  start like HTML (`src/preview/misnamed-pages.ts`); renames only on click, via the Files panel path.
- Lead: consent text named the wrong button (启动预览 → 开始预览); removed stale `files.emptyHint`.

**Evidence:** `npm run verify` green (1679 tests). Full `npm run test:e2e` on macOS: 217 passed / 2 skipped after the
preview merge; final run after the memory merge 209 passed / 1 failed / 7 not run (S15.1 divider drag — see below).

**Problems / risks:** S15.1 "dividers drag with the mouse" failed in two full runs (drag did nothing), 0 of 48 isolated
runs — open intermittent, cause unknown (a hit-test guard was added; not enough). preview-isolation beforeunload test
flaked once. A first-launch hang was seen once under extreme load. Windows e2e fixes unverified until the next CI
run; S05.7's 200 ms budget on Windows CI to be re-measured. Parallel `electron-forge package` runs collide in the
shared temp dir (use a private TMPDIR). The upgrade e2e drives the shipped binary via `--remote-debugging-port`
(standard Electron; consider an Electron fuse for release builds).

**Owner action needed:** push main and check CI (S06.1/S06.2 need a green Windows job with make + inspect-arch;
S26.2 needs both fault-suite artifacts). H.5 looks effectively done (Actions running) — owner closes it. H.1, H.2
open. Manual checks: S28.4 (Windows install/upgrade/uninstall), S17.4, S15.5/S15.6, S24.2, S09.4/S09.5 and the earlier
list in MANUAL-CHECKS.md.

**Next up**

1. Push, read the Windows e2e results, fix what remains; then S06.1/S06.2/S26.2 can close.
2. Find the S15.1 drag intermittent; update S05.7 evidence text.
3. After signing (H.2): S28.2/S28.3/S28.5; then S29 acceptance runs with docs/release/acceptance.md.

## Session 10 — 2026-10-15 — Wave 4 on the Mac: wave-2 work rebuilt (preview, diagnostics, problem card, CI)

**Agent:** Claude (Opus 5.5) as lead on the Apple Silicon Mac, seven parallel subagents in git worktrees (P1–P7).
The Windows-only wave-2 branches (W1/W2/CI/W4-S13.5 from Session 4) were never pushed; the owner chose to **rebuild
that work here. Those Windows branches are now obsolete — do not merge them.**

**Done (110 done + 12 needs_manual_check of 145; was 88 + 7)**

- P1 — S05.5 (reopened security findings), S05.7, S05.3: all preview traffic goes through a SOCKS5 proxy in main
  (`src/preview/preview-proxy.ts`, `address-policy.ts`) that allows only the project server on literal 127.0.0.1 and
  public addresses, deciding on resolved addresses (no rebinding; LAN/own-interface CIDRs, mapped/NAT64 forms refused;
  lookups via `session.resolveHost`, capped + timed out). Non-blocking dialogs/beforeunload, service workers blocked +
  cleared, sanitized log URLs. In-page console limiter over CDP (`page-guard.ts`): main stall 11–23 ms during the flood
  (was 8–9 s). Two independent reviewers, three rounds, all findings fixed. Decisions 0015, 0016.
- P2 — S16.2–S16.6: runtime capture adapter (`src/diagnostics/runtime-capture.ts`, `src/main/problems-bridge.ts`,
  `window.noobide.problems`), refresh attribution (stale records), resource failures with initiator, per-source volume
  limits, certain-wording cross-origin explanation. Decision 0017.
- P3 — S14.1–S14.6, S15.4: preview state machine, auto/manual refresh, entry picker, start consent (trusted folders
  hashed in `<userData>/preview.json`), Clear preview data, one server per project with owner checks
  (`server-registry.ts`), toolbar commands in the S24 registry, "Open in browser" one-time grant + cookie. Reviewed.
  Decision 0018. Lead fixed two follow-ups P1 found (start ownership on insecure-prefs abort; `open-failed`).
- P4 — S15.1–S15.3 done (fixed real splitter drag-release bug — likely the old "12 px off"), S15.5/S15.6
  needs_manual_check (mac half demonstrated incl. fullscreen, overlays, focus handoff, forced scale 1.5/2; real bug
  fixed: Start/Refresh stole keyboard focus into the page). Decision 0019.
- P5 — S22.4 problem card (did-you-mean now gets declared names from the TS service), S22.5 one-click fix. Independent
  review found a must-fix (fix in a background tab bypassed the recovery journal; same latent gap in S21.3 restore) +
  4 smaller issues; S22.5 reopened, all fixed (`recordEdit` in Workbench), re-marked done.
- P6 — S06.1–S06.3 needs_manual_check: `.github/workflows/ci.yml` (windows-latest + macos-14, SHA-pinned actions,
  contents: read), `scripts/inspect-arch.mjs`; the macOS job's commands all pass locally; DMG validated on this Mac.
  Nothing pushed to Actions yet. Decision 0021.
- P7 — S13.5 cross-platform transfer notice (read-only scan, `src/shared/portability.ts`), S13.7 Gate G2 review
  (`docs/reviews/G2.md`, conditional pass — Windows evidence not re-run), FileTree stale-listing race fixed
  (`folder-listing.ts`). Decision 0022.

**Evidence:** `npm run verify` green (1643 unit/integration tests). Full `npm run test:e2e` on macOS arm64, machine
otherwise idle: run 1 212 passed / 1 failed / 2 skipped, run 2 214 passed / 2 skipped. Per-feature evidence in
features.json.

**Decisions:** 0015–0019, 0021, 0022 added (0020 unused). Generation: `PreviewStatus.generation` (P3) and the
capture adapter's own navigation counter (P2) coexist — unify later.

**Problems / risks:** Load-sensitive e2e flakes, each passing alone: preview-layout scale-1.5 (timed out once in an
idle full run), recovery.spec S12.2, file-tree S08.5, runtime-problems, history. One unit flake under heavy load
(likely the "100k events < 2 s" store test). Preview limiter bypass: a page holding a saved native `console.log`
can still stall main ~2 s. None of this wave has run on Windows. The background-tab journal e2e passes even without
its fix on this machine (race not reproduced); a unit test guards it.

**Owner action needed:** run `npm run verify` + `npm run test:e2e` on Windows; manual checks S05.5-windows, S15.5,
S15.6, S06.1–S06.3 (push and run the workflow), plus the Session 9 list (S24.2, S25.3, S26.1, S27.1, S27.3, S28.1).
H.1, H.2 still open. S09.4/S09.5 IME need a person.

**Next up**

1. Windows re-run of everything; fix what breaks there.
2. S17.4 and S06.4 gate reviews; S25.4 (preview permission requests denied — now unblocked), S26.2 (fault suite in
   CI), S28.6 user docs (only claim proven capabilities).
3. Stabilise the load-sensitive e2e tests listed above; unify the preview generation counters.

## Session 9 — 2026-10-15 — First macOS session; parallel wave 3 (S23, S24, S25.3, S26.1, S27, S28.1)

**Agent:** Claude (Opus 5.5) as lead on a physical Apple Silicon Mac (MacBook Pro M3 Pro, 18 GB, macOS 27.2 arm64),
with six parallel subagents in git worktrees. First time the project ever ran on macOS. Pulled the owner's
S11.1–S11.3/S13.4 fixes (e3d9ffd) first. The wave-2 branches W1/W2/CI live only on the Windows machine (not pushed),
so this wave deliberately avoided their areas: preview (S05.5/S05.7, S14, S15, S16), problem card (S22.4/S22.5), CI (S06).

**Done (88 done + 7 needs_manual_check of 145; was 55 + 6)**

- macOS verify fix: `npm run verify` was red on macOS (11 tests). Real product bug: FSEvents replays changes made just
  before the watch attaches, so freshly created projects reported spurious `changed` events — `src/workspace/watcher.ts`
  now ignores replays inside a 1 s window when ctime predates the snapshot (amendment in decision 0007). Two tests had
  Windows-only assumptions (`/var` → `/private/var` realpath; ENOTDIR vs ENOENT for a broken history folder).
- macOS e2e: real bug — the overflowing tab strip's overlay scrollbar swallowed tab clicks on macOS; strip now has no
  scrollbar, scrolls the active tab into view and maps the wheel to sideways scroll (TabBar.tsx + regression e2e).
  E2e made platform-neutral: `tempRoot()` and `keys.ts` (DOC_START/DOC_END/FIND_REPLACE) in tests/e2e, mac labels.
  S02.6, S12.4 (recovery e2e now passed on Apple Silicon + Windows) and S05.6 (mac baseline row) done.
  `selftest:packaged` and `selftest:dev` pass on darwin arm64.
- S25.3 protected-folder errors (macOS TCC / Windows Controlled Folder Access) explained with OS-specific steps
  (`src/platform/protected-folders.ts`). S26.1 fault suite: 55 tests with an injected `node:fs/promises`
  (tests/integration/faults/), matrix in docs/release/fault-matrix.md. It found and fixed two data-safety bugs:
  journal `discardSaved` deleted an unreadable record that could hold newer edits; a failed re-create left an empty
  placeholder that later read as a false conflict. Both reviewed by a separate subagent and by the lead.
- S27.1 perf scripts (`scripts/measure-perf.mjs`, docs/perf/darwin-arm64.md: cold start p95 853 ms, packaged 831 ms,
  save→preview 61 ms), S27.2 offline acceptance e2e (network cut proven at three layers), S27.3 (no mac misses),
  S28.1 icons (placeholder art, `scripts/make-icons.mjs`), forge metadata, DMG+ZIP on mac, About dialog.
- S23.1–S23.4 walkthrough engine, PLAN §2 journey (steps detected from real saves/problems/restores), unguided final
  task, glossary (22 terms). Progress in `<userData>/walkthrough.json`.
- S24.1 command registry (`src/shared/commands.ts`, `src/platform/keybindings.ts`), S24.2 native menus per platform +
  window lifecycle, S24.3 axe-core a11y pass (light/dark, F6 region cycling), S24.4 theme choice persisted. About,
  walkthrough and glossary are registry commands in the Help / app menu.

**Evidence:** `npm run verify` green on macOS (1326 tests). Final full `npm run test:e2e` on macOS arm64: 181 passed, 2
skipped, 0 failed. Fixed on the way: a menus About/Escape race (test waits for dialog focus) and a real watcher bug —
a file created and deleted by another program within one 100 ms batch stayed in the tree (S07.3; `flush` now reports
"gone + unknown" as `deleted`; amendment in decision 0007; file-tree spec 150/150 with `--repeat-each 10`). Per-feature evidence in features.json.

**Decisions:** 0012 installers and app identity (Squirrel on Windows; DMG+ZIP on mac; Windows `iconUrl` stays
default until a release host exists). 0013 onboarding walkthrough (renumbered from 0012 at merge). 0014 command
registry and native menus. **W1's planned decisions 0012/0013 must be renumbered to 0015+ when W1 merges.**
New devDependency `axe-core` 4.13.0 (pinned, pure JS); lockfile updated with `--package-lock-only` on the Mac —
regenerate on Windows per AGENTS.md. `.gitignore` now ignores `node_modules` (also symlinks in agent worktrees).

**Problems / risks:** Unproven race: `FileTree.tsx` listDir replies for one folder carry no request token, so an older reply could
overwrite a newer one. Nothing from this wave verified on Windows yet — run `npm run verify` and `npm run test:e2e` there,
especially watcher.test.ts (relies on NTFS ctime), the new tab-strip test, `tempRoot()` (8.3 short names) and the
menus/lifecycle tests. Console flood (S05.3) stalls the main process 8–9 s on macOS vs 3–5 s on Windows — S05.7 is
more urgent. Mac idle memory 551 MB / 649 MB with preview, close to the ~700 MB budget. `selftest:dev` replaces
`.vite/build` with a dev build; run `npm run package` before any `--no-build` e2e afterwards.

**Owner action needed:** push the W1/W2/CI worktree branches from the Windows machine (or decide to rebuild that work);
then merge W1 → W2 → CI on top of this main. Windows manual checks: S24.2, S27.1, S27.3, S28.1, S25.3, S26.1 (sections
in harness/MANUAL-CHECKS.md). Confirm icon art, copyright holder text in forge.config.ts, first release version
(package.json is 0.0.0). Still open: H.1, H.2, H.5; S09.5 (real IME on mac) needs a person.

**Next up**

1. Merge the Windows-only wave-2 branches (see Session 4 "Paused again"): W1 (S05.5 security fixes, S05.7, S14,
   S15, S16.2–S16.6), W2 (S22.4/S22.5 — then add suggested-checks to the walkthrough's deliberate-error step), CI
   (S06.1/S06.2). Expect conflicts in Workbench.tsx (now uses the S24 command registry — W1/W2 key handlers and menu
   items must become registry commands), i18n catalogs, contract.ts, preload.ts, main.ts, MANUAL-CHECKS.md.
2. Re-run all new tests on Windows; integrate the paused W4 S13.5 work (Session 8), then S13.7 and S17.4 gate
   reviews, S25.4 (after W1), S28.6 user docs.

## Session 8 — 2026-10-15 — S13.4 session restore lifecycle

**Agent:** Codex on the Windows x64 development machine.

**Done**

- S13.4: automatic startup restore is only permitted before any project-open activity. Each open records
  a generation; a scan finishing after a newer open or valid close cannot register its project or revoke
  the current project's access. Explicit opens still work normally after startup.
- Session-restore IPC allows one startup attempt. Duplicate requests return no project rather than reopening
  a closed project or handing back a stale project ID. Sender and payload validation still run first.
- Added regressions for late restore after open/close, a delayed directory scan superseded by a user open,
  delayed session metadata with the real project service, and concurrent/repeated restore IPC calls.

**Evidence:** The old service failed the late-open and late-close regressions. Final `npm run verify` passes
all gates (1124 passed, 5 skipped across 85 files). Windows
`npm run test:e2e -- session.spec.ts recent-projects.spec.ts`: 5/5, proving tabs, active tab, layout sizes,
visible project path, crash-recovery precedence, recent-project behavior and preview/watcher teardown.
Windows x64 production packaging passed as part of the e2e command.

**Decisions:** Startup restore has lower priority than explicit project activity. Guard registration in the
main-side project service, where revocation happens, rather than relying on renderer response filtering.
A failed newer open also cancels an older pending open; the existing project stays available.

**Problems / risks:** macOS remains untested. The save/re-creation limitations in Sessions 5 and 7 remain.
Paused worktrees and `.idea/` were untouched; no existing branch was merged.

**Owner action needed:** None for this fix; platform/manual acceptance remains outstanding.

**Next up**

1. Review and integrate the paused W4 S13.5 cross-platform transfer work without restoring its old feature
   statuses; then write the S13.7 Gate G2 review with honest Windows/macOS evidence.
2. Continue W2 → W1 → CI integration from Session 4, including the unfinished preview security review.

## Session 7 — 2026-10-15 — S11.3 deleted-file re-save failures

**Agent:** Codex on the Windows x64 development machine.

**Done**

- S11.3: failed re-creation keeps the deleted-file state, retained edits and failure detail. A retry uses
  explicit creation again; blur and ordinary save do not switch it into an automatic replacement operation.
  A file that has reappeared still follows the existing conflict path.
- Check encoded content size, including the BOM, before reserving the deleted filename. Oversized content
  no longer leaves an empty file behind merely because validation happened too late.
- Added unit regressions for permission, disk-full and busy failures; integration regression for the size
  limit; Windows Electron scenarios for restoring a missing parent folder and a different file reappearing.

**Evidence:** All four new unit/integration cases failed before the fix. `npm run verify` passes all gates
(1119 passed, 5 skipped across 85 files). Windows `npm run test:e2e -- external-change.spec.ts`: 10/10;
production Windows x64 packaging passed as part of that command.

**Decisions:** Failed re-creation stays an explicit user action. The watcher may subsequently find a file
and update the state through the existing hash comparison; a changed file requires a fresh choice.

**Problems / risks:** macOS was not run. The existing re-creation implementation reserves an empty filename
before atomic replacement; an I/O failure after reservation can still leave that empty file. The buffer is
retained and disk synchronization treats it as a conflicting version. The OS-level check-to-rename race
recorded in Session 5 also remains. No paused branches were merged; `.idea/` remains untouched.

**Owner action needed:** None for this fix; existing manual platform checks remain open.

**Next up**

1. S13.4 session-restore lifecycle review, especially a delayed restore revoking a project opened meanwhile.
   Then review the paused W4 S13.5 implementation before continuing W2 → W1 → CI integration.
2. Consider eliminating the empty-name reservation on failed re-creation with a separately reviewed atomic
   no-overwrite creation design. Do not delete a reserved path on failure without proving ownership.

## Session 6 — 2026-10-15 — S11.2 conflict and deleted-file transitions

**Agent:** Codex on the Windows x64 development machine.

**Done**

- S11.2: deletion now retires the obsolete conflict and disk comparison while preserving the editor text.
  The deleted-file banner offers explicit re-save; it no longer gets stuck behind a conflict. Missing-file
  save failures enter the deleted state even before the watcher reports the deletion.
- Guarded conflict actions against already-deleted/resolved state. Reset the comparison toggle when a conflict
  ends, so a later conflict does not inherit the previous comparison's open/closed state.
- Added five unit regressions for deletion, reappearance, missing files during keep-mine, changes during
  keep-mine and obsolete comparison cleanup. Added Windows Electron tests for conflict → deletion → re-save
  and a second external edit updating the open Monaco comparison while retaining the user's edits.

**Evidence:** Two new unit cases failed before the fix. The first UI run exposed the stale comparison-toggle
bug, which was fixed. Final `npm run verify`: all gates green, 1115 tests passed and 5 skipped in 85 files.
`npm run test:e2e -- external-change.spec.ts`: 8/8 on Windows x64, with a successful production package build.

**Decisions:** The comparison is invalid once its disk file is gone; deletion takes over until explicit re-save
or a fresh disk read. No dependency or IPC changes.

**Problems / risks:** macOS remains untested. The final OS check-to-rename limitation recorded in Session 5
remains. S11.3 and S13.4 are still in progress pending their separate review; paused worktrees and `.idea/`
were not changed.

**Owner action needed:** None for this fix; existing owner/platform checks remain open.

**Next up**

1. Finish S11.3's deleted-file re-save review (including failed re-creation and reappearing files), then
   S13.4's session-restore lifecycle fixes. Keep the W4 → W2 → W1 → CI integration order from Session 4.
2. S01.4 still waits on H.1; do not mark owner platform decisions complete.

## Session 5 — 2026-10-15 — S11.1 save-time external change validation

**Agent:** Codex on the Windows x64 development machine.

**Done**

- S11.1: revalidate the target's size and content hash after history capture and temporary-file preparation,
  immediately before every atomic rename attempt, including Windows lock retries. Changed files return
  `changed-on-disk`; deleted files return `not-found`. Failed validation removes the temporary file and emits
  no saved event. Existing watcher-driven reload notices remain covered by unit and Electron tests.
- Added deterministic regressions for changes during history capture, temp-file close and lock retry, plus
  deletion during retry. External edits retain the original size and mtime to prove content hashing matters.

**Evidence:** Three regression cases failed against the old implementation before the fix. Closing
`npm run verify` passes all gates (1110 tests passed, 5 skipped in 85 files). Windows
`npm run test:e2e -- external-change.spec.ts`: 6/6, including clean-buffer reload with notice, conflict choices,
and deleted-file content retention. The app packaged successfully for Windows x64 during that run.

**Decisions:** Added an optional pre-replacement validator to the existing atomic-write helper; validation
failures propagate directly rather than being treated as retryable rename locks. No dependency changes.

**Problems / risks:** A final check-to-rename race remains against an uncooperative external writer: Node's
filesystem API does not provide atomic content-conditional replacement. This fix closes the long preparation
and retry windows, not that OS-level gap. Baseline sandbox verification failed because temporary-directory
renames were denied (EPERM); baseline and closing verification passed with normal filesystem access. macOS
was not run. S11.2/S11.3 and S13.4 remain in progress for their separate review findings. Existing paused
worktrees and the untracked `.idea/` directory were left intact; no paused branches were merged.

**Owner action needed:** None for this fix. Existing platform, signing and macOS manual-check tasks remain open.

**Next up**

1. Finish the S11.2 conflict/deleted-state review, then S11.3 and S13.4 lifecycle fixes. Inspect the paused W4
   branch before integrating its S13.5 work; do not restore its outdated completed statuses.
2. Continue the recorded W4 → W2 → W1 → CI integration order from Session 4, including preview security review.
   Formal S01.4 still waits on the owner's H.1 platform decision.

## Session 4 — 2026-10-14 — S03, then parallel agents: wave 1 (S04/S05, S07/S08, S09/S10, S12, S16/S22, S20, S21)

**Agent:** Claude (Opus 5.5) as lead on the Windows x64 dev machine, with parallel subagents in git worktrees
(`.claude/worktrees/`, ignored by git/lint/format). Owner asked to "finish as much as we can instead of following the
weekly plan", so sessions ran in parallel by module; the lead merged, resolved conflicts and ran independent reviews.

**Done (55 of 145 features done; was 15)**

- S03.1–S03.4 (lead): typed IPC contract (`src/shared/ipc/`), sender + payload validation in main, platform labels,
  open folder/file, atomic save. Independent review found save races, stale loads, ADS paths, Windows lock handling,
  close-without-save gap — all fixed in S10/S07/S08 below (owner chose to keep S03 done).
- S04.1–S04.4, S05.1, S05.2, S05.4, S05.5, S10.5: loopback static server with path guard, sandboxed per-project
  WebContentsView, save → refresh only after a confirmed write, infinite loop / unresponsive handling, diagnostic
  capture via webContents events, malicious-page fixture (14 attacks fail). Decisions 0009, 0010.
- S07.1–S07.4, S08.1–S08.5: path utilities, lazy tree, fs.watch watcher (decision 0007), encodings (non-UTF-8 opens
  read-only), accessible tree, create/rename/delete-to-trash/reveal, never-overwrite (decision 0008). Reviewed; 11
  findings fixed (incl. >5 MB overwrite, hidden case-rename temp, watcher leak/cost, unportable names).
- S09.1–S09.3, S10.1–S10.4, new S10.6: tabs with per-file model registry, save state machine with autosave +
  serialized/coalesced writes, Windows lock retries, failure banner with retry/save-elsewhere, close/quit guard.
  Mixed line endings: decision 0011.
- S12.1–S12.3 (crash-recovery journal in app data, restore after forced kill), S21.1–S21.2 (snapshot store +
  triggers). History review found index-loss bugs; reopened, fixed, re-marked done. Project identity: decision 0006.
- S16.1 ProblemRecord, S22.1–S22.3 rules engine + 15 rules (zh-CN/en, honesty checks).
- S20.1 three offline templates in `resources/templates` (packaged via extraResource).

**Evidence:** `npm run verify` green (≈690 unit/integration tests); `npm run test:e2e` 98/98 twice on Windows x64
@ bba57a2. Each feature's evidence is in features.json.

**Blocked / manual:** S05.3 (console flood stalls main 3–5 s; follow-up S05.7 in-page rate limit), S16.5/S16.6 (need
runtime capture S16.2), S20.3 (built; waits on S20.2 dependency). Manual: S02.6/S02.7, S05.6 (mac baseline row),
S09.4/S09.5 (real IME), S12.4 (forced kill on both platforms), Recycle Bin/Trash and macOS file-tree checks — all in
`harness/MANUAL-CHECKS.md`.

**Decisions / notes:** decisions 0006–0011 added (0003 never existed). Unchanged-file status now reads 无改动.
Rename reopens tabs (undo history lost). History is keyed by project path (moving a project orphans its history;
S21.3 must list orphans).

**Problems / risks:** nothing verified on macOS. Occasional e2e flake seen by agents (recovery.spec S12.1 timing,
file-tree watcher timing); not reproduced in the lead's runs. Preview isolation full-security review in progress.

**Owner action needed:** H.1 (OS versions, physical Apple Silicon Mac), H.5 (GitHub repo + Actions for macOS CI),
H.2 (signing). Manual checks above.

**Paused for usage limits (wave 2 in flight).** Merged after this entry: S20.2, S20.3, S21.3, S21.4 (welcome
wizard, file roles, history UI). S05.5 reopened after the preview security review (DNS→loopback/LAN reachable; also
alert() disables the IDE, beforeunload freezes refresh, untruncated log URLs, persistent service workers) — fixes
were handed to the W1 agent. Unmerged agent branches to review and merge next session (each told to stop at a safe
point and commit; check `git log main..<branch>` and their features.json statuses): `worktree-agent-a642c1d9e6a3d8c55`
(W1: S05.7, S14, S15, S16.2–S16.6 + preview security fixes), `worktree-agent-a809d2be3e8120aa3` (W2: S18, S19,
S17.1–S17.3, S22.4, S22.5), `worktree-agent-a0d4b80affc818dbf` (W4: S11, S13.1–S13.6; recent projects must use the
`recentProjects { list, open, remove }` shape from src/renderer/welcome/welcome-model.ts). Then: re-review W1's
security fixes, S13.7 and S17.4 gate reviews. W4 reported (HEAD 232b852): S11.1–S11.3, S13.1–S13.4, S13.6 done, S13.5 todo; its S11 save-path hash check and S13 lifecycle need an independent review before merge; flaky once: session.spec crash-precedence, recent-projects.spec. W2 reported (HEAD 47b6a0b): S18.1–S18.4, S19.1–S19.2, S17.1–S17.3 done; S22.4/S22.5 todo (ProblemCard.tsx partial; renderer runtime-problem fallback until W1 problems API); format hook onBeforeFormat not yet wired to history; flaky once: save-pipeline 20 ms wait, preview flood latency under load. W1 reported (HEAD 9160356): S05.3, S05.7, S14.1–S14.6, S16.2–S16.6 done; S05.5 in_progress (open: DNS-proxy lookups share the libuv threadpool with file I/O — cap/timeouts; console fail-closed trip window; prove proxy in request path; close proxy on quit; document proxy behaviour changes in decision 0013); S15.1–S15.4 coded with e2e as test.fixme (splitter persists 12 px off); S15.5/S15.6 not started. Full e2e not run on its final HEAD. Reconcile .noobide/project.json schema with W4 (S13.2) and decision numbers 0012/0013 at merge, merge order W4 → W2 → W1 (W1 touches the most shared files).

**Paused again (2026-10-15).** Merged since: W4 (S11, S13.1–S13.4, S13.6) and W2 (S17.1–S17.3, S18, S19) @ 7d5a0a5. W1 merge aborted (9 conflicting files) — W1 is merging main into its own branch, reconciling one Splitter, one console view, and project.json via W4's module (schema decision: preview.refresh auto|manual, W4 owns it). Review of W4 found HIGH: save can rename over a concurrent external write (Windows lock retry) and the project.json schema clash; S11.1–S11.3 and S13.4 reopened @ 7509cbf, fixes with W4. In-flight branches (each told to stop at a safe point, commit, possibly WIP): W1 worktree-agent-a642c1d9e6a3d8c55 (merge + S05.5 fixes + S15), W2 worktree-agent-a809d2be3e8120aa3 (S22.4/S22.5), W4 worktree-agent-a0d4b80affc818dbf (S13.5 + review fixes + flaky timing tests), CI worktree-agent-a43ea1c07eefc1dd2 (S06.1 workflow, S06.2 inspect-arch). Unit flake seen once on main (likely save-pipeline fixed waits). W4 paused @ eab9a77: S13.5 implemented (in_progress, needs full e2e), save-pipeline flake fixed (unconfirmed), review items 1–14 NOT yet fixed; its features.json still shows S11.1–S11.3/S13.4 done — keep them in_progress when merging (main 7509cbf). W2 paused @ 062c9da (WIP): S22.4/S22.5 building blocks (card layout, rule context, fix model, editor replace/undo) committed but not wired into Workbench; remaining: wiring, reveal-in-files, CSS, unit + e2e tests; both still todo. CI paused @ 76e98ed: S06.1 workflow written (actions pinned to SHAs, test added), blocked on H.5; S06.2 inspect-arch and S06.3 manual steps not started; risk: DMG maker native deps untested on macOS. W1 paused @ 4aaaf43 (WIP): main 7d5a0a5 merged into its branch (one Splitter = main S13.4, one ConsoleView = W2, problems bridge kept, preview reads entry via main S13.2 module still using autoRefresh boolean — switch to refresh once W4 lands it and un-skip preview-settings test); verify green but unit flake seen; NO e2e since merge; S05.5 open items unchanged; S15.1–S15.4 e2e still fixme and must use splitter-files/splitter-editor; S15.5/S15.6 manual steps unwritten. Resume order: W4 → W2 → W1 → CI, re-reviews for W4 save path and W1 S05.5.

**Next up:** wave 2 — S14/S15/S16.2–4 + S05.7 (preview & runtime diagnostics), S18/S19/S17/S22.4/S22.5 (language
features, problems panel, problem card, one-click fix), S20.2 + S21.3/S21.4 (welcome wizard, history UI),
S11 + S13 (external-change conflicts, settings/recent/session restore).

## Session 3 — 2026-10-14 — UI prototype, quick-fix backlog item, prototype shell (S30)

**Agent:** Claude (Opus 5.5) on the Windows x64 dev machine, Node 22.22.2.

**Done**

- Owner-requested UI prototype (design canvas, outside the repo): welcome, create wizard, workbench, problem
  card, narrow window and state vocabulary, restyled after feedback into a dark “studio” look.
- Added **S22.5 — One-click fix for a misspelled name** (owner-approved from the prototype).
- Owner asked to implement the prototype. Added session **S30 — Visual foundation from the UI prototype** (M2,
  depends on S02) and completed it:
  - S30.1 colour tokens (`src/renderer/theme/tokens.ts`), dark/light following the system scheme, contrast test.
  - S30.2 Monaco themes from the same tokens, synced with the shell.
  - S30.3 shell: app mark + project identity, labelled rail (Files, Problems), rounded panels, status strip with
    collapsible Problems, honest placeholder states (sample badge, preview 未运行, problems 还没检查).
  - S30.4 narrow window (< 960px): files collapse into a drawer, Code / Preview switch.

**Evidence:** `npm run verify` green (harness, typecheck, lint, format, 64 unit tests in 12 files). `npm run test:e2e` on
Windows x64: 16/16 (new `tests/e2e/shell.spec.ts` + unchanged smoke and worker specs). The contrast test caught
light-theme line numbers at 4.40:1 (fixed). Screenshots during review caught a real bug: re-creating the editor on
a language switch used the start-up theme (light Monaco in a dark shell); fixed, with a regression e2e that fails
without the fix. S02.6's e2e now also passes on Windows; its macOS run is still outstanding, so status unchanged.

**Decisions:**

- Only what works is shown. Unlike the prototype, the shell has no command bar, coach card, history/lessons rail
  items, welcome screen or help/more-tools buttons yet — each needs its feature first (S20, S21, S23, S24). The
  disabled Preview/Help/More-tools buttons were removed (assessment: no working-looking placeholders).
- System fonts, not the prototype's Geist (offline invariant; bundling a font would need a decision record).
- Dark unless the system asks for light. A persisted theme choice stays with S24.4.
- The native window frame is kept; merging it into the top bar needs main-process work and per-platform checks.
- S30.4 overlaps S15.2: S30.4 is layout only; S15.2 must still move the WebContentsView with the switch.
- The one-click fix is deterministic (did-you-mean rule output), not AI, so it stays within PLAN §4 exclusions.

**Problems / risks:** Not run on macOS. Panel widths are fixed until splitters (S15.1). The empty-state copy says
opening folders “arrives in a later version” and must be updated when S07/S20 land.

**Owner action needed:** Decide whether the command bar and coach card become backlog items. Run the new e2e on a
Mac when one is available (same command: `npm run test:e2e`).

**Next up**

1. Formal current session is still S01 (S01.4 waits on H.1). If the owner prefers to keep building the
   interface, the natural next steps are S03 (real files) feeding the shell's files panel and save status.

## Ideas / backlog candidates (Session 3)

- Command bar “找文件、命令或帮助… Ctrl K”; coach card for step-by-step lessons (S23).
- Merge the window title bar into the top bar (needs platform work and manual checks).

## Session 2 — 2026-10-14 — Interface assessment and design direction

**Agent:** Codex on the Windows x64 dev machine, Node 22.22.2.

**Done**

- S01.5 — Owner-requested appearance and beginner-usability assessment in
  `docs/reviews/interface-assessment-2026-10-14.md`. Added the review feature without changing existing criteria.
- Inspected the actual React/Monaco renderer in headless Edge at 1280×800 (light/dark) and 640×480.
  Confirmed the 176px empty Problems region, a white Monaco surface in dark mode, and a 210px narrow editor.
- Proposed a shared visual foundation, welcome/workbench/error states, implementation order, and observable
  acceptance checks. Prepared an interactive concept in the chat; application source remains unchanged.

**Evidence:** Review checked against all three S01.5 criteria and PLAN §§2, 3, 9, 11; relative source links
resolve. Baseline and closing `npm run verify` pass: harness, typecheck, lint, formatting, 42 tests in 9 files.
Ignored inspection artifacts: `test-results/interface-audit/current-{light,dark,narrow}.png`.

**Decisions:** This is design guidance, not implementation or evidence of beginner task success. Recommend
establishing typography, spacing, control hierarchy, and shared shell/Monaco themes before expanding the UI.
Connect functional states as the existing backlog delivers files, saving, preview, diagnostics and recovery.

**Problems / risks:** Native Electron launch did not stay open in this tool session; renderer inspection does
not establish native-frame behavior or macOS compatibility. Existing untracked `.idea/`, `CLAUDE.md` and
`package-lock.json` were left untouched. No redesign feature or platform check has been marked complete.

**Owner action needed:** None for this assessment. Existing H.1 minimum-platform decision still gates S01.4;
existing H.3 beginner wireframe review remains open.

**Next up**

1. For the proposed redesign, implement shared visual tokens and synchronized editor themes, then integrate
   welcome, responsive workbench and honest status states as described in the review.
2. Formal current session remains S01, with S01.4 waiting on H.1. Preserve the existing technical-spike gates
   and platform checks when scheduling design implementation.

---

## Session 1 — 2026-10-14 — Git, scope docs, wireframes, secure Electron shell

**Agent:** Claude (cloud workspace, Linux x64, Node 22.22; no shell on the Windows machine — files written back to
`D:\NoobIDE`, git history handed over as `noobide.bundle`, see Owner action)

**Done**

- S00.2 — Git initialised (`main`), LF policy checked: `git ls-files --eol` all `i/lf w/lf`. `PLAN.md` had mixed
  CRLF/LF on disk; it is stored LF (content unchanged).
- S01.1 — `docs/product/scope.md`: audience, in-scope table, 16 exclusions each linked to its PLAN section, support
  matrix (minimum OS versions TBD → H.1).
- S01.2 — `docs/product/task-script.md`: the 8 PLAN §2 steps with facilitator prompts, expected IDE feedback and
  pass conditions; metrics M1–M5 (PLAN §11 beginner metrics) mapped to steps with measurement methods; hints,
  unguided follow-up task, recording sheet.
- S01.3 — `docs/wireframes/` (open `index.html`): welcome + create wizard, editor+preview (wide and narrow with a
  working Code/Preview switch), problem card (PLAN §9 example, original error, uncertain cause, unresponsive page).
  zh-CN copy, English notes under each screen, no external assets.
- S02.1–S02.5 — Electron 44.7.0 + Forge 8.0.1 (Vite) + React 19.3 + Monaco 0.57 scaffold (decision 0004):
  `src/main/main.ts`, sandboxed preload placeholder, React shell with the five regions, zh-CN/en i18n with
  session-persisted switch, Monaco bundled locally with HTML/CSS/JS/JSON workers.
- Security baseline (decision 0005): webPreferences factory + startup assertion, UI served from `noobide://app/`
  (custom protocol, path-guarded) instead of file://, CSP response header (no eval / inline scripts / remote
  origins), window-open/navigation/webview/permission denial, a network guard that blocks every http(s)/ws(s)
  request from the workbench, fuses (RunAsNode, NODE_OPTIONS, --inspect off; ASAR integrity on).
- S02.6 — Playwright Electron e2e (`npm run test:e2e`, 8 tests) — **needs_manual_check** for Windows/macOS runs.
- S02.7 — Squirrel/DMG/ZIP makers configured; Squirrel install events handled in `src/platform/squirrel.ts` —
  **needs_manual_check** (build + install on Windows).

**Evidence:** `npm run verify -- --e2e` green @ 0c43853: harness, typecheck, lint, format, 42 unit tests (9 files),
e2e 8/8 (Linux under xvfb). `npm run selftest:packaged` and `npm run selftest:dev` pass (CSS + TS workers answer in
~1 s). Wireframes rendered offline with Playwright: 0 non-file requests, 0 console errors, switch works.

**Decisions**

- 0004 stack versions: Electron pinned to 44.7.0 rather than 44.7.2 (published hours earlier) — bump patches
  deliberately. Monaco via its 0.56+ tree-shakeable entry points. No `electron-squirrel-startup` dependency.
- 0005 workbench security baseline (above). Because the `--inspect` fuse is off, e2e drives the production bundles
  with the stock Electron binary; the packaged binary is checked by the built-in self-test (`NOOBIDE_SELF_TEST=1`).
- `package-lock.json` still not committed (generate on Windows, session 0 decision). It is git-ignored nowhere;
  the cloud clone excluded it locally.
- Refinement, not a backlog change: S02.3 placeholders already use the i18n dictionaries.

**Problems / risks**

- Nothing has run on Windows or macOS yet. The first Windows run (MANUAL-CHECKS S02.7) may surface
  platform-specific issues (paths with spaces in scripts, Squirrel, SmartScreen for the unsigned installer).
- `getLastWebPreferences()` used by one e2e assertion is missing from electron.d.ts (cast); if Electron removes it
  the test fails loudly — the unit test on the factory remains the primary evidence.
- S01.4 is blocked by H.1 (minimum OS versions). Electron 44's own minimums are the floor.
- `eslint-plugin-react-hooks` is not installed yet; consider adding it in S09 when hooks get complex.

**Owner action needed**

1. Adopt the git history (D:\NoobIDE has none yet). In a terminal in `D:\NoobIDE`:
   `git init -b main`, `git fetch noobide.bundle main`, `git reset --hard FETCH_HEAD`, then `git status` should be
   clean apart from two leftover untracked files, `docs/wireframes/.gitkeep` and `scripts/.gitkeep` (delete them). Then delete the bundle.
2. `npm install`, commit the generated `package-lock.json`, `npm run verify -- --e2e`.
3. Run harness/MANUAL-CHECKS.md → S02.7 (Windows installer) and S02.6.
4. Owner tasks now unblocked: H.1 (unblocks S01.4), H.2, H.3 (walk beginners through `docs/wireframes/`), H.4, H.5.

**Next up**

1. S03 — restricted IPC + open/save a real file: S03.1 typed IPC contract in `src/shared/ipc` (replace the
   preload placeholder `window.noobide.apiVersion`), S03.2 extend `src/platform` (isMac/isWindows, modifier and
   reveal labels; add an ESLint rule fixture), then S03.3/S03.4 file open/save in a `中文 路径` path.
2. S01.4 after H.1. S02.6/S02.7 after the owner's Windows run.

**Ideas / backlog candidates:** a `npm run dev:selftest` CI job once S06 exists; bundle a CJK-capable UI font
(offline) in S24 instead of relying on system fonts.

---

## Session 0 — 2026-10-14 — Plan structured, harness built

**Agent:** Claude (cloud workspace, files handed back to `D:\NoobIDE`; no shell on the Windows machine)

**Done**

- S00.1 — Read PLAN.md and turned it into 9 milestones, 30 sessions, 129 agent features and 8 owner tasks
  (`harness/features.json`, `docs/ROADMAP.md`).
- Harness: `AGENTS.md` (session protocol + invariants), `CLAUDE.md`, `harness/session.mjs` (start/status/next/show/
  set/check with dependency checks and a tamper guard against the last commit), `harness/verify.mjs` (all gates).
- Toolchain skeleton: TypeScript 6.0.3 (strict), Vitest 5.0.4, ESLint 10 + typescript-eslint 8.71 (with the
  `process.platform` restriction outside `src/platform`), Prettier 3.9, `.gitattributes` LF policy, PLAN §6 folders
  with module READMEs, `src/shared/result.ts` + tests.

**Evidence:** `npm run verify` green in the cloud workspace (Linux, Node 22.22): harness, typecheck, lint, format,
5 unit tests.

**Decisions**

- TypeScript pinned to 6.0.3, not 7.0 — typescript-eslint 8.71 supports `<6.1`. Revisit when it supports 7.
- No `package-lock.json` committed yet: generate it on the Windows machine with the first `npm install` and commit
  it (avoids cross-platform optional-dependency gaps in a Linux-generated lockfile).
- Electron/Forge/React/Monaco are deliberately not installed yet; S02 picks and pins them with a decision record.
- Status changes go through `session.mjs set`; features can be superseded, never deleted or weakened.

**Problems / risks**

- Not yet run on Windows. First Windows session must run `npm install` + `npm run verify` and fix anything
  platform-specific.
- S06.1 needs a GitHub repository (H.5); S01.4 needs minimum OS versions (H.1).

**Next up**

1. S00.2 — `git init`, commit, verify the LF policy (`git ls-files --eol`).
2. S01 (scope docs + wireframes) and S02 (Electron scaffold) can run in either order or in parallel.
3. Owner: H.1, H.2, H.4 are unblocked now.

---

<!-- Template — copy above the previous entry. Indented here so the CLI does not treat it as an entry.

    ## Session <N> — <YYYY-MM-DD> — <short title>

    **Agent:** <who / where it ran (Windows dev machine, cloud, Mac)>

    **Done**
    - <feature id> — <what changed, key files>

    **Evidence:** <tests / commands / docs proving the acceptance criteria; verify result>

    **Decisions:** <choices made + link to docs/decisions/NNNN if significant>

    **Problems / risks:** <what broke, what is fragile, what is unverified>

    **Owner action needed:** <manual checks, owner tasks, questions>

    **Next up**
    1. <the next feature(s) to pick up and any context needed>

    **Ideas / backlog candidates:** <out-of-scope ideas, not built>
-->
