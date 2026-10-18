# Installing and using NoobIDE (English)

[简体中文版](install.zh-CN.md) · [Release-notes template](release-notes-template.md) ·
[Acceptance checklist](acceptance.md)

<!--
Feature S28.6 (agent-check). English translation of install.zh-CN.md (the zh-CN page is the primary version; keep
both in step). Every statement was checked against the code and tests at the commit that adds this file.
Capabilities cite their feature ids (harness/features.json, status "done") in HTML comments. Only add a capability
together with a done feature that proves it (AGENTS.md, PLAN §4/§9); anything that depends on S28.4
(upgrade/uninstall) or S28.2/S28.3 (signing) stays marked as pending until done. S59.3 (2026-10-18, owner decision
H.2): the invite-only beta ships unsigned on both platforms; section 2 explains the first-launch steps and how to check
the download. Minimum OS versions: owner decision H.1 (2026-10-18), ADR 0003.
-->

> **Current status (read this first)**
>
> - This is an **invite-only beta**. Its installers are **not signed** on Mac or Windows (Apple notarisation and
>   Windows code signing come before the public beta). Your system warns on first launch. **For this beta that
>   warning is expected**; section 2 shows step by step what to do and how to check that your download is genuine.
> - The Windows installer and the first launch of a downloaded macOS DMG have not yet passed acceptance on a clean
>   computer (see the [acceptance checklist](acceptance.md)).
> - Upgrades keep your settings, recent projects and local history: tested with packaged builds on a Mac; the Windows
>   installer upgrade and uninstall still need a check on a real Windows computer (marked "Windows: being verified").
> - Supported systems: **macOS 13 Ventura or later** on Apple Silicon, **Windows 10 22H2 or later** (64-bit, x64).
> - The optional AI assistant (section 10) is tested against a simulated provider; a check with real Anthropic and
>   OpenAI keys is still pending.

## 1. System requirements

| Item           | Requirement                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Mac            | **Apple Silicon** (M1 or later), native arm64 app. Intel Macs are not supported; running under Rosetta is not supported |
| Windows        | **Windows x64** (64-bit Intel / AMD processor). Windows on Arm is not supported yet                                     |
| Minimum OS     | **macOS 13 Ventura** or later (Apple Silicon); **Windows 10 22H2** or later, or Windows 11 (x64)                        |
| Other software | No Node.js, Git or browser extension needed. NoobIDE brings everything it needs to run webpages                         |
| Network        | Not needed. Core features work fully offline (section 7)                                                                |

<!-- Apple Silicon arm64 only: S06.2 (needs_manual_check, arch inspection), S28.1 DMG arm64; Windows x64: S02.7
(needs_manual_check). No Node.js needed: Electron bundles Node (ADR 0004); clean-machine proof is S29.1/S29.2.
Minimums: owner decision H.1 2026-10-18, docs/decisions/0003-platform-support.md. -->

Linux, Intel Macs and Windows on Arm may be evaluated later.

## 2. Installing

### 2.1 Apple Silicon Mac

1. Download `NoobIDE-<version>-arm64.dmg`.
2. Double-click the DMG. Its window shows the NoobIDE icon and a shortcut to the Applications folder.
3. Drag **NoobIDE** onto **Applications**. When copying has finished, eject the DMG with the button next to it in the
   Finder sidebar.
4. Open NoobIDE from Launchpad or the Applications folder.

