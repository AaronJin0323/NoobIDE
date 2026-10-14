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
