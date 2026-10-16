# UI/UX assessment and refine plan — 2026-10-16

S47.1 · Owner request: "Assess the UI/UX of NoobIDE, make a refine plan." Follows the
[interface assessment of 2026-10-14](interface-assessment-2026-10-14.md) (visual foundation) and the S46
[calm design spec](../product/calm-design-spec.md) (tokens, surfaces, controls). This review takes the S46 look as
given and assesses what the restyle did not touch: structure, flows, wording and state communication, measured
against PLAN §2 (the ten-minute journey), §3 (interface), §7 (separate recovery mechanisms), §8 (preview) and §9
(error explanations).

## Method and evidence boundary

- **Seen:** the packaged Windows x64 build at `cfc3232` (main after S46), driven by a Playwright script through the
  real journey: welcome → create wizard → walkthrough → three files → a misspelled variable → Problems → menu →
  palette → History → AI panel → 900×620 and 640×480 windows → 1366×700 with Problems open; light and dark. The
  same screens are captured by `tests/e2e/glass-visual.spec.ts`. Screenshots prove layout, never behaviour.
- **Read:** every component under `src/renderer` by three read-only subagents (shell and first run; preview,
  problems, console, annotations; AI, history, recovery, walkthrough, settings) with file:line evidence, cross-checked
  against the merged tree by the lead. Line numbers below are as of `cfc3232`.
- **Not done:** no beginner tested this build (owner tasks H.3/H.6 are still open), and macOS was not run. Every
  "a beginner will…" below is a design judgement, to be confirmed by the H.6 study.
- **Nothing changed in the app.** This document and the backlog entries (M18, S47–S49) are the deliverable.

## What is good and must be kept

- **The journey exists end to end** and is honest: the wizard shows the exact folder and files before writing
  anything; the walkthrough only ticks a step when it detects the change and anchors each step to a real control
  with a plain "在哪里" line; the preview explains, once, that a refresh resets page state; History shows the diff
  and keeps the current version before restoring; failed saves keep the edits and explain the cause.
- **States are words plus icons, never colour alone**: save state, preview pill (incl. "预览未更新"), problem
  severity, annotation source, template selection ("✓ 已选择").
- **Problem cards teach**: plain title, "可以这样检查" list with the defining line, the original error word for
  word, a one-click fix when the rule is sure ("改成 greetButton").
- **Key features are visible** (owner rule, Session 23): Annotate, Save, Lessons, AI entry points, the file-role
  tags in the tree.
- **S46 calm surfaces**: warm neutrals, flat controls, one radius and type scale, frosted overlays only. This review
  does not reopen any of it; the plan below is enforced against `design-rules.test.ts` as well.

## Prioritised findings

Ordered by effect on the PLAN §11 metrics (time to first page, finishing the task, fixing an error, finding the
folder, recovering). P1 blocks or slows a step of the journey; P2 costs attention on every use; P3 is polish.

### P1

1. **The first run is a workbench with a welcome inside it, not a welcome.** The welcome card is confined to the
   editor column ([welcome.css](../../src/renderer/welcome/welcome.css)); beside it the files panel shows a second
   filled button, "打开文件夹…" ([FilesPanel.tsx:363-373](../../src/renderer/workbench/FilesPanel.tsx)), the preview
   column shows an empty stage, and "the sample is not saved" is said three times (top bar
   [zh-CN.ts:22](../../src/renderer/i18n/zh-CN.ts), tab badge, welcome note). A newcomer sees two primary actions
   and three empty regions before the one action PLAN §2 wants them to take.
2. **The top bar moves while you type.** Autosave fires after a 1 s pause
   ([save-controller.ts:34](../../src/renderer/workbench/save-controller.ts)). Each pause shows "未保存", inserts a
   32 px Save button ([TopBar.tsx:31-34](../../src/renderer/workbench/TopBar.tsx), `saveButtonShown`), shifts the
   save group, then "正在保存…", "已保存", and removes the button; every tab also widens and shrinks with its
   "未保存" label. PLAN §3 asks for stable positions; the window's one filled button should not flash on every
   sentence. The prominent Save button is right when saving cannot happen on its own (autosave off, failed, conflict,
   deleted) and wrong as a per-keystroke animation.
