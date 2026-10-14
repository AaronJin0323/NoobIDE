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
- **Result:** _(owner fills in: pass/fail, notes, date)_
- **Close with:** `node harness/session.mjs set S02.7 done --evidence "manual: Win 11 <build>, <date>, steps 1-7 pass"`

### S02.6 — e2e suite runs on Windows and macOS

- **Platform:** Windows x64 (step 4 above) and macOS arm64 (owner Mac or the S06 CI runner)
- **Steps:** `npm install`, then `npm run test:e2e`.
- **Expected:** `8 passed`, no manual interaction; on Linux CI the script wraps itself in `xvfb-run`.
- **Result:** _(owner fills in)_. Linux evidence is already in PROGRESS.md (session 1).
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
- **Result:** _(owner fills in)_

### S04-S05-macos — Preview isolation suite on macOS arm64

- **Platform:** macOS on Apple Silicon (or the macOS CI runner from S06)
- **Build:** the commit that closed S05
- **Steps:**
  1. `npm run test:e2e -- preview` — runs `tests/e2e/preview.spec.ts` and `preview-isolation.spec.ts`.
  2. Note the logged lines `typing while the preview is hung`, `console flood: …` and `attack results: …`.
  3. Manually: open a project, Start preview, drag the window between a Retina and a non-Retina display and resize
     it; the page must stay exactly inside the preview pane.
- **Expected:** all tests pass; every attack result is `failed`; the view follows the pane on both displays.
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
