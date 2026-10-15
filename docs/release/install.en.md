# Installing and using NoobIDE (English)

[简体中文版](install.zh-CN.md) · [Release-notes template](release-notes-template.md) ·
[Acceptance checklist](acceptance.md)

<!--
Feature S28.6 (agent-check). English translation of install.zh-CN.md (the zh-CN page is the primary version; keep
both in step). Every statement was checked against the code and tests at the commit that adds this file.
Capabilities cite their feature ids (harness/features.json, status "done") in HTML comments. Only add a capability
together with a done feature that proves it (AGENTS.md, PLAN §4/§9); anything that depends on S28.4
(upgrade/uninstall), S28.2/S28.3 (signing) or H.1 (minimum OS versions) stays marked as pending until done.
-->

> **Current status (read this first)**
>
> - The installers are **not signed yet** (Apple notarisation and Windows code signing are being prepared). Your
>   system warns on first launch; see below for what to do.
> - The Windows installer and the first launch of a downloaded macOS DMG have not yet passed acceptance on a clean
>   computer (see the [acceptance checklist](acceptance.md)).
> - Whether upgrades keep all your data, and what uninstalling leaves behind, is still being verified (marked "to be
>   confirmed by S28.4").
> - The minimum supported OS versions are not decided yet (owner task H.1).

## 1. System requirements

| Item           | Requirement                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Mac            | **Apple Silicon** (M1 or later), native arm64 app. Intel Macs are not supported; running under Rosetta is not supported |
| Windows        | **Windows x64** (64-bit Intel / AMD processor). Windows on Arm is not supported yet                                     |
| Minimum OS     | **To be decided** (owner task H.1). It will be stated in the release notes                                              |
| Other software | No Node.js, Git or browser extension needed. NoobIDE brings everything it needs to run webpages                         |
| Network        | Not needed. Core features work fully offline (section 7)                                                                |

<!-- Apple Silicon arm64 only: S06.2 (needs_manual_check, arch inspection), S28.1 DMG arm64; Windows x64: S02.7
(needs_manual_check). No Node.js needed: Electron bundles Node (ADR 0004); clean-machine proof is S29.1/S29.2. -->

Linux, Intel Macs and Windows on Arm may be evaluated later.

## 2. Installing

### 2.1 Apple Silicon Mac

1. Download `NoobIDE-<version>-arm64.dmg`.
2. Double-click the DMG. Its window shows the NoobIDE icon and a shortcut to the Applications folder.
3. Drag **NoobIDE** onto **Applications**. When copying has finished, eject the DMG with the button next to it in the
   Finder sidebar.
4. Open NoobIDE from Launchpad or the Applications folder.

**First launch (unsigned build):** macOS says it cannot verify the developer and does not open the app. This is
because the build is not notarised by Apple yet; it does not mean the file is damaged. What to do:

1. Click "Done" in the message (**not** "Move to Trash").
2. Open **System Settings → Privacy & Security**, scroll down to "Security", find the note about NoobIDE and click
   **Open Anyway**.
3. Confirm "Open" once more; you may need to enter your login password. macOS does not ask again after that.

Only do this when the installer comes from NoobIDE's official release channel. Do not remove the system's security
mark with Terminal commands. The exact wording differs between macOS versions. Once signed and notarised builds are
released (S28.2), this step is normally no longer needed.

### 2.2 Windows x64

1. Download `NoobIDE-Setup.exe`.
2. Double-click it. Installing needs **no administrator rights**; it installs for the current user only and has no
   wizard pages: after a short installing animation NoobIDE opens by itself.
3. Start-menu and desktop shortcuts named **NoobIDE** are created. The program files live in `%LOCALAPPDATA%\NoobIDE`;
   this location cannot be changed.

**First run (unsigned build):** Windows may show a blue "Windows protected your PC" screen (SmartScreen). What to
do: click **More info**, check that the app is NoobIDE-Setup.exe, then click **Run anyway**. Only do this when the
installer comes from NoobIDE's official release channel. Even signed builds may still see this screen for a while
right after a new version is released.

Under Settings → Apps → Installed apps, NoobIDE may show a generic icon for now. This does not affect anything.

<!-- Squirrel.Windows per-user install to %LOCALAPPDATA%\NoobIDE, shortcuts, no admin: ADR 0012 and
src/platform/squirrel.ts; real install on Windows still pending (S02.7 / S28.1 needs_manual_check). -->

## 3. First steps

- On the welcome screen click **Create my first webpage**, enter a name, pick a template (personal introduction,
  product showcase, button counter) and a location. The default location is `NoobIDE Projects` in your Documents
  folder (`NoobIDE 项目` when the interface is in Chinese). A project is an **ordinary folder** that any other editor or
  browser can open.
- To open an existing webpage folder, click **Open folder…**. For safety, scripts of a folder opened from your computer
  do not run until you click **Start preview** once; NoobIDE remembers that choice.
- The Help menu has the **Walkthrough** (restart or skip it at any time) and the **Glossary**.
- The interface starts in Chinese; the **中文 / English** button in the top bar switches the language.

<!-- S20.1 templates, S20.2 wizard + default location (src/main/create-project-ipc.ts DEFAULT_LOCATION_NAMES),
S14.4 start-preview consent, S23.1–S23.4 walkthrough + glossary, S02.5 / S13.1 language persisted. -->

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
- 15 kinds of common problems are explained (for example a misspelled name, unbalanced brackets, an element that does
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

<!-- S24.1, S24.3, S13.6, S25.3, S27.2 -->

**Not verified yet, not promised:** Chinese input methods on real devices, different display scaling and multiple
monitors, recovery after sleep and wake, final confirmation of each platform's menu and window conventions,
performance targets, signed installers, and data surviving upgrades. They go into the release notes once verified.

<!-- Not claimed: S09.4/S09.5 IME (needs_manual_check), S15.5/S15.6 DPI/monitors (needs_manual_check), S25.1/S25.2
sleep/wake (todo), S24.2 menus/window lifecycle (needs_manual_check), S25.4 preview permission prompts (todo),
S27.1/S27.3 performance (needs_manual_check), S28.2/S28.3 signing (todo), S28.4/S28.5 upgrade (todo). -->

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

| Content                 | File / folder                                             | What it is                                                                                                                                         | How to clear it                                                                       |
| ----------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Settings                | `settings.json`                                           | Interface language, theme, code font size, whether to reopen the last project. A damaged file is first backed up as `settings.corrupt-<time>.json` | Quit NoobIDE and delete the file; the next start uses the defaults                    |
| Recent projects         | `recent-projects.json`                                    | The list of project folder paths                                                                                                                   | "Remove from list" on the welcome screen (never deletes your files)                   |
| Last working state      | `session.json`                                            | The last project, its tabs (relative paths) and the layout                                                                                         | Quit and delete the file                                                              |
| Crash-recovery copies   | `recovery/`                                               | Temporary copies of unsaved edits, deleted after a successful save. Limits: 16 MB each, 256 MB in total                                            | "Clear all recovery data" in the recovery dialog (those edits cannot be brought back) |
| Local history           | `history/`                                                | Earlier versions of files. Default limit 256 MB; above it the oldest versions are removed, the newest version of each file is always kept          | "Clear this project's history" / "Clear all history" in the History window            |
| Logs                    | `logs/`                                                   | Run records, at most 5 files of 1 MB, **never containing your code**                                                                               | Help → Open logs folder, then delete them                                             |
| Preview trust and notes | `preview.json`                                            | Which projects may preview without asking (stored as a hash of the path, not the path text), and notes already shown                               | Quit and delete the file (opened folders then ask for Start preview again)            |
| Data your pages saved   | folders starting with `noobide-preview-` in `Partitions/` | One per project: the page's localStorage, IndexedDB, cookies and cache                                                                             | Preview toolbar → Advanced → Clear preview data (current project only)                |
| Walkthrough progress    | `walkthrough.json`                                        | How far the walkthrough has got                                                                                                                    | Quit and delete the file                                                              |

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

Upgrading never touches your project folders. Settings, recent projects and local history live in the app-data
folder, which installing a new version does not replace; **whether all of it survives an upgrade is still being
verified (to be confirmed by S28.4 / S28.5)**.

Do not go back from a newer version to an older one: an older version that cannot read a settings file written by a
newer one backs it up and uses the defaults; a history index written by a newer version is left untouched by an
older one.

<!-- Upgrade data survival: S28.4 (manual-win) and S28.5 (manual-mac) todo. Settings newer-version backup: S13.1
(src/shared/settings.ts 'newer-version', tests/e2e/settings.spec.ts corrupt case). History index from a newer
version left untouched: src/recovery/README.md. Squirrel in-place upgrade: ADR 0012. About: S28.1 (e2e
distribution.spec.ts on macOS; Windows pending). -->

## 7. Working offline

Without a network connection all of this works: creating a project from a template, editing and saving, preview
refresh, code checks and error explanations (including problem cards). The editor, fonts and language features are
bundled with the app. In the offline test NoobIDE itself tried to reach nothing outside the computer.

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
4. Whether the app-data folder (section 5.2) remains after uninstalling is **to be confirmed by S28.4**. On a Mac it
   is expected to remain. To remove everything, quit NoobIDE and delete that folder by hand (section 5.2). This also
   deletes the local history and any edits not yet recovered.

<!-- Uninstall data handling: to be confirmed by S28.4 (Windows) / S28.5 (macOS). Squirrel uninstall removes
shortcuts (src/platform/squirrel.ts); macOS drag-to-Trash never touches ~/Library/Application Support. -->

## 9. When something goes wrong

- Help → **Open logs folder**, and attach the log files to your report. Logs contain no code, but they do contain the
  system and app versions.
- Include the NoobIDE version (from "About NoobIDE"), the system version, the computer model, what you did and what
  you saw.