3. **The preview column spends up to six rows on chrome before the page.** Running, the header holds 预览, the state
   pill, 标注页面, 查看标注（0）, an icon-only open-in-browser, 刷新 (filled) and 停止; the toolbar adds 当前页面,
   入口页面, 保存后自动刷新, 桌面宽度/手机宽度/高级; then the reload note
   ([PreviewPane.tsx:478-635](../../src/renderer/workbench/PreviewPane.tsx)). At 1280×800 that is about 220 px
   before the page; with the AI panel open (preview 470 px wide) it wraps to six rows. Two of the controls say the
   same thing (当前页面 index.html next to 入口页面 index.html（默认）). The filled button is Refresh, which with
   auto-refresh on is the action a beginner needs least, and it disappears during every refresh
   ([preview-model.ts:66-73](../../src/renderer/workbench/preview-model.ts) `reload` only while `running`), while
   Annotate switches to its disabled look with the wrong reason "先启动预览再标注"
   ([annotations-model.ts:485-492](../../src/renderer/annotations/annotations-model.ts)). When the page hangs,
   the stage says "点停止", but Stop is the quiet button and nothing is primary.
4. **One mistake, three counts, two places.** A misspelled variable shows as a red "1 个错误" badge in the console
   with the raw `Uncaught ReferenceError`, as "问题 · 2 个错误" in the status strip (static + runtime), and as
   "代码检查 1" inside Problems. The console's `script.js:11` is not clickable
   ([ConsoleView.tsx:137](../../src/renderer/workbench/ConsoleView.tsx)) and nothing links the console line to the
   card that explains it. A beginner has to decide which of the three to believe before step 6 of the journey.
5. **The problem card puts buttons before the explanation, and AI before "Go to code".** Order today: head → fix
   button → "用 AI 修复" → "转到代码" → "显示原始错误" → "问 AI" → explanation → checks
   ([ProblemCard.tsx:95-171](../../src/renderer/problems/ProblemCard.tsx)). PLAN §9's card is location → explanation
   → checks → actions with Go to code first; AI is off the critical path. The open row also repeats its own head
   ("script.js:11 找不到变量…" twice).
6. **Recovery after a crash is the one dialog without a proper modal.** `RecoveryDialog` has no focus trap, Esc
   silently means "稍后处理", and "清除全部恢复数据" sits next to the exit
   ([RecoveryDialog.tsx:403-405, 575-585](../../src/renderer/recovery/RecoveryDialog.tsx)). PLAN §11 requires 9/10
   beginners to recover; this is the moment they are most anxious.

### P2

7. **Every feature has two or three names and entry points.** History: rail 历史, editor header 历史版本, menu
   本地历史…. Walkthrough: rail 课程 vs menu 入门导览, and the close hint still points at "更多操作 → 帮助：入门导览"
   ([zh-CN.ts:454](../../src/renderer/i18n/zh-CN.ts)). Problems: rail button and status-strip toggle. Inline AI edit
   is called "AI 编辑", "用 AI 修改代码", "用 AI 修改这段代码", "AI 修改代码" and "内联编辑"
   ([ai-edit.ts:7-10, 53](../../src/renderer/i18n/ai-edit.ts), [ai-settings.ts:53](../../src/renderer/i18n/ai-settings.ts));
   ghost text is "AI 建议 / AI 代码建议 / 自动补全"; the agent is "修改项目" in chat and "智能体" in Settings. About ten
   AI entry points share one sparkle icon whether they answer or change code.
8. **Two status bars and up to six bands around the editor.** The editor has its own bottom row (AI 编辑, 解释,
   indent, caret) above the global strip ([EditorPane.tsx:293-311](../../src/renderer/workbench/EditorPane.tsx));
   above the code, the role hint never collapses and can stack with open-error, save-error, disk, read-only and
   line-ending banners ([EditorPane.tsx:176-256](../../src/renderer/workbench/EditorPane.tsx)). Notices float over the
   tree and the editor's bottom-left at a fixed 420 px ([styles.css](../../src/renderer/styles.css) `.app-notice-stack`),
   the "reopened last project" notice appears on every launch though the top bar already shows the path, and F6
   skips the walkthrough band and the notice stack ([focus-regions.ts:6-14](../../src/renderer/commands/focus-regions.ts)).
