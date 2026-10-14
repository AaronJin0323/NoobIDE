# The 10-minute beginner task script

- **Status:** draft (S01.2) · **Date:** 2026-10-14 · **Used by:** wireframe walkthroughs (H.3), onboarding (S23),
  user studies (H.6, H.7), release acceptance (S29)
- Source: [PLAN §2](../../PLAN.md) (journey) and [PLAN §11](../../PLAN.md) (metrics). Scope: [scope.md](scope.md).

## How to run a session

- **Participant:** ≤ 3 months of web experience, has not seen NoobIDE before (new people for each study, PLAN §11).
  Record platform (macOS arm64 / Windows x64), OS version, input method, screen size.
- **Setup:** freshly installed app, first launch, no project open, network **off** (offline acceptance, PLAN §11).
  Screen + audio recording on; a stopwatch or the recording's timestamps for timing.
- **Facilitator:** reads the participant card below aloud once, then stays silent except for the scripted prompts.
  Product help (walkthrough, tooltips, problem cards) is allowed; facilitator hints are not. If the participant is
  stuck for 2 minutes on one step, give the step's hint, mark the step **assisted**, and continue.
- **Think aloud:** ask the participant to say what they are looking for. Note every hesitation > 10 s with its
  timestamp and what they were looking at — these are the design findings (PLAN §11: studies find problems, they are
  not statistics).

### Participant card (read aloud; zh-CN version for Chinese participants)

> You are going to make your first webpage. Make a page that shows your name, change how it looks, make a button do
> something, fix a mistake, get back an older version of a file, and then close and reopen your work. There is no
> wrong way to do this — we are testing the app, not you.
>
> 你将制作你的第一个网页：让网页显示你的名字，改一改它的样式，让按钮做点事情，修复一个错误，找回文件的旧版本，最后关掉再重新打开你的项目。
> 怎么做都没有错——我们测试的是软件，不是你。

## The eight steps

Times are cumulative targets for a participant who does not get stuck; the whole run must fit in 10 minutes.

| #   | Step (PLAN §2)       | Participant prompt (facilitator says)                                                            | What the participant does                                                               | Expected IDE feedback (pass condition)                                                                                                                                                         | Observe / record                                                                  | Target  |
| --- | -------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------- |
| 1   | Create               | “Make your first webpage.”                                                                       | Clicks **创建我的第一个网页** (“Create my first webpage”), enters a name and location   | An ordinary folder is created at the chosen path (Chinese characters and spaces allowed); the template opens with `index.html` in the editor and the page already in the preview               | Time from first launch to page visible in preview (**M1**); location chosen       | ≤ 3:00  |
| 2   | Understand the files | “What are these three files for?”                                                                | Opens `index.html`, `style.css`, `script.js`                                            | Each file shows a short role hint: 页面结构 / 视觉样式 / 交互行为 (“Page structure / Visual styling / Interactive behavior”); real filenames are shown, not invented concepts                  | Can the participant say which file to edit for text, colour, behaviour?           | ≤ 3:45  |
| 3   | Change the structure | “Make the big heading show your name.”                                                           | Replaces the template heading text in `index.html`                                      | Status goes 未保存 → 正在保存 → 已保存 (text, not only colour); after the save succeeds the preview refreshes and shows the name                                                               | Did they wait for or press save? Did they notice the status?                      | ≤ 4:45  |
| 4   | Change the style     | “Change the heading’s colour or size.”                                                           | Edits a colour or `font-size` in `style.css`                                            | Colour swatch / completion appears while typing; after autosave the preview shows the new style                                                                                                | Did completion help or get in the way?                                            | ≤ 5:45  |
| 5   | Add interaction      | “Make the button show a different message when clicked.”                                         | Changes the string in `script.js`, clicks the button **in the preview**                 | Preview refreshes; clicking the button in the preview shows the new text; a one-time note explains that a refresh clears page state                                                            | Did they realise the preview is clickable?                                        | ≤ 6:45  |
| 6   | Handle an error      | “Now change the variable name in one place only, so it is misspelled, and see what happens.”     | Misspells a variable (e.g. `userName` → `userNmae`) in one usage                        | Problems badge shows a count + icon without stealing focus; the problem card shows file, line, explanation, suggested check, **转到代码** (Go to code), **显示原始错误** (Show original error) | Time from the error appearing to the fix saved (**M3**); did they use Go to code? | ≤ 8:00  |
| 7   | Recover              | “Get back the version of `index.html` from before you put your name in.”                         | Opens local history for `index.html`, picks the earlier version, restores               | A diff is shown before restoring; the current version is saved to history first; after restore the preview shows the old heading                                                               | Restored correctly? (**M5**) Which entry point did they find?                     | ≤ 9:00  |
| 8   | Continue             | “Close the app, open it again and carry on. Then show me where your project is on the computer.” | Quits, relaunches, reopens the project; then finds the folder in Finder / File Explorer | Recent projects lists the project; tabs and layout are restored; the project path is shown and **在访达中显示 / 在文件资源管理器中显示** opens it                                              | Found the real folder without a click path? (**M4**)                              | ≤ 10:00 |

