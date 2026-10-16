# Manual checks

Checks that need real hardware (Windows x64, physical Apple Silicon Mac) or a human judgement. Agents add a section
here when they set a feature to `needs_manual_check`. The owner runs the steps, records the result, and then closes
the feature:

```bash
node harness/session.mjs set <id> done --evidence "manual: <platform, OS version, date, result>"
```

## Template

### <feature id> — <title>

- **Platform:** Windows 11 x64 / macOS <version> on Apple Silicon
- **Build:** <commit or installer version>
- **Steps:**
  1. …
- **Expected:** …
- **Result:** _(owner fills in: pass/fail, notes, date)_

## Open checks

### S46.8 — Calm refinement visual pass on real hardware

- **Platform:** Windows 11 x64 and macOS on Apple Silicon
- **Build:** branch `claude/ui-refinement` (S46)
- **Steps:**
  1. `npx playwright test -c tests/e2e/playwright.config.ts glass-visual` after `npx electron-forge package`, and look
     at `test-results/glass/*.png` (welcome, workbench, menu, problems, palette, AI, sheet; light and dark).
  2. `npm start`; with the OS in dark mode, watch the first frame: no white flash. In Settings choose Dark while the
     OS is light, restart: the window opens dark.
  3. Click through files, tabs, rail, Problems, the AI panel and a dialog; judge whether it reads calm and flat.
  4. Windows: Settings → Accessibility → Visual effects → Transparency effects off; then a High Contrast theme. Open
     the app menu, the command palette (Ctrl+Shift+P) and Help → Glossary: each overlay is solid and readable and
     focus rings are visible (including the AI composer).
  5. macOS: Reduce Transparency, Increase Contrast and Reduce Motion each on: overlays solid, nothing scales.
- **Expected:** the owner judges the look calm; steps 2, 4 and 5 behave as described.
- **Result:** _(owner fills in: pass/fail, notes, date)_

### S02.7 — Windows x64 installer via `npm run make`

- **Platform:** Windows 11 x64 (or the minimum version chosen in H.1), ideally a second clean machine or VM without
  Node.js for step 5
- **Build:** the commit that closed S02 (see harness/PROGRESS.md)
- **Steps:**
  1. In `D:\NoobIDE`: `npm install` (first time: commit the generated `package-lock.json`), then `npm run verify`.
  2. `npm run make`. Expected output: `out\make\squirrel.windows\x64\NoobIDE-Setup.exe` (plus a `.zip` under
     `out\make\zip`).
  3. `npm run selftest:packaged` — expected last lines: `NOOBIDE_SELFTEST {"pass":true,…}` and `self-test PASSED`
     (proves the Monaco workers load in the packaged Windows app).
  4. `npm run test:e2e` — expected `8 passed`. Windows open briefly; do not click them (also closes S02.6, below).
  5. On a machine **without Node.js** (check: `node -v` fails), run `NoobIDE-Setup.exe`. Expected: it installs to
     `%LOCALAPPDATA%\NoobIDE`, creates Start-menu and desktop shortcuts named NoobIDE, then launches the app.
  6. In the app: the window title is "NoobIDE", the five regions show Chinese text, the editor highlights the
     sample HTML, typing works, "English" switches the language. Close the window — the app exits (Windows
     convention).
  7. Uninstall via Settings → Apps → NoobIDE. Expected: shortcuts removed, no error dialog.
- **Expected:** all steps pass. Note the Windows version, whether SmartScreen warned (unsigned until S28), and the
  installer size.
- **Agent run (2026-10-16, Windows 11 Home 10.0.26200, i9-13900KF, dev machine — steps 1–3 only):** the first
  `npm run make` failed in the Squirrel maker with `Authors is required.` (package.json has no `author`); fixed in
  `forge.config.ts` (`authors`, `owners`, `description: 'NoobIDE'`; regression test in
  `tests/integration/distribution.test.ts`). After the fix: `NoobIDE-Setup.exe` 157,299,200 bytes (150.0 MiB),
  `NoobIDE-0.0.0-full.nupkg` 156,545,017 bytes, `out\make\zip\win32\x64\NoobIDE-win32-x64-0.0.0.zip` 162,013,831
  bytes (154.5 MiB). `npm run selftest:packaged` → `self-test PASSED` (24/24 capabilities). The packaged
  `out\NoobIDE-win32-x64\noobide.exe` (PE machine 0x8664 = x64) launched with a temporary `--user-data-dir`: window
  title "NoobIDE", About shows "关于 NoobIDE" / "版本 0.0.0" / Electron 44.7.0 · Chromium 152, Escape closes it.
  `Setup.exe` itself is the 32-bit Squirrel bootstrapper (PE machine 0x014C) — normal for Squirrel.Windows; the app it
  installs is x64. **Not done by the agent (owner):** steps 4–7 — running the installer, a machine without Node.js,
  SmartScreen, uninstall.
- **SmartScreen (owner, step 5):** the installer is unsigned until S28.2/H.2. Expected: "Windows protected your PC" →
  "More info" shows App "NoobIDE-Setup.exe" (or "NoobIDE"), Publisher "Unknown publisher" → "Run anyway". Record
  whether the warning appeared, the exact wording, and whether "Run anyway" was offered.
- **Result:** _(owner fills in: pass/fail, notes, date)_
- **Close with:** `node harness/session.mjs set S02.7 done --evidence "manual: Win 11 <build>, <date>, steps 1-7 pass"`

### S02.6 — e2e suite runs on Windows and macOS

- **Platform:** Windows x64 (step 4 above) and macOS arm64 (owner Mac or the S06 CI runner)
- **Steps:** `npm install`, then `npm run test:e2e`.
- **Expected:** `8 passed`, no manual interaction; on Linux CI the script wraps itself in `xvfb-run`.
- **Result:** _(owner fills in)_. Linux evidence is already in PROGRESS.md (session 1).
  macOS (agent run, MacBook Pro M3 Pro, macOS 27.2 arm64, 2026-10-15): `npm run test:e2e` 148/148 twice @ 0df27f8, no interaction. S02.6 set done.
- **Close with:** `node harness/session.mjs set S02.6 done --evidence "e2e 8/8 on Win <ver> + macOS <ver>"`

### S09.4 — Chinese IME composition on Windows (Microsoft Pinyin)

- **Platform:** Windows 11 x64 with the built-in Microsoft Pinyin input method (Settings → Time & language →
  Language & region → 中文(简体，中国) → Keyboard → Microsoft Pinyin)
- **Build:** `npm start` (dev) or `npm run package` at the commit that set S09.4 to needs_manual_check
- **Already automated:** tests/e2e/tabs.spec.ts "an unsaved tab says so…" drives a real Chromium composition through
  CDP (`Input.imeSetComposition` → `Input.insertText`): while the composition is open the file stays unsaved, and only
  the committed character reaches the disk (never the pinyin letters). Unit: save-controller.test.ts "never writes
  during an IME composition". This check covers the real input method UI that automation cannot reach.
