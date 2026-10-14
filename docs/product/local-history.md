# Local history — what it keeps, where, and how to clear it

Feature S21 (PLAN §7, §4 Recovery). This page is the reference for the history window's controls (S21.4) and the
source for the in-app help text. Code: `src/recovery/history.ts`, `src/main/history-ipc.ts`,
`src/renderer/history/`.

## What it is (and is not)

NoobIDE keeps earlier versions of each file **on this computer**, in the app-data folder, so a beginner can undo an
unintended change after it was saved. It is independent of the editor's undo, of autosave and of crash recovery
(PLAN §7), and it is **not a backup**: it lives on the same disk and has a size limit.

Versions are taken:

| When                                       | Shown as (zh-CN / en)        |
| ------------------------------------------ | ---------------------------- |
| Before a save replaces the file            | 保存前 / Before saving       |
| After a save (one per save burst, ≤ 1 min) | 保存后 / After saving        |
| Before formatting (S18)                    | 格式化前 / Before formatting |
| Before a file or folder goes to the trash  | 删除前 / Before deleting     |
| Before a restore replaces the content      | 恢复前 / Before restoring    |

Identical content is stored once. Dotfiles (such as `.env`) and `node_modules` are never copied into history.

## Opening the history window

- **历史** / **History** in the left rail (with a project open), or
- **历史版本** / **History** in the editor header, which preselects the open file.

The window lists the project's files that have history — deleted files too, marked **已删除 / Deleted** with a
warning icon — then the chosen file's versions (newest first, with time, reason and size), and a comparison.

## Compare and restore

- Choosing a version shows a line diff against the **current** content (the editor's text, including unsaved edits):
  `+` lines come back when restoring, `−` lines exist now and would be replaced. Screen readers hear "comes back" /
  "would be replaced" for each changed line.
- **恢复这个版本 / Restore this version**: unsaved edits are saved first; the current content is kept as a version;
  then the version becomes the file's content in its editor tab and is saved like any edit (autosave status, preview
  refresh). The restore is one undo step: Ctrl+Z (⌘Z) in the editor brings the previous text back.
- A deleted file: the whole version is shown; **恢复这个文件 / Restore this file** creates it again at its old place
  (also its folder, if that was deleted) and opens it. If something with that name exists again, nothing is
  overwritten and the window says so.
- Versions that are not UTF-8 text (e.g. images kept before a delete) are listed but cannot be shown or restored here.

## Storage, limits and cleanup policy

The **存储 / Storage** section shows:

- **Usage against the limit**: "历史占用 2.4 KB（上限 256.0 MB）". Defaults: 256 MB in total, at most 50 versions and
  32 MB per file; files over 5 MB are not snapshotted.
- **Policy**: above a limit the oldest versions are removed automatically; the newest version of each file is
  always kept.
- **Where it is stored**: the history folder in the app-data directory (`<userData>/history`, e.g.
  `%APPDATA%\NoobIDE\history` on Windows, `~/Library/Application Support/NoobIDE/history` on macOS).

Controls:

| Control                                           | What it does                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 打开历史文件夹 / Open history folder              | Opens the history folder in File Explorer / Finder (created if it does not exist yet).           |
| 立即清理 / Clean up now                           | Re-applies the limits, removes data no version refers to, and reports the space freed.           |
| 清除这个项目的历史 / Clear this project's history | After a confirmation, removes every version of the open project. Project files are not touched.  |
| 清除全部历史 / Clear all history                  | After a confirmation, removes the history of all projects, including damaged indexes kept aside. |
| 清除 / Clear (per orphaned project)               | Removes the history of a project whose folder no longer exists (see below).                      |

Escape cancels an open confirmation first, then closes the window. Every control is reachable with Tab; focus stays
inside the window while it is open.

## Projects that were moved or renamed

History is keyed by the project folder's real path (decision 0006). After a project folder is moved, renamed or
deleted, its history is no longer shown for the project but still uses space. The section **找不到文件夹的项目的
历史 / History of projects whose folder is gone** lists these histories with their old path, number of files and
size, each with **清除 / Clear**. A history can only be cleared this way while its folder really does not exist.

If history cannot be read at the moment (another program holds the index), the window says so, nothing is deleted,
and cleanup waits until it can be read again.

## Verification

- `tests/integration/history-ipc.test.ts` — listing, reading, before-restore, restoring deleted files without
  overwriting, the save-burst seal, orphans after a folder rename (Chinese characters and spaces), clear, cleanup,
  reveal, payload validation.
- `tests/e2e/history.spec.ts` — the whole window on Windows x64: diff, restore through the editor (undoable),
  unsaved edits kept, restore of a deleted file, storage text, reveal, cleanup, orphan clear, clear with
  confirmation, focus trap, en locale.
- macOS arm64: same suites on the macOS runner (S06); not run yet.