**First launch (unsigned beta build):** macOS refuses to open the app the first time and says Apple could not verify
it. **This is expected for the beta:** the build is not signed and notarised by Apple yet. It does not mean the file is
damaged. First [check the download](#23-checking-the-download), then:

_macOS 15 Sequoia and later (including the current macOS):_

1. Open NoobIDE once (double-click it in Applications). A message says "“NoobIDE” Not Opened". Click **Done**
   (**not** "Move to Trash").
2. Open **System Settings → Privacy & Security** and scroll down to the **Security** section. You will see a note that
   "NoobIDE" was blocked. Click **Open Anyway**.
3. A new message asks again; click **Open Anyway**, then confirm with your login password (or Touch ID).
4. NoobIDE opens. macOS remembers this and does not ask again for this copy of the app.

On macOS 15 and later, **right-click (Control-click) → Open no longer skips this check**: you must use System Settings
as above. If you do not see **Open Anyway**, try opening NoobIDE once more, then go back to Privacy & Security; the
button appears only for a while after a blocked attempt.

_macOS 13 Ventura and macOS 14 Sonoma:_ in Finder, open the Applications folder, **Control-click** (or right-click)
NoobIDE, choose **Open**, then click **Open** in the message. The System Settings route above works there too.

Only do this when the installer comes from NoobIDE's official release page and its SHA-256 matches. Do not remove the
system's security mark with Terminal commands. The exact wording differs slightly between macOS versions. Once signed
and notarised builds are released (S28.2), this step is normally no longer needed.

<!-- S59.3: unsigned beta (owner decision H.2, ADR 0027). The .app is ad-hoc signed as a whole after packaging
(forge.config.ts adHocSignMac, S28.4 / G3), so Gatekeeper shows the "Not Opened" / Open Anyway path rather than a
"damaged" message. Real first launch from a downloaded DMG: S29.2 (todo). -->

### 2.2 Windows x64

1. Download `NoobIDE-Setup.exe`.
2. Double-click it. Installing needs **no administrator rights**; it installs for the current user only and has no
   wizard pages: after a short installing animation NoobIDE opens by itself.
3. Start-menu and desktop shortcuts named **NoobIDE** are created. The program files live in `%LOCALAPPDATA%\NoobIDE`;
   this location cannot be changed.

**First run (unsigned beta build):** Windows shows a blue screen "Windows protected your PC" (Microsoft Defender
SmartScreen) and says the publisher is unknown. **This is expected for the beta:** the installer is not code-signed
yet. It does not mean the file contains a virus. First [check the download](#23-checking-the-download), then:

1. Click **More info** (the small link under the message text).
2. Check that the app name is **NoobIDE-Setup.exe** (the publisher shows as "Unknown publisher").
3. Click **Run anyway**. Installation starts as described above.

Your browser may also warn while downloading that the file "isn't commonly downloaded". In Microsoft Edge open the
**…** menu next to the download, choose **Keep**, then **Show more → Keep anyway**; other browsers have a similar
"Keep" choice. Only do this when the installer comes from NoobIDE's official release page and its SHA-256 matches.
Even signed builds may still see these warnings for a while right after a new version is released.

Under Settings → Apps → Installed apps, NoobIDE may show a generic icon for now. This does not affect anything.

<!-- Squirrel.Windows per-user install to %LOCALAPPDATA%\NoobIDE, shortcuts, no admin: ADR 0012 and
src/platform/squirrel.ts; real install on Windows still pending (S02.7 / S28.1 needs_manual_check). S59.3:
SmartScreen path for the unsigned beta (owner decision H.2, ADR 0027); clean-machine run: S29.1 (todo). -->

### 2.3 Checking the download

The release page lists a **SHA-256** value for every file: a long string of letters and numbers, like a fingerprint.
If the value you compute for your downloaded file is the same, the file is exactly the one we published and was not
damaged or changed on the way. Because the beta is not signed, please do this check before the first launch.

- **Windows:** open the Start menu, type `cmd` and open **Command Prompt**. Type the command below (if the file is
  elsewhere, use its folder instead of `%USERPROFILE%\Downloads`) and press Enter:

  ```bat
  certutil -hashfile "%USERPROFILE%\Downloads\NoobIDE-Setup.exe" SHA256
  ```

  Or, in **PowerShell**:

  ```powershell
  Get-FileHash "$env:USERPROFILE\Downloads\NoobIDE-Setup.exe" -Algorithm SHA256
  ```

- **Mac:** open **Terminal** (Applications → Utilities), type the command below with the exact file name you
  downloaded, and press Return:

  ```sh
  shasum -a 256 ~/Downloads/NoobIDE-<version>-arm64.dmg
  ```

Compare the result with the value on the release page. Upper and lower case do not matter (`certutil` prints lower
case, `Get-FileHash` upper case). If even one character differs, **do not open the file**: delete it, download it
again from the release page, and tell us if it still differs.

<!-- S59.3. The release page publishes the SHA-256 of each file (release-notes-template.md "Downloads" table). -->

## 3. First steps

- On the welcome screen click **Create my first webpage**, enter a name, pick a template (personal introduction,
  product showcase, button counter) and a location. The default location is `NoobIDE Projects` in your Documents
  folder (`NoobIDE 项目` when the interface is in Chinese). A project is an **ordinary folder** that any other editor or
  browser can open.
- To open an existing webpage folder, click **Open folder…**. For safety, scripts of a folder opened from your computer
  do not run until you click **Start preview** once; NoobIDE remembers that choice.
- The Help menu has the **Walkthrough** (restart or skip it at any time) and the **Glossary**.
- The interface follows your system language the first time: Chinese when the system is set to Chinese, English
  otherwise. You can change it any time under **Help → 中文 / English**; NoobIDE remembers your choice.

<!-- S20.1 templates, S20.2 wizard + default location (src/main/create-project-ipc.ts DEFAULT_LOCATION_NAMES),
S14.4 start-preview consent, S23.1–S23.4 walkthrough + glossary, S02.5 / S13.1 language persisted, S47.4 language
items in the Help menu, S59.2 first-run language from the OS (owner decision H.4, 2026-10-18). -->

## 4. What NoobIDE can do

Only features proven by automated tests or validation scenarios are listed.

**Projects and files**

- Create a project from three built-in templates; open ordinary folders; the welcome screen lists recent projects and
  marks folders that cannot be found.
- Paths with Chinese characters and spaces open, save and preview correctly.
- File tree: create, rename, delete (deleted files go to the system Trash / Recycle Bin). Existing files are never
  silently overwritten.
- "Show in Finder" (Mac) / "Show in File Explorer" (Windows).
- Reopens the last project, its open files and the layout next time.
- When a project is copied between Mac and Windows, names the other system cannot use and case conflicts are
  reported; nothing is renamed automatically.

<!-- S20.1, S20.2, S03.3, S13.3, S03.4, S08.1, S08.2, S08.3, S08.4, S08.5, S13.4, S13.5 -->

**Editing**

- Multiple tabs, syntax highlighting, indentation, comments, find and replace, undo and redo; switching files keeps
  the editing state.
- Zoom and light / dark theme, kept across restarts. Each file shows a one-line role (page structure / visual styling /
  interactive behaviour).
- Completion, hover information and **Format** for HTML, CSS and JavaScript. What exactly is validated is listed in
  [docs/capabilities.md](../capabilities.md).
- UTF-8 by default; a file's existing line endings are kept; non-UTF-8, binary and oversized files are never written
  over.

<!-- S09.1, S09.2, S09.3, S24.4, S20.3, S18.1–S18.4, S07.4 -->

**Saving and recovery**

- Saves automatically by default; Ctrl+S / ⌘S saves at once. The top bar shows "Unsaved / Saving… / Saved / Save
  failed" with text and an icon.
- When saving fails (read-only, file in use, disk full…), your edits stay in the editor and the cause is explained.
- Closing the window or quitting saves first; unsaved edits are never dropped.
- A change to the same file by another program is detected; on a conflict you see a comparison before choosing.
- After NoobIDE was forced to quit, the next start brings back unsaved edits (showing a comparison first).
- Local history: earlier versions of each file can be compared and restored, also for deleted files.

<!-- S10.1–S10.6, S11.1–S11.3, S12.1–S12.4, S21.1–S21.4 -->

**Preview**

- The preview beside the editor shows the real webpage: several files, relative paths, images, ES modules and
  reading JSON files from the project.
- Refreshes automatically after a successful save and a pause in typing, or only when you click Refresh. The entry
  page can be chosen.
- Refresh, Stop, Open in browser, desktop / mobile width (changes the width only; it does not emulate a phone),
  draggable dividers, and a Code / Preview switch in narrow windows. Experienced users can open the preview's
  developer tools.
- The page runs in a separate, restricted environment: an endless loop does not freeze the editor and Stop recovers
  it; floods of console output do not slow NoobIDE down; the page cannot read other files on your computer.
- Each project's page data (localStorage, cookies…) is kept separately and can be cleared.

<!-- S04.1–S04.4, S14.1–S14.6, S15.1–S15.4, S05.1, S05.2, S05.3, S05.5, S05.7 -->

**Finding and understanding errors**

- The Problems panel shows code-check problems, runtime errors, failed resources and console output separately,
  attributed to the right page load.
- A problem card shows the file, line, an explanation, what to check, **Go to code** and **Show original error**.
- 25 kinds of common problems are explained (for example a misspelled name, unbalanced brackets, an element that does
  not exist, a wrong script or image path, a misspelled CSS property, failed fetch, CORS, JSON parsing). When the
  cause is uncertain, the card says "may".
- A misspelled variable name can be fixed with one click (and undone).

<!-- S16.1–S16.6, S17.1–S17.3, S19.1, S19.2, S22.1–S22.5 -->

**Other**

- All key actions work from the keyboard; shortcuts are shown per platform (Ctrl / ⌘). State is never shown by colour
  alone.
- A local log (without your code); Help → Open logs folder.
- When the system protects folders such as Documents or Desktop and access is denied, the cause and the fix are
  explained.
- Works without a network connection (section 7).
- Optional AI assistant with your own Anthropic or OpenAI key: completions, explanations, edits and project changes
  you review as diffs (section 10).

<!-- S24.1, S24.3, S13.6, S25.3, S27.2; AI: S31–S35 (section 10) -->

**Not verified yet, not promised:** Chinese input methods on real devices, different display scaling and multiple
monitors, recovery after sleep and wake, final confirmation of each platform's menu and window conventions,
performance targets, signed installers, and upgrading or uninstalling with the Windows installer. They go into the
release notes once verified.

<!-- Not claimed: S09.4/S09.5 IME (needs_manual_check), S15.5/S15.6 DPI/monitors (needs_manual_check), S25.1/S25.2
sleep/wake (todo), S24.2 menus/window lifecycle (needs_manual_check), S25.4 preview permission prompts (todo),
S27.1/S27.3 performance (needs_manual_check), S28.2/S28.3 signing (todo), S28.4 Windows installer upgrade/uninstall
(needs_manual_check), S28.5 macOS upgrade of a signed DMG (todo). -->

## 5. Where your data lives

### 5.1 Your project folder gets at most one extra file

Your webpage files stay in the folder you chose; NoobIDE does not restructure them. The only file NoobIDE may write
into a project is `.noobide/project.json`, holding the entry page, the preview setting (automatic refresh on/off) and
a configuration version — **no absolute paths, no secrets**. Delete it and the project is still an ordinary website.

Caches, history, recovery data and logs are **never** written into the project folder.

<!-- S13.2 (tests/integration/project-config.test.ts), AGENTS.md invariant "Project folders stay ordinary". -->

### 5.2 The app-data folder

Everything else lives in NoobIDE's app-data folder:

| System  | Location                                                        | How to open it                                                                 |
| ------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Windows | `%APPDATA%\NoobIDE` (`C:\Users\<name>\AppData\Roaming\NoobIDE`) | Press Win+R, type `%APPDATA%\NoobIDE`, press Enter                             |
| macOS   | `~/Library/Application Support/NoobIDE`                         | Finder → Go → Go to Folder (⇧⌘G), type `~/Library/Application Support/NoobIDE` |

What it contains:

| Content                 | File / folder                                             | What it is                                                                                                                                                  | How to clear it                                                                                                 |
| ----------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Settings                | `settings.json`                                           | Interface language, theme, code font size, whether to reopen the last project. A damaged file is first backed up as `settings.corrupt-<time>.json`          | Quit NoobIDE and delete the file; the next start uses the defaults                                              |
| Recent projects         | `recent-projects.json`                                    | The list of project folder paths                                                                                                                            | "Remove from list" on the welcome screen (never deletes your files)                                             |
| Last working state      | `session.json`                                            | The last project, its tabs (relative paths) and the layout                                                                                                  | Quit and delete the file                                                                                        |
| Crash-recovery copies   | `recovery/`                                               | Temporary copies of unsaved edits, deleted after a successful save. Limits: 16 MB each, 256 MB in total                                                     | "Clear all recovery data" in the recovery dialog (those edits cannot be brought back)                           |
| Local history           | `history/`                                                | Earlier versions of files. Default limit 256 MB; above it the oldest versions are removed, the newest version of each file is always kept                   | "Clear this project's history" / "Clear all history" in the History window                                      |
| Logs                    | `logs/`                                                   | Run records, at most 5 files of 1 MB, **never containing your code**                                                                                        | Help → Open logs folder, then delete them                                                                       |
| Preview trust and notes | `preview.json`                                            | Which projects may preview without asking (stored as a hash of the path, not the path text), and notes already shown                                        | Quit and delete the file (opened folders then ask for Start preview again)                                      |
| Data your pages saved   | folders starting with `noobide-preview-` in `Partitions/` | One per project: the page's localStorage, IndexedDB, cookies and cache                                                                                      | Preview toolbar → Advanced → Clear preview data (current project only)                                          |
| Walkthrough progress    | `walkthrough.json`                                        | How far the walkthrough has got                                                                                                                             | Quit and delete the file                                                                                        |
| AI assistant            | `ai-keys.json`, `ai-config.json`, `ai-consent.json`       | Your API key (encrypted), AI on/off, provider and models, projects allowed to send code (as a hash of the path)                                             | AI Settings → Remove key / Revoke; or quit and delete the files (section 10.5)                                  |
| AI chats and usage      | `ai-chats\`, `ai-usage.json`                              | Saved AI chats, one folder per project (named by a hash of its path; questions and answers, which can quote code); token counts per day and the daily limit | AI panel → Past chats → Delete; or quit and delete them (section 10.5)                                          |
| AI drafts               | `ai-drafts\`                                              | Text you typed in the AI panel but did not send yet, and the items added to it (one file per project, named by a hash of its path)                          | Send or clear the text; deleting a project's saved chats also deletes its drafts; or quit and delete the folder |

There are also Electron's own cache folders (for example `Cache`, `GPUCache`, `Local Storage`); they hold none of your
project files.

Local history and recovery copies live only on this computer and are **not a backup**. Copy important projects to a
USB stick or cloud drive as well.

<!-- Paths: src/main/main.ts (app.getPath('userData') + settings.json, recent-projects.json, session.json, recovery/,
history/, logs/, preview.json, walkthrough.json); product name "NoobIDE" (package.json productName, no app.setName).
Limits: src/recovery/journal.ts DEFAULT_JOURNAL_LIMITS, docs/product/local-history.md, src/main/app-log.ts.
Preview partition: src/preview/preview-options.ts (persist:noobide-preview-<sha256>), Electron keeps persistent
partitions under <userData>/Partitions. Settings backup: src/main/json-file.ts. Features: S12.1, S12.3, S13.1,
S13.3, S13.4, S13.6, S14.4, S14.5, S21.4, S23.1. -->

## 6. Upgrading (manual)

NoobIDE does not update itself yet. To upgrade:

1. In NoobIDE make sure every file is saved (the top bar shows "Saved"), then quit completely (⌘Q on a Mac).
2. Recommended: copy the app-data folder above as a backup.
3. Install the new version:
   - **Mac:** open the new DMG, drag NoobIDE to Applications and choose "Replace".
   - **Windows:** run the new `NoobIDE-Setup.exe`; it replaces the old version in place.
4. Open NoobIDE and check the version under "About NoobIDE" (Mac: the NoobIDE menu; Windows: the Help menu).

Upgrading never touches your project folders. Settings, recent projects, the last working state, local history,
crash-recovery copies, preview trust and walkthrough progress live in the app-data folder (section 5.2). Every
version uses the same folder and installing a new version does not replace it, so **all of it is kept**: the new
version opens in your language, reopens your last project and shows its history and your recent projects. This was
tested on a Mac with two packaged versions; with the Windows installer it is **being verified** on a real Windows
computer.

Going back to an older version after a newer one is possible but not recommended. The older version uses what it
understands from the newer version's files and **never changes or deletes them**, so the newer version finds
everything again later. While the older version runs, settings you change are not saved (a notice says so), and
history or recovery copies written in a newer format are not shown.

<!-- S28.4 / ADR 0023: tests/integration/app-data-upgrade.test.ts (vN→vN+1, older schema, downgrade byte-for-byte),
tests/e2e/upgrade.spec.ts (packaged macOS vN→vN+1→vN on the default app-data folder: language, session, history,
recent projects). Windows installer upgrade: harness/MANUAL-CHECKS.md#S28.4 (needs_manual_check). Signed DMG upgrade
incl. Gatekeeper: S28.5 (todo). Settings notice for newer files: src/renderer/workbench/SettingsNotice.tsx. About:
S28.1. -->

## 7. Working offline

Without a network connection all of this works: creating a project from a template, editing and saving, preview
refresh, code checks and error explanations (including problem cards). The editor, fonts and language features are
bundled with the app. In the offline test NoobIDE itself tried to reach nothing outside the computer.

The optional AI assistant (section 10) needs a network connection; offline it says so and nothing else changes.

Only what **your webpage itself** requests from the internet needs a network — for example a library from a CDN, an
external image or a fetch to an internet address. Offline, those requests fail, and the Problems panel shows and
explains them.

<!-- S27.2 tests/e2e/offline.spec.ts (6 tests); S02.4 Monaco bundled; S18.1 language services offline. -->

## 8. Uninstalling

1. Quit NoobIDE.
2. Remove the app:
   - **Mac:** drag NoobIDE from Applications to the Trash.
   - **Windows:** Settings → Apps → Installed apps → NoobIDE → Uninstall.
3. Uninstalling **never** deletes your project folders.
4. Uninstalling removes the app and its shortcuts but **keeps the app-data folder** (section 5.2) on purpose, so
   your settings, history and unsaved-edit copies are not lost by accident and a reinstall continues where you left
   off. (Windows: verified on a real Windows computer is still pending.) To remove everything, quit NoobIDE and delete
   that folder by hand (section 5.2). This also deletes the local history and any edits not yet recovered.

<!-- ADR 0023: Squirrel uninstall deletes %LOCALAPPDATA%\NoobIDE (program files); the --squirrel-uninstall hook only
removes shortcuts and quits (src/platform/squirrel.ts runSquirrelAction, squirrel.test.ts). App data in
%APPDATA%\NoobIDE is kept. macOS drag-to-Trash never touches ~/Library/Application Support. Windows steps:
harness/MANUAL-CHECKS.md#S28.4. -->

## 9. When something goes wrong

- Help → **Open logs folder**, and attach the log files to your report. Logs contain no code, but they do contain the
  system and app versions.
- Include the NoobIDE version (from "About NoobIDE"), the system version, the computer model, what you did and what
  you saw.

## 10. The AI assistant (optional)

NoobIDE can use an AI model to complete code while you type, explain code and errors, change a selection on request,
and propose changes to your project. AI is **optional**: without a key, with AI switched off or without a network
connection, everything else in this guide works exactly the same.

### 10.1 Getting a key

NoobIDE has no account of its own. It connects with **your own API key** from one of two providers:

- **Anthropic (Claude):** sign in at <https://console.anthropic.com>, add a payment method or credit under Billing,
  then create a key under API keys (it starts with `sk-ant-`).
- **OpenAI:** sign in at <https://platform.openai.com>, add credit under Billing, then create a key under API keys
  (it starts with `sk-`).

Then in NoobIDE: Help → **AI Settings…** (or the command list). Choose the provider, paste the key, click **Save
key**, then **Test connection**. A key is shown only while you paste it; after saving it is never shown again.

### 10.2 Cost

**Usage is billed to your key's account** by Anthropic or OpenAI, at their prices; NoobIDE charges nothing. Answers in
the AI assistant panel show how many tokens they used. Inline completions send a small request after you pause typing
and are cancelled when you keep typing. To limit cost, set a monthly limit in the provider's console, choose a smaller
model per use in AI Settings → Models (completions default to a small, fast model), or switch completions off.

### 10.3 What is sent, and when you are asked

The first time you use AI in a project, NoobIDE asks once whether this project's code may be sent to the provider.
Nothing from the project is sent before you allow it, and you can **revoke** it any time in AI Settings → This
project. NoobIDE remembers the answer per project in its app-data folder (section 10.5), not in the project.

| What you use                                                              | What is sent                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completions (grey text while typing)                                      | Up to 4,000 characters before and 1,000 after the cursor of the current file. Not for files over 200,000 characters                                                           |
| AI assistant panel: questions, "Explain this code", "Ask AI" on a problem | Your question, the earlier messages of that conversation, and the context items listed above the input box (files, selection, problem). You can remove an item before sending |
| Edit with AI (Ctrl+I / ⌘I) and "Fix with AI"                              | Your instruction, the selected code with a few surrounding lines, or the problem and its file                                                                                 |
| "Change the project" (agent)                                              | Your request and the project files the assistant opens with its read tools (list, read, search), current problems and the preview console                                     |

The assistant **cannot** read files outside the project, hidden files (names starting with `.`, such as `.env`),
`.noobide` or `node_modules`, and it cannot run commands. Everything it wants to change is shown as a **diff that you
accept or reject** change by change; accepted changes are saved like your own edits (with local history, so a whole
turn can be undone from History). Text inside your files or the page console is treated as data, never as
instructions to the assistant.

### 10.4 Where the key is stored

The key is encrypted with your operating system's secure storage (macOS Keychain, Windows data protection) and kept
in `ai-keys.json` in the app-data folder. It stays in NoobIDE's background process: it is never shown in the window
again, never written to a log and never written into a project folder. If secure storage is not available, NoobIDE
does **not** save the key and AI stays off, with an explanation. **Remove key** in AI Settings deletes it.

### 10.5 Turning AI off

- AI Settings → switch off **Turn on AI features**: every AI button, panel and completion disappears.
- Switch off **Show AI completions while typing** to keep the panel but stop completions.
- **Revoke** in AI Settings → This project stops sending that project's code.

AI files in the app-data folder (section 5.2): `ai-keys.json` (encrypted key), `ai-config.json` (on/off, provider,
models), `ai-consent.json` (allowed projects, stored as a hash of the path), `ai-chats\` (saved chats, one folder per
project, never inside the project folder; at most 50 chats / 20 MB per project, the oldest are removed first) and
`ai-usage.json` (tokens used per day and provider, and the optional daily limit from AI Settings). Quit NoobIDE and
delete them to reset AI completely. Revoking a project's permission, or removing a missing project from the recent list,
offers to delete its saved chats.

### 10.6 Offline

Without a network connection the AI features cannot reach the provider: the panel and the edit box say so, and
completions simply do not appear. Nothing else changes. NoobIDE connects only to `api.anthropic.com` or
`api.openai.com`, and only when you use an AI feature or test a key.

**Status:** all AI features are tested automatically against a simulated provider. A run against the real Anthropic
and OpenAI services with real keys is still pending (owner check S36.1); until it has passed, treat the AI assistant
as a preview.

<!-- S31.1–S31.4 (providers, keys, consent, settings: tests/e2e/ai-settings.spec.ts, tests/integration/ai-service.test.ts),
S32.1 (tests/e2e/ai-inline.spec.ts; bounds src/renderer/ai/inline-context.ts), S33.1/S33.2 (tests/e2e/ai-chat.spec.ts),
S34.1/S34.2 (tests/integration/ai-agent.test.ts, tests/e2e/ai-agent.spec.ts; hidden-file rule src/ai/agent/tools.ts),
S35.1/S35.2 (tests/e2e/ai-edit.spec.ts). Files: src/main/app-data-layout.ts. Decision 0025. Live provider run:
npm run test:ai-live, harness/MANUAL-CHECKS.md#S36.1. -->