9. **The top bar carries once-only or secondary things.** "English" is a permanent control; the full project path
   is a second line in the bar; there is no Help control (help items sit under ⋯ next to "打开日志文件夹") and no
   preview show/hide in a wide window, both listed by PLAN §3. The ⋯ sits beside the project name but holds theme,
   AI, help and logs.
10. **The walkthrough band is a quarter of the window.** Five text rows plus four buttons, at least 88 px and about
    250 px in practice at 1280×800, with no compact state between the full band and Close
    ([walkthrough.css](../../src/renderer/walkthrough/walkthrough.css)). Term chips show English only in zh-CN.
11. **History mixes four jobs in one 1100 px sheet**: AI turns above the file list, file → version → diff → restore,
    storage with "清除全部历史", and orphaned projects with a raw path
    ([HistoryDialog.tsx:334-592](../../src/renderer/history/HistoryDialog.tsx)). The task is "get back the version
    from before my change"; the rest belongs in settings.
12. **Dialogs and diffs do not share one shell.** Widths 420/560/640/760/1100; Close is a primary button at the
    bottom (AI settings), secondary at the bottom (glossary), quiet at the top (History) or absent (Recovery);
    confirms are Cancel→Confirm in History, Confirm→Cancel in Recovery, plain in saved chats; the agent and conflict
    views use Monaco side-by-side while inline edit, History and Recovery use a custom ± list, with Accept/Reject
    above the diff in one place and below in another ([InlineEditPanel.tsx:274](../../src/renderer/ai/InlineEditPanel.tsx),
    [ProposalReview.tsx:118-167](../../src/renderer/ai/ProposalReview.tsx)). In inline review, Esc throws the
    proposal away.
13. **The AI panel shows the full composer before AI is set up.** With no key, the panel explains and offers
    "打开 AI 设置", then still shows the context chips, three add buttons, the radio and the Send button. The
    Settings sheet is eight blocks with raw model ids and a daily token budget; focus lands on Close; a backdrop click
    loses a half-pasted key ([AiSettingsDialog.tsx:99, 191, 212-437](../../src/renderer/ai/AiSettingsDialog.tsx)).
14. **Jargon in normal flows** ("磁盘" in 23 strings, "token" after every answer, "CRLF 和 LF", "UTF-8",
    "服务商/模型/智能体", "会话 {session}" with an internal id, "代码 xyz" meaning error code, "单独的安全窗口" for an
    embedded view). The glossary lacks API key, token, model, undo and crash recovery.

### P3

15. Annotate shows the same count twice (badge + "查看标注（0）"); the three-way chooser opens away from its button;
    picking mode spends a row on "取消" alone.
16. "Open in browser" is icon-only in the preview header; "出错了" names no cause; the stage after Stop has no Start
    button; the consent stage's Start is a warning-coloured quiet button.
17. Rail mixes toggles (Files, Problems, AI show pressed) with launchers (History, Lessons) and shows no state for an
    open walkthrough.
18. Format is behind "编辑器选项 ⋯"; Delete closes a tab but trashes a file; the tab × is mouse-only with no hint.
19. Empty Problems sections always render with a "没有" line inside a 260 px panel; section badges ignore stale rows.
20. "空格：2 · 从文件识别" is permanently visible; "无改动" and "已保存" are two words for the same calm state.

## Design direction for the refinement

Three rules decide every item in the plan, in this order:

1. **One job per region, one primary per state.** The welcome owns the window until a project exists. The preview
   column has one filled button that matches its state (Start / Refresh / Stop-when-hung). The problem card has one
   primary (the fix, else Go to code). A dialog has one primary at the bottom right.
2. **Stable chrome.** Nothing in the top bar, the tab strip or the preview header changes size or position because
   the user typed, saved or refreshed. Transient states are shown in a fixed slot (text and icon), and buttons appear
   only when the user must act.
3. **One name per feature, everywhere.** A term table (below) is the source for zh-CN and en, enforced by a test on
   the catalogues, so menus, rail, palette, tooltips, lessons and the glossary agree.