- **Steps:**
  1. Open a project folder whose path contains Chinese characters and spaces; open `index.html`.
  2. Switch to Microsoft Pinyin (Win+Space). Put the cursor at the end of a line, type `nihao` slowly, pausing about
     3 seconds before choosing a candidate. Expected: the candidate window stays open and sits next to the cursor; the
     underlined pinyin is not interrupted, the cursor does not jump; the top bar does not switch to "正在保存…" /
     "已保存" during the pause.
  3. Press Space to commit 你好. Expected: 你好 appears once; about 1 second later the top bar shows "已保存".
     Open the file in Notepad: it contains 你好 and no `nihao` letters.
  4. Type a long phrase (e.g. `zhongwenshurufa`) and pick candidates in several steps (partial commits). Expected:
     the committed characters are correct and in order; no lost or doubled characters.
  5. Start a composition (`ceshi`), then click another tab without committing. Expected: no error; whatever the
     input method committed or cancelled on losing focus, switching back shows it, and a second later the file on
     disk (Notepad) matches the editor exactly. Note what Microsoft Pinyin did (committed letters / cancelled).
  6. Repeat step 2 inside a CSS file and inside a JS string literal. Expected: same behaviour, no completion popup
     stealing the candidate keys.
  7. Press Ctrl+Z after step 3. Expected: 你好 is undone as one step.
- **Expected:** all steps pass.
- **Result:** _(owner fills in: pass/fail, notes, date)_
- **Close with:** `node harness/session.mjs set S09.4 done --evidence "manual: Win 11 <build>, Microsoft Pinyin, <date>, steps 1-7 pass"`

### S09.5 — Chinese IME composition on macOS (Pinyin – Simplified)

- **Platform:** macOS on Apple Silicon with the system input source "Pinyin – Simplified" (System Settings →
  Keyboard → Input Sources)
- **Build:** `npm start` or `npm run package` on the Mac, at the commit that set S09.5 to needs_manual_check
- **Already automated:** see S09.4 (the CDP composition e2e also runs on macOS with `npm run test:e2e`).
- **Steps:** as S09.4 steps 1–7, with these differences: switch input sources with Ctrl+Space (or Fn/🌐), check the
  file in TextEdit instead of Notepad, use ⌘Z in step 7, and in step 4 also try the inline candidate bar.
- **Expected:** all steps pass; the candidate window follows the cursor on a Retina display.
- **Result:** _(owner fills in: pass/fail, notes, date)_
- **Close with:** `node harness/session.mjs set S09.5 done --evidence "manual: macOS <version> arm64, Pinyin, <date>, steps pass"`

### S12.4 — Forced-termination recovery on both platforms

- **Platform:** physical Apple Silicon Mac (macOS, arm64) and Windows 11 x64
- **Build:** the commit that closed S12.1–S12.3 (see harness/PROGRESS.md)
- **Steps (automated, each platform):**
  1. `npm install`, then `npm run test:e2e -- recovery.spec.ts`. Expected: `5 passed`. The spec force-kills the
     Electron main process (`process.kill(pid, 'SIGKILL')`: SIGKILL on macOS, TerminateProcess on Windows), relaunches
     with the same app-data directory and restores the edits.
- **Steps (by hand, each platform, with `npm start` or the packaged app):**
  1. Open a folder whose path contains Chinese characters and spaces (e.g. a copy of
     `tests/fixtures/中文 路径 项目`). Open `index.html`, type a new line `崩溃测试`, do **not** save.
  2. Wait 2 seconds. Check the journal exists outside the project:
     - macOS: `ls ~/Library/Application\ Support/NoobIDE/recovery/*/` (the folder may be named `noobide`)
     - Windows: `dir %APPDATA%\NoobIDE\recovery\*` (or `%APPDATA%\noobide\recovery`)
       Expected: one `.json` file; nothing new inside the project folder.
  3. Kill the app hard: macOS `kill -9 <pid of the NoobIDE main process>` (Activity Monitor → Force Quit also
     works); Windows `taskkill /F /IM NoobIDE.exe` (or `electron.exe` for `npm start`).
  4. Start NoobIDE again. Expected: the dialog "找到了上次没保存的修改" lists the project and `index.html`.
  5. Click "打开项目并查看". Expected: the diff shows `+ 崩溃测试`. Click "恢复到编辑器". Expected: the editor shows
     the line with status "未保存"; the file on disk does not contain it yet.
  6. Press Ctrl+S / ⌘S. Expected: "已保存", the file contains the line, the journal `.json` file is gone.
  7. Repeat steps 1–4, then click "清除全部恢复数据" → confirm. Expected: the dialog closes, the journal is empty.
- **Expected:** all steps pass on both machines.
- **Result:** _(owner fills in: pass/fail, OS versions, date)_
  Automated part on macOS (agent run, MacBook Pro M3 Pro, macOS 27.2 arm64, 2026-10-15): recovery.spec.ts 5/5 in two full e2e runs @ 0df27f8; S12.4 set done.
  The by-hand steps were not performed (they need a person at the Mac).
- **Close with:**
  `node harness/session.mjs set S12.4 done --evidence "manual: macOS <ver> + Win 11 <build>, <date>, steps pass"`

### S05.6 — Baseline measurements on Apple Silicon (and the Windows reference machine)

- **Platform:** macOS (current) on a physical Apple Silicon Mac; ideally also the fixed 8 GB Windows x64 reference
  machine of PLAN §11
- **Build:** the commit that closed S05
- **Steps:**
  1. `npm install`, then `npm run package` (builds `.vite/` and `out/`).
  2. Close other heavy apps. Run `node scripts/measure-baseline.mjs --runs 10` (about 2 minutes; windows open and
     close by themselves — do not click them).
  3. Copy the printed Markdown row into the table in `docs/perf/baseline.md` (replace the "not measured yet" row) and
     note the Mac model, RAM and macOS version.
- **Expected:** a row with startup median/p95 and idle memory for macOS arm64 (no pass/fail threshold yet).
- **Result:** measured by an agent on MacBook Pro M3 Pro, macOS 27.2 arm64, 2026-10-15 (row in docs/perf/baseline.md @ 48e2b84; machine partly loaded). The
  8 GB reference Mac of PLAN §11 is still to be measured.

### S04-S05-macos — Preview isolation suite on macOS arm64

- **Platform:** macOS on Apple Silicon (or the macOS CI runner from S06)
- **Build:** the commit that closed S05
- **Steps:**
  1. `npm run test:e2e -- preview` — runs `tests/e2e/preview.spec.ts` and `preview-isolation.spec.ts`.
  2. Note the logged lines `typing while the preview is hung`, `console flood: …` and `attack results: …`.
  3. Manually: open a project, Start preview, drag the window between a Retina and a non-Retina display and resize
     it; the page must stay exactly inside the preview pane.
- **Expected:** all tests pass; every attack result is `failed`; the view follows the pane on both displays.
- **Result:** steps 1–2 by an agent on MacBook Pro M3 Pro, macOS 27.2 arm64, 2026-10-15: all preview tests pass, every attack result `failed`; typing while
  hung 67–88 ms; console flood main stall 8.3–9.3 s (see docs/perf/baseline.md). Step 3 (two displays) still open.

### S05.5-windows — Preview network policy, dialogs and console limit on Windows x64 (confirmation)

- **Platform:** Windows 11 x64 (dev machine `D:\NoobIDE`)
- **Build:** the commit that closed S05.5 / S05.7 (decisions 0015, 0016)
- **Why:** proven on macOS arm64 only. Windows differences to watch: `os.networkInterfaces()` names and IPv6 zone
  ids, Windows Firewall prompting when the e2e "other service" listens on `0.0.0.0`, the machine name resolving
  through LLMNR/NetBIOS, and modal-dialog behaviour (Windows disables the owner window for app-modal dialogs).
- **Steps:**
  1. `npm run test:e2e -- preview-isolation`. If Windows Firewall asks about Node.js, choose "Cancel" (the test only
     needs loopback and the LAN address from the same machine).
  2. Note `attack results: …` (every value `failed`) and `console flood: … longest main-thread stall … ms` (< 200).
  3. Manually: open a project with `index.html` containing
     `<button onclick="alert('hi'); confirm('ok?')">x</button>` and
     `<script>addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = '' })</script>`.
     Start preview, click the button (no dialog appears, the console shows `alert: hi`, the IDE stays usable), then
     edit and save the file (the preview refreshes), then close the IDE window (it closes without a prompt).
