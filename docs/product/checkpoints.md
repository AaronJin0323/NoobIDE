# Project checkpoints — save the whole project, compare, go back

Feature S56 (PLAN §7, §12 v0.2; review `docs/reviews/mainstream-ide-gap-2026-10-17.md` §4). This page is the
reference for the Checkpoints window and the source for its in-app wording. Code: `src/recovery/checkpoints.ts`,
`src/main/checkpoints-ipc.ts`, `src/renderer/checkpoints/`. Design: `docs/decisions/0041-project-checkpoints.md`.

## Three different safety nets

NoobIDE has three mechanisms that can each take you back. They are separate, with separate windows and wording
(PLAN §7):

| Mechanism                                                      | Covers                            | Taken                                                                            | Where you use it                       |
| -------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------- |
| **Undo** — 撤销 (Ctrl+Z / ⌘Z)                                  | the file you are editing          | every edit, while the file is open                                               | in the editor                          |
| **Local history** — 本地历史 (`docs/product/local-history.md`) | one file at a time                | automatically, on every save (and before formatting, deleting, restoring)        | **本地历史… / Local history…**         |
| **Checkpoint** — 检查点                                        | the **whole project**, every file | when **you** save one and give it a name, plus automatically before bulk changes | **项目检查点… / Project checkpoints…** |

A checkpoint is **not version control**. There are no commits, branches or sharing, and it is not Git. It is also not a
backup: it lives on the same computer, in NoobIDE's own data folder (`checkpoints/` and the shared `history/objects/`
in the app-data directory), and **never inside the project folder**.

## Opening the window

**项目检查点… / Project checkpoints…** is in the in-window menu (⋯), in the native **File** menu and in the command
palette. It needs an open project.

## Saving a checkpoint

Type a name (for example "首页做好了 / Home page done") and choose **保存检查点 / Save checkpoint**. Every file the
file tree shows is recorded. Dotfiles such as `.env` or `.git`, `node_modules`, OS litter (`Thumbs.db`) and links are
never copied. Identical contents are stored once, across checkpoints and local history.

A checkpoint is **refused, never cut short**, when it would exceed a limit. The message names the file or the size:

- more than 2 000 files;
- a file larger than 20 MB;
- more than 200 MB in one checkpoint;
- more than 1 GB for all checkpoints of all projects together (older _automatic_ checkpoints of the project are
  removed first to make room, but only after the new checkpoint was stored);
- more than 50 named checkpoints in one project;
- a file name that cannot be stored on every system (e.g. `con.js`, `a?.html`);
- a file that changed while the checkpoint was being saved (try again).

The window shows the usage ("Checkpoints use … of 1 GB; this project: n named, m automatic") and this policy.

## Compare

Choose a checkpoint to compare it with the project **now**. The list shows every file that differs, each with a word
and a mark (not colour alone):

- **之后新增 / Added since** (+): the file did not exist in the checkpoint;
- **已修改 / Changed** (~);
- **之后删除 / Removed since** (−): restoring creates it again.

Choosing a file shows its line diff, with the same reading as local history: `+` lines come back when you restore, `−`
lines exist now and would be replaced. A file that is not text shows a note instead. A file whose copy in the
checkpoint is damaged or missing is marked unavailable and cannot be restored. The other files can.

## Restore

**还原整个项目… / Restore whole project…**, or **只还原这个文件… / Restore this file only…** for the chosen file.
Before anything happens, a confirmation shows:

- how many files will be written back;
- **unsaved changes** in open files, with the choice: _save them first, then restore those files too_ (the default),
  or _keep the unsaved changes and do not restore those files_;
- **files added since the checkpoint**, with an unticked box: _move these files to the system trash_. Unticked, they
  stay as they are. Ticked, they go to the OS trash (never deleted for good), with a local-history copy kept first.

Then:

1. An **automatic checkpoint of the project as it is now** is saved first ("还原“…”之前 / Before restoring “…”"). If
   you do not like the result, restore that one. If it cannot be saved (for example, storage full), **nothing is
   restored**.
2. Open text files are restored through their editor tab: the checkpoint's text becomes the content as one undo step
   and is saved through the normal save pipeline. Other files are written by NoobIDE's atomic save (temporary file +
   rename), only while the file is still exactly what the comparison saw. A file deleted since is created again,
   never over something that has appeared with that name.
3. The preview refreshes after the confirmed writes, like after a save.
4. The result lists every file that was not restored, with the reason.

## Automatic checkpoints

Taken right before:

| Cause                                                                     | Shown as (zh-CN / en)                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| an AI agent proposal is applied (S34)                                     | 应用 AI 助手的修改之前 / Before applying AI assistant changes |
| a local-history restore (a version, a deleted file, or an undone AI turn) | 从本地历史恢复之前 / Before restoring from local history      |
| a checkpoint restore                                                      | 还原检查点之前 / Before restoring a checkpoint                |

An automatic checkpoint identical to the project's newest checkpoint is not stored again. If one cannot be taken, an
AI change or a local-history restore still goes ahead: local history keeps that file's previous version anyway.

**Pruning policy:** per project, NoobIDE keeps the latest **20** automatic checkpoints, for up to **14 days**, and always
the newest automatic one. **Named checkpoints are never removed automatically.** Renaming an automatic checkpoint
makes it named.

## Damage and errors

- A damaged checkpoint (its record cannot be read) is listed as unusable and can be deleted. Other checkpoints and
  local history keep working.
- A damaged or missing file copy affects only that file of that checkpoint.
- While the checkpoint records cannot be read (for example, a virus scanner holds them), no checkpoint is saved and
  local history deletes nothing until they can be read again.