**Hints for assisted steps** (only after 2 minutes stuck): 1 “Look at the welcome screen.” · 2 “Hover or look
above the editor.” · 3/4 “Look at the top bar.” · 5 “The page on the right is a real page.” · 6 “Look at the bottom
panel.” · 7 “Every file keeps older versions.” · 8 “Look at the project name at the top.”

### Unguided follow-up task (after the walkthrough, PLAN §2)

Without prompts per step: “Add a second paragraph about your hobby, make it a different colour, and make the button
also change that paragraph.” Pass = all three visible in the preview within 5 minutes. Record separately; it checks
understanding of the workflow, not discoverability.

## §11 beginner metrics → step and measurement

| Metric (PLAN §11)                  | Target                              | Step(s)   | Measurement method                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ----------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1** Time to first webpage       | Median ≤ 3 min                      | 1         | From the app’s first window appearing (installed app, first launch) to the template page rendered in the preview. Taken from recording timestamps. No facilitator guidance; assisted runs are reported but excluded from the median.                                                   |
| **M2** Complete beginner task      | ≥ 8/10 finish within 10 min         | 1–8       | Wall clock from first window to step 8 pass condition. Pass = every step’s pass condition met with product help only; any facilitator hint = not finished unassisted (record both).                                                                                                    |
| **M3** Error correction            | ≥ 8/10 succeed within 5 min         | 6         | From the problem first appearing in the IDE to a saved fix that clears it. Use comparable spelling **or** path errors (variant B: rename `script.js` reference to `scirpt.js`). Record failure reason category: did not notice / could not locate / misunderstood explanation / other. |
| **M4** Understanding file location | ≥ 8/10 find the real project folder | 8 (and 1) | Participant opens the actual project folder in Finder / File Explorer with no suggested click path. Pass = the OS file manager shows the folder containing `index.html`.                                                                                                               |
| **M5** Undo and recovery           | ≥ 9/10 restore the changed file     | 7         | Pass = `index.html` content on disk matches the chosen earlier version and the preview shows it. Recorded separately from editing success (PLAN §11).                                                                                                                                  |

Engineering metrics in PLAN §11 (cold start, save → preview, memory, data recovery, offline, native architecture,
platform consistency) are measured by S05, S26 and S27, not by this script. The script does run offline, so a
network-dependent failure here is also an offline-acceptance failure.

## Recording sheet (one row per participant)

| Participant | Platform / OS | Input method | M1 (mm:ss) | M2 done? (mm:ss) | M3 (mm:ss, reason) | M4  | M5  | Assisted steps | Hesitations > 10 s (step @ time: what) |
| ----------- | ------------- | ------------ | ---------- | ---------------- | ------------------ | --- | --- | -------------- | -------------------------------------- |
| P1          |               |              |            |                  |                    |     |     |                |                                        |

Report results **per platform** and combined (PLAN §11), and file findings in `docs/research/`.