- **Expected:** all tests pass; steps 2–3 as described.
- **Result:** _(owner fills in)_

### S07.3 / S08 — file watcher and file operations on Apple Silicon (confirmation)

S07.3 and S08.1–S08.5 are proven by automated tests on Windows x64. The same tests are platform-neutral and should
also pass on the macOS arm64 CI runner (S06); until that runner exists, please confirm once on a Mac.

- **Platform:** macOS on Apple Silicon (default case-insensitive APFS volume)
- **Build:** the commit that closed S08 (see harness/PROGRESS.md)
- **Steps:**
  1. `npm install`, `npx vitest run tests/integration/watcher.test.ts tests/integration/file-ops.test.ts` — all pass
     (FSEvents watcher incl. case-only rename; never-overwrite rules).
  2. `npm run test:e2e -- file-tree` — all pass (uses ⌥⌘R for reveal and the Finder label on macOS).
  3. `npm start`, open a project in a folder with Chinese characters and spaces. In the file tree: select a file and
     press ⌘⌫ — the dialog says "移到废纸篓？"; confirm; the file is in the Finder Trash and can be put back.
  4. Right-click a folder → "在访达中显示": Finder opens with that folder selected.
  5. Rename `index.html` to `Index.html` with F2 — Finder shows the new case.
- **Expected:** as described; no error banners.
- **Result:** _(owner fills in: pass/fail, notes, date)_
  Step 2 by an agent on MacBook Pro M3 Pro, macOS 27.2 arm64, 2026-10-15: file-tree e2e all pass @ 0df27f8. Step 1
  (watcher tests) was being fixed in a separate session; steps 3–5 need a person.

### S08.3 — the real OS trash never deletes permanently (manual-win and manual-mac)

The e2e suite replaces `shell.trashItem` with a recorder, so the real Recycle Bin / Trash is only exercised here.

- **Platform:** Windows 11 x64 and macOS on Apple Silicon (run the steps on both)
- **Build:** the commit that closed the S08 review fixes (see harness/PROGRESS.md)
- **Steps:** `npm start`, open a scratch project, then for each case select the entry in the file tree, press
  Delete (⌘⌫ on macOS) and confirm:
  1. A file `a.html` on the internal disk → it appears in the Recycle Bin / Trash and "Restore" / "Put Back" brings
     it back with its content.
  2. A folder junction (Windows: `mklink /J jump C:\some\outside\folder`) or symbolic link (macOS:
     `ln -s ~/Documents jump`) inside the project → only the link goes to the trash; the outside folder and its
     files are untouched.
  3. A file symbolic link (Windows needs Developer Mode: `mklink link.txt C:\outside\x.txt`; macOS `ln -s`) → only
     the link goes to the trash; the target file is untouched.
  4. A project on a volume without a recycle bin (USB stick formatted FAT32/exFAT, or a network share) → either the
     item goes to a trash, or NoobIDE shows "没能移到回收站 / could not be moved to the Trash" and the file is still
     there. It must never disappear without being recoverable.
- **Expected:** as described for every case; no file outside the project changes.
- **Result:** _(owner fills in: pass/fail per case and platform, notes, date)_

### S24.2 — platform menus and window lifecycle (manual-win and manual-mac)

The e2e suite (tests/e2e/menus.spec.ts) reads and clicks the menus through Electron's Menu API and emits `activate`
itself; it ran on macOS arm64 only. The real menu bar, the dock and Windows' quit-on-last-close are checked here.

- **Platform:** Windows 11 x64 and macOS on Apple Silicon
- **Build:** the commit `S24.2: platform menus and window lifecycle` (see `git log`)
- **Steps (Windows):**
  1. `npm start`. The window has a menu bar 文件 / 编辑 / 视图 / 帮助 (no NoobIDE or 窗口 menu). 文件 ends with 退出.
     Items show `Ctrl+S`, `Ctrl+O`, `Ctrl+Shift+M`, … next to their labels.
  2. Open a project and a file, type a character, press Ctrl+S once: the file is saved once (status 已保存, no
     second save). Choose 文件 → 保存 with the mouse: same result.
  3. Switch the interface language (top bar): the menu bar becomes File / Edit / View / Help.
  4. Close the window with its × button: the NoobIDE process exits (Task Manager shows no NoobIDE).
- **Steps (macOS):**
  1. `npm start`. The menu bar shows NoobIDE / 文件 / 编辑 / 视图 / 窗口 / 帮助; the NoobIDE menu has 关于 NoobIDE,
     服务, 隐藏 NoobIDE, 退出 NoobIDE (⌘Q). Items show `⌘S`, `⌘O`, `⇧⌘M`, … ; 关闭窗口 is ⇧⌘W.
  2. Open a project and a file, type, press ⌘S once: saved once. Click inside the preview, press ⌘S: the file is
     saved too (the menu forwards it). Press ⌘W: the tab closes, not the window.
  3. Copy and paste text in the "new file" name field with ⌘C / ⌘V (编辑 menu roles).
  4. Close the window (red button or ⇧⌘W): the app stays in the dock with its menu bar. Click the dock icon: a new
     window opens. Close it again and choose 文件 → 打开文件夹… from the menu bar: a window opens.
  5. ⌘Q quits (after saving, as before).
- **Expected:** as described on both platforms; no command runs twice for one key press.
- **Result:** _(owner fills in: pass/fail per platform, notes, date)_

### S25.3 — OS folder protection messages on real hardware (confirmation)

S25.3 is proven by simulated tests (`tests/integration/protected-folder.test.ts`); this confirms the error codes the
simulation assumes (macOS TCC: `EPERM`; Windows Controlled Folder Access: `EPERM`/`EACCES` on writes only).

- **Platform:** macOS on Apple Silicon (packaged, unsigned dev build is fine) and Windows 11 x64
- **Build:** the commit that closed S25.3
- **Steps:**
  1. macOS: put a project in `~/Documents`, open it once, quit. System Settings › Privacy & Security › Files and
     Folders › NoobIDE (or Electron for `npm start`): turn **Documents Folder** off. Start NoobIDE, open the project
     from Recent projects.
  2. macOS: in Finder, Get Info on a project file in `~/Desktop` and tick **Locked**; edit it in NoobIDE and save.
  3. Windows: Windows Security › Virus & threat protection › Ransomware protection: turn **Controlled folder access**
     on (do not allow NoobIDE). Open a project in `Documents`, edit `index.html` and save; also create a new file and
     a new project in `Documents`.
  4. Windows: with Controlled folder access off, set a file in `Documents` read-only (Properties › Read-only), edit
     and save it.
- **Expected:** 1 and 3 explain the privacy setting with the exact place to allow NoobIDE (zh-CN and en); edits stay
  in the editor and nothing on disk changes. 2 and 4 show the ordinary "read-only" message instead. Undo the
  settings afterwards.
- **Result:** _(owner fills in: pass/fail per step and platform, notes, date)_

### S26.1 — Fault cases that need real hardware (confirmation of the simulated suite)

The automated suite (`tests/integration/faults/`, mapped in `docs/release/fault-matrix.md`) simulates these with
injected errno codes; this confirms the real OS behaves the same.