| Feature                     | zh-CN                | en                      | Entry points kept                           |
| --------------------------- | -------------------- | ----------------------- | ------------------------------------------- |
| Local history               | 历史版本             | History                 | rail · editor header · palette              |
| Beginner lessons            | 课程                 | Lessons                 | rail · palette                              |
| Problems                    | 问题                 | Problems                | status strip toggle · rail · palette        |
| Ask AI (chat, no code edit) | 问 AI                | Ask AI                  | rail · problem card · annotations · palette |
| AI edit (changes code)      | AI 修改              | Edit with AI            | editor status row · context menu · palette  |
| AI fix (problem)            | AI 修复              | Fix with AI             | problem row and card                        |
| AI suggestions (ghost text) | AI 建议              | AI suggestions          | status row toggle · settings                |
| AI project changes (agent)  | 修改项目             | Change project          | chat mode                                   |
| Crash recovery              | 恢复上次未保存的修改 | Recover unsaved edits   | dialog on start only                        |
| External change             | 文件在外部被改动     | Changed outside NoobIDE | banner only                                 |

Non-goals, so later sessions do not reopen them: no key feature moves into a menu (owner rule 2026-10-16); AI off
still removes every AI surface (decision 0025); the S46 tokens and design rules stay; nothing floats over the native
preview (decision 0019).

## Refine plan (milestone M18, sessions S47–S49)

Each session is one worktree session with a green `npm run verify` and full e2e at the end. Features are registered
in `harness/features.json` with the acceptance criteria below; the ids are the plan.

### S47 — Frame and first run (P1 1, 2; P2 7, 8, 9, 10)

| Id    | Feature                     | Acceptance (summary)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S47.1 | This assessment and plan    | This document; findings cite source; plan registered as features (done)                                                                                                                                                                                                                                                                                                                                                                                                       |
| S47.2 | Welcome owns the window     | No project open: the welcome fills the editor + preview area, one filled button (创建我的第一个网页), 打开文件夹 secondary; the files panel empty state has no button; "the sample is not saved" appears once; the rail shows only Files until a project is open (Lessons is reachable from the welcome). e2e at 1280×800 and 640×480.                                                                                                                                        |
| S47.3 | Stable save state and tabs  | The save pill has a fixed-width slot; the Save button appears only for `failed`, `conflict`, `deleted` or autosave off; during a typing → autosave cycle no top-bar or tab element changes its bounding box (e2e measures before/after); tab dirty state is an icon with a tooltip; the pill words are short, the full sentence is in the banner.                                                                                                                             |
| S47.4 | One name, one home          | The term table above is encoded as a test over zh-CN and en; rail/menu/palette/tooltips/walkthrough hints agree; the ⋯ menu splits into a project menu (close, reveal, history, lessons) and a trailing 帮助/更多 menu (theme, language, AI, glossary, logs, settings); the top bar shows the path on hover and in the project menu, not as a line.                                                                                                                           |
| S47.5 | One status row, fewer bands | The editor's bottom row merges into the global status strip (AI edit, explain, suggestions toggle, indent, caret) with F6 reaching it; at most one persistent band above the code (role hint collapses to the tab tooltip after it was shown once per file, encoding/line endings move to the status strip); notices anchor above the strip, info notices auto-dismiss, the "reopened last project" notice is dropped; F6 includes the walkthrough band and the notice stack. |
| S47.6 | Compact walkthrough         | The band has a compact state (one line: step n/8 · title · 指给我看 · 下一步) toggled by the user and restored across starts; the full state stays for the current step's first view; term chips show "自动保存 autosave" in zh-CN; the band is ≤ 56 px when compact (e2e).                                                                                                                                                                                                   |

### S48 — Preview, problems and console (P1 3, 4, 5; P3 15, 16, 19)

