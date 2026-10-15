# 0023 — Manual upgrade, downgrade and uninstall: what happens to app data

- **Status:** accepted
- **Date:** 2026-10-15
- **Feature:** S28.4 (also the G3 finding on the macOS ad-hoc signature)

## Context

PLAN §5/§11: the first versions upgrade manually (run a newer `NoobIDE-Setup.exe` on Windows, replace the app on
macOS) and projects and settings must survive; on Windows installation and uninstallation must be verified. AGENTS.md:
user data is sacred, project folders stay ordinary, app data lives in the app-data directory. Before S28.4 the stores
treated a file written by a newer NoobIDE differently: settings were moved to a backup and reset to defaults; recent
projects and the session were treated as corrupt (backed up, emptied); the walkthrough fell back to defaults and was
overwritten on the next save; the preview store silently rewrote it in its own version; the recovery journal
quarantined newer records (and rotated old quarantine files away). A user who tried an older build after a newer one
would have lost settings, recent projects, session and possibly unsaved-edit copies on the next re-upgrade.

## Options considered

**Uninstall (Windows, Squirrel):**

| Option                                         | For                                                                                         | Against                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove app + shortcuts, **keep app data**      | Nothing the user made is lost; reinstall resumes; matches what Squirrel and macOS do anyway | Leaves a folder behind; must be documented for users who want it gone                                                                                                               |
| Also delete app data on `--squirrel-uninstall` | "Clean" in the narrowest sense                                                              | Deletes local history and crash-recovery copies of unsaved work without asking; Squirrel hooks run hidden with a ~15 s budget, so no dialog can ask; violates "user data is sacred" |
| Ask in an uninstall dialog                     | User decides                                                                                | Not possible from a Squirrel hook (no UI, time-limited); would need a different installer technology (ADR 0012)                                                                     |

**Newer-version files (downgrade):** back up and reset (old settings behaviour) / treat as corrupt / **read what is
understood, never write** (chosen).

## Decision

- **Uninstall removes the app and its shortcuts only.** On Windows, Squirrel deletes the install folder
  `%LOCALAPPDATA%\NoobIDE` (app versions, `Update.exe`); NoobIDE's `--squirrel-uninstall` hook only runs
  `Update.exe --removeShortcut` and quits. App data in `%APPDATA%\NoobIDE` stays. On macOS, deleting NoobIDE.app
  leaves `~/Library/Application Support/NoobIDE`. **Project folders are never touched by install, upgrade or
  uninstall.** "Uninstall clean" therefore means: no NoobIDE program files, shortcuts, Start-menu entry or
  Installed-apps entry remain, and nothing was deleted that the user did not choose to delete. Users who want the app
  data gone delete that folder themselves (the user docs say where; history and recovery also have in-app clear
  controls).
- **Squirrel hooks always quit** (`runSquirrelAction`, `src/platform/squirrel.ts`): when Update.exe finishes, fails to
  start, errors, or after 10 s. `--squirrel-firstrun` starts the app normally. No hook opens a window or touches data.
- **App data location is version-independent:** `app.getPath('userData')` is derived from the product name
  (`NoobIDE`), never the version, so every version reads the same folder. The entries are listed once in
  `src/main/app-data-layout.ts`.
- **Schema versions** (`schemaVersionOf`, `src/main/json-file.ts`): every app-data file carries `version` (journal
  records and history indexes: `v`). Missing = version 0. Older files are read field by field (settings also through
  their migration chain) and written in the current version on the next change. **Files written by a newer NoobIDE
  are read as far as this version understands them and are never written, moved, backed up or deleted**: settings,
  recent projects, session, walkthrough and preview stores switch to memory-only for that run (settings show a
  notice saying changes are not saved); newer journal records are skipped and left in place (not quarantined, never
  removed by a save); newer history indexes were already left untouched (S21). Corrupt files keep their S13 handling
  (timestamped backup, defaults).
- **macOS packages are re-signed ad hoc** in a Forge `postPackage` hook (`codesign --force --deep --sign -`), the
  last packaging step. The packager edits Info.plist (name, version, icon, ASAR integrity) after Electron's own
  ad-hoc signature, which left the bundle "invalid" so that Gatekeeper refused a quarantined copy outright instead of
  showing the normal unidentified-developer prompt. Developer ID signing and notarisation replace this in S28.2 (H.2).
- **Testing the next version without a version bump:** `NOOBIDE_BUILD_VERSION` / `NOOBIDE_OUT_DIR` (forge.config.ts,
  vite.renderer.config.ts) package the same code as another version into another folder; `npm run test:e2e` builds
  `out/upgrade-next` (patch + 1) first. Never set for release builds.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- `tests/integration/app-data-upgrade.test.ts`: vN → vN+1 keeps settings, recent projects, session, walkthrough,
  preview trust, history and recovery; older-schema files are kept and upgraded; a downgrade over newer files
  (schema 2 + unknown fields, journal record and history index too) reads what it understands and leaves every byte
  of app data unchanged after using every store. Store-level tests: settings-store, recovery-journal, squirrel.
- `tests/e2e/upgrade.spec.ts` (macOS): the packaged vN creates a project, switches to English and saves twice; the
  packaged vN+1 on the same default app-data folder shows English, reopens the project and tab, lists the local
  history and the recent project; vN again reads it all without a notice.
- `tests/e2e/distribution.spec.ts`: `codesign --verify --deep --strict` passes on the packaged .app.
- Windows install → upgrade → uninstall needs a real Windows machine: `harness/MANUAL-CHECKS.md#S28.4`. The macOS
  upgrade of a downloaded, signed DMG (Gatekeeper) is S28.5, blocked on S28.2 / H.2.
- A downgraded run cannot save setting changes; the notice says so. Acceptable: downgrades are rare and silently
  destroying the newer data is worse.
- S12.3's evidence listed "a future format version" among quarantined corruptions; that case now stays in place
  (still skipped and logged). S13.1's "newer file backed up and reset" is replaced by "newer file read-only".