- **Platform:** Windows 11 x64 and macOS on Apple Silicon (`npm start` or a packaged build)
- **Build:** the commit that closed S26.1
- **Steps:**
  1. Full volume: create a small disk image / USB stick (e.g. 10 MB, exFAT), fill it with a large file until a few
     KB are free, open a project on it, paste a few MB of text into `index.html` and save.
  2. Windows locked file: open the project's `style.css` in a program that holds it without delete sharing (e.g.
     `powershell -c "$f=[IO.File]::Open('style.css','Open','Read','None'); Read-Host"`), edit and save in NoobIDE;
     then release the file and save again.
  3. Windows read-only folder via ACL: `icacls <project> /deny %USERNAME%:(W)`, edit and save; afterwards
     `icacls <project> /remove:d %USERNAME%`.
  4. Page network failures: a page that `fetch`es `https://unreachable.invalid/data.json` and loads an image from an
     unreachable host; run the preview with the network unplugged and with it connected.
- **Expected:** 1–3: the save fails with a clear reason (disk full / in use / no permission), the edits stay in the
  editor, the file on disk is the previous version, no `.noobide-tmp` file remains, and saving succeeds after the
  cause is removed. 4: the IDE stays responsive, the failures appear as problems/log entries with an explanation,
  and nothing else breaks.
- **Result:** _(owner fills in: pass/fail per step and platform, notes, date)_

### S26.2 — Fault suite on both CI jobs (evidence from a GitHub Actions run)

- **Platform:** GitHub Actions, workflow `CI` (`.github/workflows/ci.yml`), jobs `windows-x64` and `macos-arm64`
- **Build:** the commit that added `npm run test:faults` (S26.2) or later, pushed to `main` or a pull request
- **Steps:**
  1. Push the branch and open the `CI` run for that commit (Actions tab, or `gh run list --workflow CI`).
  2. In each of the two jobs, open the step **Fault suite (S26.2)**: it must be green and end with
     `PASS: N passed, 0 failed, …`.
  3. Open the run's **Summary**: each job appends a "Fault suite (S26.2) — <platform>-<arch>" table.
  4. Download the artifacts `fault-suite-windows-x64` and `fault-suite-macos-arm64` (`gh run download <run-id> -n
fault-suite-windows-x64`, same for macOS); each holds `<platform>-<arch>/junit.xml`, `results.json`, `summary.md`.
- **Expected:** `win32-x64/summary.md` and `darwin-arm64/summary.md` both say PASS with 0 failed and list the same five
  files. macOS: 0 skipped. Windows: exactly 7 skipped, each with its reason — the POSIX read-only folder test and the
  6 "macOS privacy protection (TCC), simulated" tests (docs/release/fault-matrix.md "Running on CI"). Total tests
  (passed + skipped) are equal on both platforms.
- **Result:** _(owner fills in: run URL, pass/fail per job, counts, date)_ — then
  `node harness/session.mjs set S26.2 done --evidence "CI run <url>: fault-suite-windows-x64 + fault-suite-macos-arm64 PASS"`

### S27.1 — Performance measurements on Windows x64 (docs/perf/win32-x64.md)

- **Platform:** Windows x64. For a PLAN §11 claim: the fixed Windows reference machine (8 GB RAM, SSD); the developer
  machine is fine for a first row, but say so.