| Id    | Feature                       | Acceptance (summary)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S48.1 | Two-row preview chrome        | Header: 预览 + state pill + the one filled action for the state (Start when stopped/failed, Refresh when running, Stop when unresponsive) + Stop/Refresh as quiet + Annotate + list toggle + labelled 在浏览器中打开. Toolbar: one 页面 control (entry picker only when >1 page or away from entry), 自动刷新, viewport segment, 高级 as a popover. ≤ 2 rows at ≥ 420 px pane width, no layout change on refresh (Refresh reads 正在刷新…, Annotate stays enabled); the stopped stage has a Start button (e2e). |
| S48.2 | Problem card in PLAN §9 order | Card: head → explanation → checks → actions (fix or 转到代码 first and the only primary, 显示原始错误, then one AI button) → original; the open row does not repeat its head; row-level AI button is quiet; empty sections hidden; badges count what is listed (unit + e2e).                                                                                                                                                                                                                                    |
| S48.3 | One error, one count          | A console error that matches a problem shows 查看说明 which opens that card; file:line in the console goes to the code; the console badge and the status strip count the same way (deduplicated), and the badge names Problems; IDE notices in the console are labelled "NoobIDE 提示" and styled apart; region label 问题 (e2e).                                                                                                                                                                               |
| S48.4 | Annotations tidy-up           | One count (badge only); click-to-pick is the default with 从列表选/框选 offered in the picking banner; Cancel inside the banner; the disabled Annotate shows its reason as text next to it; three-way chooser anchored to its button (unit + e2e).                                                                                                                                                                                                                                                              |

### S49 — AI, history, dialogs and wording (P1 6; P2 11, 12, 13, 14; P3 17, 18, 20)

| Id    | Feature                     | Acceptance (summary)                                                                                                                                                                                                                                                                                                                                                |
| ----- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S49.1 | One Sheet shell             | History, Recovery, AI settings, Glossary, confirms and the wizard use one shell: title, Close top-right, Esc, focus trap, Cancel → Primary order, danger style for destructive buttons, widths from {480, 720, 960}; Recovery traps focus, Esc keeps everything and says so, "clear all" moves to settings; backdrop click never discards typed input (unit + e2e). |
| S49.2 | History for restoring       | The dialog is file → version → diff → restore only; AI turns are a tag/filter on versions; storage and orphan cleanup move to a settings sheet reachable from the History footer and the ⋯ menu; width 960 (e2e history/ai-agent green).                                                                                                                            |
| S49.3 | One diff review             | Inline edit, agent proposals, conflicts, History and Recovery use one diff component with one legend; decision buttons sit above the diff; Esc in inline review returns focus to the editor and keeps the proposal; Reject is explicit (e2e ai-edit, ai-agent, external-change, history, recovery).                                                                 |
| S49.4 | AI set-up and composer      | Without a key the chat shows only the set-up card (service → paste key → test) and no composer; Settings shows the three-step connect first and folds models, budget and usage under 高级; the composer's add-context controls stay visible but the kind/mode choice is one control; usage is not shown per answer (settings only).                                 |
| S49.5 | Beginner wording pass       | The jargon list (磁盘, token, CRLF/LF, UTF-8, 服务商, 智能体, 内联编辑, 会话 id, 代码 xyz, 单独的安全窗口) is replaced in zh-CN and en with the words in this document's table; a test rejects the listed terms outside the glossary; the glossary gains API 密钥, token, 模型, 撤销, 崩溃恢复; "撤销" is reserved for Ctrl+Z (AI turn → 撤回, consent → 取消允许). |
| S49.6 | Rail and small controls     | Rail buttons show pressed only for toggles and current for launchers (Lessons shows state while the band is open); Format sits in the editor header; tab × is keyboard-reachable with a tooltip naming Delete; "无改动" and "已保存" become one word; indent source moves to the tooltip.                                                                           |
| S49.7 | Owner beginner walk-through | manual-win: the owner (or one beginner, H.3) runs the task script on the refined build; hesitations > 10 s recorded in docs/research/; any P1 that reappears becomes a new feature.                                                                                                                                                                                 |

### Order and dependencies

S47 before S48 (the status strip and name table are used by both); S48 before S49.2–S49.3 only where the diff
component touches History. S49.1 can start in parallel with S48 in its own worktree because it owns the dialog
files. Every session re-runs `tests/e2e/key-features-visible.spec.ts` and `glass-visual.spec.ts`; the before
screenshots for the owner are the ones taken for this assessment (reproducible with `glass-visual.spec.ts` at
`cfc3232`).

### What this plan does not do

- No new features (search, Git, terminal, publishing) and no change to the AI scope decided in 0025.
- No change to the S46 tokens or design rules; if an item needs a new token it is added to the spec first.
- No change to the preview isolation, static server or save pipeline; the chrome changes are renderer-only.