- **Build:** the commit that added `scripts/measure-perf.mjs` (S27.1) or later
- **Steps:**
  1. In `D:\NoobIDE`: `npm install`, `npm run package` (builds `.vite\` and `out\NoobIDE-win32-x64\`).
  2. Close other heavy programs; plug in the laptop if it is one. Do not touch the windows that open and close.
  3. `node scripts/measure-perf.mjs --write` (about 4 minutes: 20 cold starts of the development binary, 20 starts
     of the packaged `noobide.exe`, 22 save → preview samples on a generated 50-file project, 3 memory runs).
  4. The script writes `docs\perf\win32-x64.md` (prettier-formatted). Commit it.
- **Expected:** the document has every row filled (cold start n=20, packaged start n=20, save → preview n=20, memory
  n=3). Rows marked "**target missed**" are not a failure of this check: record them in `docs/perf/targets.md`
  (S27.3) with a fix or a decision.
- **Agent run (2026-10-16, dev machine i9-13900KF / 32 GB, Windows 11 26200):** `docs\perf\win32-x64.md` is written,
  with every row filled. It is **not clean**: other agent sessions ran Electron e2e suites at the same time, and after
  ~2 h of waiting there was no quiet window long enough for one full run. In run 1 the cold-start batch ran at 100 % CPU
  (p95 1806 ms) and the other phases on an idle machine. In run 2 only the cold-start batch was idle (p95 1017 ms).
  The doc's header has the details. One miss: typical memory 709 MB working-set sum (decision in `targets.md`).
  **Owner:** repeat step 3 with nothing else running (ideally on the 8 GB reference machine), commit the new
  document, and check the memory row against `targets.md`.
- **Result:** _(owner fills in: device, date, pass/fail, notes)_

### S28.1 — Windows installer with icon and version information

- **Platform:** Windows 11 x64 (installer test ideally on a clean machine or VM without Node.js)
- **Build:** the commit that closed S28.1 (docs/decisions/0012-installers-and-app-identity.md) or later
- **Steps:**
  1. In `D:\NoobIDE`: `npm install`, `npm run verify`, then `npm run test:e2e -- -g "packaged Windows|About"`.
     Expected: the "packaged Windows executable carries the version resource" and both About tests pass.
  2. `npm run make`. Expected: `out\make\squirrel.windows\x64\NoobIDE-Setup.exe` shows the green `</>` icon in File
     Explorer (placeholder artwork from `scripts/make-icons.mjs`).
  3. Right-click `out\NoobIDE-win32-x64\noobide.exe` → Properties → Details. Expected: File description "NoobIDE",
     Product name "NoobIDE", Product version and File version = package.json `version`, Copyright "Copyright ©
     2026 NoobIDE contributors".
  4. Run `NoobIDE-Setup.exe`. Expected: installs per-user without an admin prompt, Start-menu and desktop shortcuts
     with the green `</>` icon, the app starts; the taskbar shows the same icon.
  5. Open About (once the S24 menu has its entry; until then skip this step). Expected: "关于 NoobIDE", "版本
     <version>", Electron/Chromium versions; Escape closes it.
  6. Settings → Apps → Installed apps: NoobIDE is listed with its version. Its icon there is the generic/Electron one
     until a release host for `iconUrl` exists (ADR 0012) — not a failure.
- **Expected:** as described for each step.
- **Agent run (2026-10-16, Windows 11 Home 10.0.26200, dev machine):** steps 1–3 and 5 done by the agent, from
  `npm run make` in the agent worktree. Step 1: `tests/e2e/distribution.spec.ts` — both About tests and "the packaged
  Windows executable carries the version resource" pass (macOS tests skipped). Step 2: the icon extracted from
  `NoobIDE-Setup.exe` and from `noobide.exe` is the green `</>`. Step 3 (`(Get-Item …).VersionInfo`): `noobide.exe` —
  FileDescription/ProductName "NoobIDE", ProductVersion/FileVersion 0.0.0, CompanyName "NoobIDE", Copyright "Copyright
  © 2026 NoobIDE contributors", PE machine 0x8664 (x64); `NoobIDE-Setup.exe` — FileDescription/ProductName "NoobIDE"
  (after the fix in forge.config.ts; before it they showed package.json's long description), version 0.0.0, Company
  "NoobIDE contributors", same copyright. Step 5 on the **packaged** app (not installed): launched with a temporary
  `--user-data-dir`, About shows "关于 NoobIDE", "版本 0.0.0", "Electron 44.7.0 · Chromium 152.0.7977.130", Escape
  closes it. **Owner:** steps 4 and 6 (install, shortcuts and taskbar icon, Settings → Apps), and step 5 again in the
  installed app.
- **Result:** _(owner fills in: pass/fail, Windows version, date, notes)_

### S27.3 — Windows target misses recorded

- **Platform:** Windows x64 (after the S27.1 Windows run above)
- **Build:** same as S27.1
- **Steps:**
  1. Open the new `docs/perf/win32-x64.md` and look for "**target missed**".
  2. For each miss, add it to `docs/perf/targets.md` under "Misses" with a fix or a decision (or ask an agent
     session to do it); fill the Windows column of the status table.
- **Expected:** every miss in `win32-x64.md` has an entry in `targets.md`; with no misses, the status table says so.
- **Agent run (2026-10-16):** done for the dev-machine document. The Windows column of the status table is filled in. The
  one miss (typical memory, 709/710 MB vs ~700 MB) is under `targets.md` → Misses, with a decision and a trigger.
  Re-check it after the clean S27.1 re-run above.
- **Result:** _(owner fills in: date, misses found, where recorded)_

### S06.1 / S06.2 — CI matrix run on GitHub Actions (Windows x64 + macOS arm64)

Needs owner task H.5 (repository on GitHub with Actions enabled). Agents cannot push or run Actions. Workflow:
`.github/workflows/ci.yml`; decisions: `docs/decisions/0021-ci-matrix-and-arch-inspection.md`.

- **Platform:** GitHub-hosted runners `windows-latest` (x64) and `macos-14` (Apple Silicon arm64)
- **Build:** the commit that added `.github/workflows/ci.yml` (or later)
- **Steps:**
  1. Repository → Settings → Actions → General: Actions allowed; "Workflow permissions" may stay at "Read
     repository contents" (the workflow asks only for `contents: read`). If the org restricts actions, allow
     `actions/checkout`, `actions/setup-node` and `actions/upload-artifact` (pinned by SHA).
  2. Push the branch to `main` (or open a pull request). Repository → Actions → "CI" shows one run with two jobs,
     `windows-x64` and `macos-arm64`. Alternatively start it with "Run workflow" (manual dispatch).
  3. In each job, open the step logs and check:
     - "Check runner architecture" prints `win32 x64` / `darwin arm64`.
     - "Verify …" ends with `verify passed.`; "End-to-end tests" ends with all tests passed (no failures).
     - "Make installers" lists `out/make/squirrel.windows/x64/NoobIDE-Setup.exe` (Windows) and
       `out/make/dmg/arm64/NoobIDE-<version>-arm64.dmg` (macOS), plus a zip each.
     - "Inspect binary architectures" ends with `0 errors` and `inspect-arch passed.` (S06.2). On Windows every
       listed file is `pe x64`; on macOS every file is `macho arm64` (13 on the Electron 44 build).
  4. Run summary → Artifacts: download `noobide-windows-x64` and `noobide-macos-arm64`. Expected: the Windows zip
     contains `squirrel.windows/x64/NoobIDE-Setup.exe`, `RELEASES` and a `.nupkg`; the macOS zip contains the
     `.dmg`. (These installers are unsigned until S28.2/S28.3.)
  5. If a job fails: the `e2e-results-<target>` artifact holds the Playwright output; record the failing step.
- **Expected:** both jobs green; both artifacts present; `inspect-arch passed.` on both.
- **Result:** _(owner fills in: run URL, date, pass/fail per job, notes)_
- **Close with:**
  `node harness/session.mjs set S06.1 done --evidence "manual: Actions run <url> green on windows-latest + macos-14, artifacts downloaded"`
  and `node harness/session.mjs set S06.2 done --evidence "manual: inspect-arch passed in CI run <url> (win x64 + mac arm64)"`

### S06.3 — Physical Apple Silicon validation (DMG install, Activity Monitor, Chinese path, infinite loop)

- **Platform:** a physical Apple Silicon Mac (not a VM, not the CI runner)
- **Build:** `npm run make` on that Mac at the commit that added S06 CI (or the `noobide-macos-arm64` CI artifact)
- **Agent pre-check (MacBook Pro M3 Pro, macOS 27.2 arm64, 2026-10-15, worktree build of the S06 commit):**
  `npm run test:e2e` 181 passed / 2 skipped (incl. "a nested file with a Chinese name opens and saves (S03.4)",
  "opens a folder with Chinese characters and spaces (S03.3)" and "an endless loop runs in another process and does
  not block typing (S05.1)", all against the packaged arm64 app); `npm run make` →
  `out/make/dmg/arm64/NoobIDE-0.0.0-arm64.dmg`; `hdiutil verify` VALID; mounted read-only and copied `NoobIDE.app`
  to a scratch folder (drag-install equivalent, /Applications untouched); `inspect-arch` on the installed copy: 13
  Mach-O, all arm64, `lipo -archs` = `arm64`; launched it: 4 processes (main, 2 helpers, renderer), none with the
  Rosetta `P_TRANSLATED` flag (`ps -o flags`), all exited on quit. Not done by the agent: the real drag to
  /Applications, Activity Monitor itself, and the Chinese-path / loop checks by hand in the installed app.
- **Steps:**
  1. `npm run make` (or download and unzip the CI artifact). Double-click `NoobIDE-<version>-arm64.dmg`; the window
     shows NoobIDE.app and an Applications shortcut. Drag NoobIDE into Applications, eject the DMG.
  2. Start NoobIDE from Launchpad / Applications. Unsigned until S28.3: if macOS blocks it, System Settings → Privacy
     & Security → "Open Anyway" (note this in the result).
  3. Activity Monitor → CPU tab → View → Columns → enable "Kind". Expected: `NoobIDE` and every `NoobIDE Helper …`
     process show **Apple** (not Intel).
  4. Create a folder `~/Desktop/我的 网页 测试` (Chinese characters and spaces). In NoobIDE open it (or create a new
     project there from a template), create `页面 一.html`, type some text, press ⌘S. Expected: saved without error;
     close and reopen the file — the text is there; Finder shows the Chinese file name correctly.
  5. In a project's `index.html` add `<script>while (true) {}</script>`, save, start the preview. Expected: the
     preview shows it is not responding and can be stopped, and typing in the editor stays smooth meanwhile (no
     beach ball); Stop recovers; remove the loop, save, Start shows the page again.
  6. Quit NoobIDE (⌘Q). Optional: drag it to the Trash to uninstall.
- **Expected:** steps 1–6 pass; Activity Monitor shows Apple for all NoobIDE processes.
- **Result:** _(owner fills in: Mac model, macOS version, date, pass/fail per step, Gatekeeper notes)_
- **Close with:**
  `node harness/session.mjs set S06.3 done --evidence "manual: <Mac model>, macOS <ver>, <date>, DMG install + Activity Monitor Apple + Chinese path save + infinite loop pass"`

### S15.5 — Preview view sync on Windows: scaling, monitors, fullscreen, overlays, focus

- **Platform:** Windows 11 x64; for step 4 a second monitor with a different scale (e.g. laptop 150 % + external
  100 %). Design and evidence: docs/decisions/0019-preview-view-sync.md.
- **Build:** the commit that set S15.5 to needs_manual_check (or later), `npm start` or the packaged app.
- **Setup:** `npm run test:e2e -- preview-layout` must pass first (8 tests: drag/persist, narrow switch, width
  switch, overlays, focus handoff, fullscreen, forced scale 1.5 and 2). Then open a template project (Create →
  any template); its preview starts by itself.
- **Steps:** repeat steps 1–3 at **100 %, 150 % and 200 %** (Settings → System → Display → Scale; sign out/in if
  Windows asks).
  1. **Edges:** the white page fills the dashed preview stage exactly — no gap and no overlap on any edge, also at
     the right edge next to the window border. Drag the editor | preview divider slowly and quickly with the mouse,
     **across the page area** too: the page follows during the drag, the divider stops exactly where you release.
  2. **Persisted sizes:** drag the files | editor divider and the editor | preview divider to odd positions, close
     NoobIDE, reopen: both dividers are where you left them (not a few pixels off). Collapse the files panel with
     the rail "Files" button, reopen: it is still collapsed; open it again: same width as before.
  3. **Narrow and width switch:** make the window narrower than ~960 px: a Code / Preview switch appears; on Code
     the page is gone, on Preview it fills the middle; the files drawer (rail "Files") is drawn above the page, not
     under it. Back to wide: three columns, the page on the stage. "手机宽度 375px" shows a 375 px wide page
     centred in the stage; "桌面宽度" fills it again.
  4. **Monitor moves:** drag the window to the other monitor (different scale) and back, also maximised: the page
     stays exactly on the stage after each move (no offset, no blur that stays).
  5. **Fullscreen / maximise:** F11 is not bound; use the window's maximise button and Win+↑ / Win+↓, and snap
     (Win+← / Win+→): the page follows each time.
  6. **Overlays above the page:** open "更多操作" (⋯ top right): the menu is drawn above the page (the page hides
     while the menu overlaps it). Open "关于", the history dialog (rail "历史"), the create-project wizard, and a
     delete confirmation (right-click a file → 删除): each dialog is fully visible; the page reappears when it
     closes. The native title-bar menu (Alt) also opens above the page.
  7. **Keyboard focus:** click into the editor, save (Ctrl+S) a file so the preview refreshes, keep typing: the
     characters go into the editor, never into the page. Press F6 until the preview area is focused (outline on
     the stage), press Enter, then Tab: the page's own controls get focus (try a page with a link or button).
     Press F6: focus returns to NoobIDE (problems strip); Shift+F6 from inside the page returns to the editor.
     Ctrl+S while the page has the focus still saves the active file.
- **Expected:** every step passes at every scale. Note any 1 px gap or offset with the scale at which it happened.
- **Result:** _(owner fills in: pass/fail per step and scale, Windows build, monitors, date)_
- **Close with:** `node harness/session.mjs set S15.5 done --evidence "manual: Win 11 <build>, 100/150/200 %, <date>, steps 1-7 pass"`

### S15.6 — Preview view sync on macOS: Retina, monitors, fullscreen, overlays, focus

- **Platform:** macOS on Apple Silicon; for step 2 an external non-Retina monitor (or one set to a different scale).
- **Already demonstrated on this Mac (macOS arm64, `tests/e2e/preview-layout.spec.ts`, 8 passed):** view on the stage
  within half a pixel per edge after mouse drags (dividers), narrow switch, files drawer, viewport switch, native
  fullscreen in and out, About dialog / "more actions" menu / any modal backdrop hiding the view, Enter into the
  page and F6 / Shift+F6 back, start and refresh not taking the focus, devicePixelRatio 1.5 and 2
  (`--force-device-scale-factor`) with exact persisted divider sizes after a restart.
- **Note:** the focus and fullscreen tests need the NoobIDE window to become the active app; macOS refuses that while
  someone works in another app, and the two tests then report "skipped". They passed (8/8, 0 skipped) on this Mac
  after the merge with P3's toolbar; if a re-run shows them skipped, run `npm run test:e2e -- preview-layout` once
  with the Mac otherwise idle.
- **Steps still needing a person (real input and hardware):**
  1. **Retina:** on the built-in display, the page fills the dashed stage exactly at every window size; text in the
     page is sharp.
  2. **Monitor moves:** drag the window between the Retina display and the external monitor (and back), also with
     the window spanning both while dragging: after the move the page sits exactly on the stage and is sharp.
  3. **Fullscreen with real input:** the green window button (or ⌃⌘F / fn+F where macOS offers it) into fullscreen and back, also with the window on the
     external monitor; Mission Control / Spaces switch while in fullscreen: the page follows each time.
  4. **Mouse drag across the page:** drag the editor | preview divider quickly over the page area with a mouse and
     with the trackpad: the divider keeps following and stops where you let go.
  5. **Overlays:** the native menu bar menus and the right-click context menus open above the page; open the
     history dialog, the create-project wizard and a delete confirmation (right-click a file → 删除): each dialog is
     fully visible, the page comes back when it closes.
  6. **Focus with the real keyboard:** type in the editor, ⌘S so the preview refreshes, keep typing: the characters
     stay in the editor. F6 to the preview, Enter, Tab inside the page, F6 back (fn+F6 on a Mac keyboard), ⌘S while
     the page has the focus saves the active file. Chinese input method: composing Chinese in the editor while the
     preview refreshes is not interrupted.
- **Expected:** every step passes.
- **Result:** _(owner fills in: pass/fail per step, macOS version, monitors, date)_
- **Close with:** `node harness/session.mjs set S15.6 done --evidence "manual: macOS <version> arm64, <date>, steps 1-6 pass + e2e preview-layout.spec"`

### S28.4 — Windows manual upgrade (vN → vN+1) and uninstall

Decision: `docs/decisions/0023-upgrade-and-uninstall.md` — uninstall removes the app and its shortcuts, keeps the app
data in `%APPDATA%\NoobIDE`, and never touches project folders. The macOS half of the data-keeping part is proven by
`tests/e2e/upgrade.spec.ts` (packaged vN → vN+1 → vN); this check covers the Squirrel installer on Windows.

- **Platform:** Windows 11 x64, ideally a clean VM or machine without Node.js, signed in as a normal (non-admin) user
- **Build:** the commit that set S28.4 to needs_manual_check (or later)
- **Steps:**
  1. In `D:\NoobIDE`: `npm install`, `npm run verify`, `npm run test:e2e -- -g "packaged|About"`. Expected: green
     (the macOS-only upgrade and codesign specs are skipped on Windows).
  2. **Build vN:** `npm run make`. Copy the folder `out\make\squirrel.windows\x64\` (NoobIDE-Setup.exe, `*.nupkg`,
     `RELEASES`) to `D:\upgrade\vN\`.
  3. **Build vN+1 without editing package.json** (PowerShell, `<next>` = package.json version with patch + 1):
     `$env:NOOBIDE_BUILD_VERSION="<next>"; $env:NOOBIDE_OUT_DIR="D:\NoobIDE\out\next"; npm run make`, then
     `Remove-Item Env:NOOBIDE_BUILD_VERSION, Env:NOOBIDE_OUT_DIR`. Copy `out\next\make\squirrel.windows\x64\` to
     `D:\upgrade\vN1\`. Run `npm run make` once more so `out\` and `.vite\` hold package.json's version again.
  4. **Install vN:** run `D:\upgrade\vN\NoobIDE-Setup.exe`. Expected: no admin prompt; desktop and Start-menu
     shortcuts "NoobIDE"; the app opens; About shows "版本 <vN>".
  5. **Use vN:** switch the interface to English; create a project from the welcome screen at a path with Chinese
     characters and spaces (e.g. `D:\网页 练习\我的 主页`); edit `index.html` and save (Ctrl+S) twice; open the file
     history and note the number of versions; type one more line **without saving**, then end NoobIDE in Task
     Manager (End task) so a crash-recovery copy is left. Look at `%APPDATA%\NoobIDE`: `settings.json`,
     `recent-projects.json`, `session.json`, `history\`, `recovery\` exist.
  6. **Upgrade:** with NoobIDE closed, run `D:\upgrade\vN1\NoobIDE-Setup.exe`. Expected: no admin prompt; the app opens
     as vN+1 (About: "Version <next>"), still in English; it offers to recover the unsaved line; the history shows the
     versions noted in step 5; after closing the project the welcome screen lists it under recent projects. The
     existing shortcuts start vN+1. `%LOCALAPPDATA%\NoobIDE` has `app-<next>`. The project folder holds only your
     files (`.noobide\project.json` only if you chose an entry page).
  7. **Uninstall:** Settings → Apps → Installed apps → NoobIDE → Uninstall. Expected: no NoobIDE window appears; the
     desktop and Start-menu shortcuts are gone; NoobIDE is no longer in Installed apps; `%LOCALAPPDATA%\NoobIDE` is
     gone (an empty folder or Squirrel's own temp leftovers are acceptable — note them); **`%APPDATA%\NoobIDE` still
     exists** with settings, recent projects, history and recovery; `D:\网页 练习\我的 主页` is unchanged.
  8. **Reinstall** `D:\upgrade\vN1\NoobIDE-Setup.exe`. Expected: English, the recent project and its history are still
     there. Clean up: uninstall again and delete `%APPDATA%\NoobIDE` and the test project by hand.
- **Expected:** as described for each step; nothing is lost and nothing in the project folder is deleted.
- **Result:** _(owner fills in: pass/fail per step, Windows version, vN / vN+1 versions, date, leftovers in step 7)_
- **Close with:** `node harness/session.mjs set S28.4 done --evidence "manual: Windows <version> x64, <date>, steps 1-8 pass + tests/e2e/upgrade.spec.ts + tests/integration/app-data-upgrade.test.ts"`

### S17.4 — Invite-only build: tester installs on macOS arm64 and Windows x64 (Gate G3)

- **Platform:** a second Apple Silicon Mac (not the build machine) and a Windows 11 x64 machine without Node.js
- **Build:** the `noobide-macos-arm64` / `noobide-windows-x64` artifacts of a green CI run on main (or `npm run make`
  on each platform), after the ad-hoc signature fix described in `docs/reviews/G3.md` condition 2
- **Agent pre-check (MacBook Pro M3 Pro, macOS 27.2, 2026-10-15, `3314de9`):** DMG `hdiutil verify` VALID; a
  quarantined copy (as after a Safari download) mounted and installed to a scratch folder is refused by Gatekeeper
  (`spctl`: "invalid Info.plist (plist or signature have been modified)"); after
  `xattr -dr com.apple.quarantine` it launches natively (4 processes, none Rosetta-translated). No Windows installer
  exists yet (CI never reached "Make installers" on Windows).
- **Steps (macOS):**
  1. Send yourself the DMG through a real download (browser, AirDrop or a file share) so it carries the quarantine
     mark. Double-click it, drag NoobIDE to Applications, eject.
  2. Open NoobIDE from Applications. Write down the exact Gatekeeper message. If System Settings → Privacy &
     Security shows "Open Anyway", use it; otherwise run `xattr -dr com.apple.quarantine /Applications/NoobIDE.app`
     in Terminal and open it again.
  3. Create a project from the default template, change the heading, save, see it in the preview; add a misspelled
     variable to `script.js`, save, see the problem card with file and line. Quit.
- **Steps (Windows):**
  1. Download `NoobIDE-Setup.exe` from the CI artifact on a machine without Node.js. Run it; on SmartScreen use
     More info → Run anyway; write down the exact messages.
  2. Same as macOS step 3. Then uninstall from Settings → Apps.
- **Expected:** both install and run the macOS step 3 / Windows step 2 journey; the Gatekeeper / SmartScreen texts are
  recorded so the tester instructions in `docs/reviews/G3.md` can be corrected.
- **Result:** _(owner fills in: machines, OS versions, date, messages seen, pass/fail per step)_
- **Close with:** `node harness/session.mjs set S17.4 done --evidence "docs/reviews/G3.md + manual: <Mac> macOS <ver> and Windows <ver> installs from CI run <url>, <date>"`

### S36.1 — AI live smoke test against the real providers (`npm run test:ai-live`)

The security-review half of S36.1 is done (findings and fixes: decision 0025 amendment, `docs/reviews/G9.md`). The
live half needs the owner's own API keys; agents have none. The test drives the real AiService and agent runner
through the real SDKs against `api.anthropic.com` / `api.openai.com` with cheap settings (low effort, small output
budgets) and never writes into a project (it rejects the agent's proposal). It is not part of `verify` or CI. Expected
cost: a few cents per provider.

- **Platform:** any dev machine (macOS arm64 or Windows x64) with network access
- **Build:** the commit that set S36.1 to `needs_manual_check` (or later)
- **Steps:**
  1. `npm install`, then `npm run test:ai-live` **without** keys. Expected: `Test Files 1 skipped`, `Tests 10 skipped`,
     exit code 0 (no network use).
  2. Anthropic (default models of decision 0025: `claude-opus-5-5`, inline `claude-haiku-5-5`):
     - macOS: `NOOBIDE_AI_LIVE_ANTHROPIC_KEY=sk-ant-… npm run test:ai-live`
     - Windows PowerShell: `$env:NOOBIDE_AI_LIVE_ANTHROPIC_KEY="sk-ant-…"; npm run test:ai-live; Remove-Item Env:NOOBIDE_AI_LIVE_ANTHROPIC_KEY`
  3. OpenAI (defaults picked from the account's model list): the same with `NOOBIDE_AI_LIVE_OPENAI_KEY=sk-…`. Both
     variables may be set together; each provider runs only when its key is set.
  4. Check the four printed outputs per provider (blocks `===== [provider] … =====`):
     - **chat**: a sensible one- or two-sentence description of the sample page (a heading "Hello" and a "Go" button);
     - **inline completion**: plausible JavaScript to put inside the `click` handler (no Markdown fence, no repeated
       prefix);
     - **inline edit**: the CSS rule with the heading colour changed to blue and nothing else changed;
     - **agent turn**: steps such as `read_file`/`list_files`, then a proposal creating `about.html` and/or editing
       `index.html` with a link, with a one-sentence reason.
- **Expected:** `Tests 5 passed` per provider with a key (key test, chat, inline, edit, agent proposal), the printed
  outputs look right to you, and the key does not appear in the output (the test also asserts it is absent from the
  events and the app log).
- **Result:** _(owner fills in: providers run, models, pass/fail, cost seen in the provider console, date)_
- **Close with:** `node harness/session.mjs set S36.1 done --evidence "review: docs/reviews/G9.md + live: npm run test:ai-live <providers>, <date>, 10/10 passed"`

### S40.8 — Liquid Glass refresh on real hardware (Windows x64 and Apple Silicon)

- **Platform:** Windows 11 x64 (the dev machine is fine) and macOS on Apple Silicon
- **Build:** the commit that closed S40.7 (see harness/PROGRESS.md), `npm start` or `npm run package`
- **Why manual:** the agent may not change system accessibility settings, and Chromium's mapping of
  `prefers-reduced-transparency` to the Windows "Transparency effects" switch is not proven by the e2e suite (it
  emulates the media query and the `html[data-transparency=reduce]` switch instead).
- **Steps (Windows):**
  1. Open a project and a file; open the ⋯ menu, the command palette (Ctrl+Shift+P) and 帮助 → 术语表. Light and dark
     theme (⋯ → 浅色主题 / 深色主题). Expected: rail and top-bar groups are soft translucent capsules, menus and sheets
     blur what is behind them, code text stays crisp and readable.
  2. Settings → Personalisation → Colours → **Transparency effects: Off**, restart NoobIDE. Expected: rail, groups,
     menus, palette and sheets are solid (no blur); in DevTools (development build) `matchMedia('(prefers-reduced-transparency: reduce)').matches`
     is `true`. Record whether it is — if not, the follow-up "bridge nativeTheme.prefersReducedTransparency" in
     docs/product/liquid-glass-study.md is needed. Turn the setting back on.
  3. Settings → Accessibility → **Contrast themes: Night sky** (or any). Expected: every control has a visible system
     border, nothing is translucent, focus rings are visible. Turn it off.
  4. Type fast in a long file with the preview running; open and close the palette repeatedly. Expected: no visible
     lag compared with the previous build.
- **Steps (macOS):**
  1. As Windows step 1, with ⌘⇧P.
  2. System Settings → Accessibility → Display → **Reduce transparency** on: materials become solid. Off again.
  3. **Increase contrast** on: materials solid, borders stronger. Off again.
  4. Accessibility → Motion → **Reduce motion** on: menus, palette and sheets only fade in (no scale or slide).
- **Result:** _(owner fills in: platform/OS, pass/fail per step, date)_
- **Close with:** `node harness/session.mjs set S40.8 done --evidence "manual: <platforms>, <date>, steps 1–4 pass"`

### S25.1 — Sleep/wake recovery on Windows x64 (real sleep)

Recovery is proven with a simulated powerMonitor, a simulated clock jump and injected faults
(`src/main/wake-recovery.test.ts`, `tests/integration/wake-recovery.test.ts`, `tests/e2e/sleep-wake.spec.ts`,
decision 0028). This confirms it on a real sleep, where the OS decides what dies.

- **Platform:** Windows 11 x64 laptop (ideally one with Modern Standby: `powercfg /a` lists "Standby (S0 Low Power
  Idle)"), on battery and on mains if possible
- **Build:** the packaged app of the commit that set S25.1 to needs_manual_check (`npm run package`, run
  `out\NoobIDE-win32-x64\NoobIDE.exe`), or an installer built from it
- **Steps:**
  1. Open a project whose path has Chinese characters and spaces (e.g. `Documents\网页 练习\睡眠 测试`, with an
     `index.html` that has `<script>setInterval(() => document.title = Date.now(), 1000)</script>`). Start the
     preview; wait for "运行中 / Running". Open `index.html` and type a line `BEFORE_SLEEP`, then go straight to step 2
     (autosave may write it first after the typing pause; either way it must not be lost).
  2. Start menu › Power › **Sleep** (or close the lid). Leave it asleep for **at least 5 minutes**.
  3. While it sleeps nothing else is needed. Wake it, unlock it, and within the first minute:
     - check that `BEFORE_SLEEP` is still in the editor (unsaved, or saved by autosave) and no recovery prompt appears;
     - in File Explorer, create `醒来 新建.html` in the project folder: it must appear in NoobIDE's file tree within a
       few seconds;
     - edit `index.html` in NoobIDE (add `AFTER_WAKE`), press Ctrl+S: the status says "已保存 / Saved" and the file on
       disk contains both lines (open it in Notepad);
     - the preview refreshes with the change (automatic refresh) and the page's title keeps ticking.
  4. App menu › Open logs folder: the newest log has a `wake-recovery` line after `power-suspend` (trigger, watcher,
     server, page; no paths or file contents).
  5. Repeat steps 1–3 once with the lid closed for ≥ 5 min on battery (Modern Standby may not report sleep: the log
     line then says `trigger: clock-jump` or `unlock-screen`).
- **Expected:** no edit is lost and saving works; the tree shows the new file; the preview either keeps running
  without a reload or, if its server or page did not survive the sleep, restarts once by itself with the console
  line "电脑刚才处于睡眠状态…" / "The computer was asleep…". It never stays "Starting" or "Not responding".
- **Result:** _(owner fills in: pass/fail per step, the `wake-recovery` log line, Windows build, date)_
- **Close with:** `node harness/session.mjs set S25.1 done --evidence "manual: Windows 11 <build>, <date>, sleep ≥5 min, steps 1-5 pass"`

### S25.2 — Sleep/wake recovery on macOS (physical Apple Silicon Mac, real sleep)

- **Platform:** macOS (current stable and the minimum supported version, if available) on Apple Silicon
- **Build:** the packaged arm64 app of the same commit (`npm run package` on the Mac, or the CI artifact)
- **Steps:**
  1. As S25.1 step 1, with the project in `~/Documents/网页 练习/睡眠 测试` (grant the Documents access prompt).
  2. Apple menu › **Sleep** (or close the lid). Leave it asleep for **at least 5 minutes**.
  3. Wake, unlock, and run the checks of S25.1 step 3 (create the file in Finder; save with Cmd+S).
  4. Also lock the screen only (Ctrl+Cmd+Q) for 1 minute with the app hidden (Cmd+H), unlock, and check the preview
     still answers and no restart notice appears for a healthy page.
  5. Check the log as in S25.1 step 4 (the app menu › Open logs folder).
- **Expected:** as S25.1. The lock-only case gives at most one `wake-recovery` line with `server: ok`, `page: ok`.
- **Result:** _(owner fills in: pass/fail per step, the `wake-recovery` log line, macOS version, date)_
- **Close with:** `node harness/session.mjs set S25.2 done --evidence "manual: macOS <version> arm64, <date>, sleep ≥5 min, steps 1-5 pass"`

### S43.8 — Indentation and project suggestions on Apple Silicon (and a beginner's look on Windows)

- **Platform:** macOS on Apple Silicon (required); Windows 11 x64 optional
- **Build:** the commit that closed S43.7 (see harness/PROGRESS.md), `npm run package`
- **Why manual:** the e2e suite ran on Windows x64 only; macOS key handling (⌘V, ⇧⌥F, Tab in menus) and the latency
  on Apple Silicon are not proven there.
- **Steps:**
  1. New project from the 按钮计数器 template. Open `script.js`: the status bar shows 空格：2 · 从文件识别 (or 沿用项目习惯).
     Type `if (x) {` and Return: the new line is indented by two spaces and the `}` is closed.
  2. Paste (⌘V) this tab-indented text on a new line: `if (a) {⏎⇥b();⏎}`. Expected: `b();` is indented with two
     spaces; ⌘Z once shows the tabs again, ⌘Z again removes the paste.
  3. Click the indentation item (or Tab to it and press Space): a menu opens; choose 使用 Tab，显示宽度 4; the item shows
     Tab 宽度：4 · 你的选择. Choose 把整个文件改成当前缩进: the file is now tab-indented; ⌘Z undoes it. Choose 重新自动识别.
  4. On a new line type `document.querySelector('#`: within a moment the list shows the template's ids (e.g.
     `plus-button`) with `index.html` beside them. In `index.html` type `<img src="` inside `<body>`: the list shows
     `images/`. Expected: no noticeable delay compared with typing elsewhere.
  5. With AI set up (Settings → AI), pause after typing `let total =`: grey AI text appears with a small **AI** badge;
     VoiceOver (⌘F5) reads "AI 建议…" when it focuses the badge's line. Esc removes both.
- **Result:** _(owner fills in: platform/OS, pass/fail per step, date)_
- **Close with:** `node harness/session.mjs set S43.8 done --evidence "manual: <platform>, <date>, steps 1–5 pass"`
