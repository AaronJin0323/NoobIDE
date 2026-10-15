# 0033 — Crash copies of a moved or missing project folder

- **Status:** accepted
- **Date:** 2026-10-16
- **Feature:** S12.2 / S12.3 follow-up (release-readiness data-safety finding)

## Context

The crash-recovery journal (S12, PLAN §7) keys every unsaved-buffer copy by the project's real root path. The
recovery dialog reached a copy only by reopening that root: `recovery:open-project` opens the stored path and
`recovery:read` / `recovery:discard` need an open `projectId`. When the folder was moved or renamed between runs, or
its drive came back under another letter, opening failed with "the project folder cannot be opened" and the user was
left with two choices: "Decide later" or "Clear all" (which deletes every project's copies). The recovered text could
not be read, copied or saved. Worse, `decideRestore` skipped session restore while any copy was pending, so every
later start stayed on the welcome screen. User data is sacred (AGENTS.md): a copy the user cannot reach is as bad as
a lost one.

## Options considered

1. **Reopen by asking for the folder only.** Fixes moved folders but not deleted ones, and gives nothing to a user who
   just wants the text back.
2. **Show the text from the renderer and let it write anywhere.** Breaks restricted IPC: the renderer would pass an
   arbitrary destination path to main.
3. **Copies addressed by journal key, dialogs in main (chosen).** New channels address a pending copy by its opaque
   journal project key (32 hex) and buffer id (UUID), never by a path. Main shows the native save and folder dialogs
   and keeps every path it gets from them.

For session restore: (a) keep blocking it while any copy is pending; (b) drop the copies after one start; (c) leave
them pending but stop them from blocking (chosen).

## Decision

- `recovery:read-pending {key, bufferId}` returns the text of a copy left by an earlier run without opening its
  project; `recovery:discard-pending` throws one away. Buffers of the running app are never "pending" here.
- `recovery:save-pending-as {key, bufferId}`: main reads the copy, shows the native save dialog (suggesting the file's
  name; the dialog itself asks before replacing a file) and writes atomically through
  `ProjectService.writeStandaloneCopy` (temp file + rename, BOM kept). Once the file is on disk the journal copy is
  removed — like a save, which also empties the journal. A failed or cancelled save keeps the copy.
- `recovery:relocate {key}`: main shows the folder dialog. If the chosen folder (real path) contains every recovered
  relative path, the journal re-targets the copies to it (write each record under the new key, then remove the old
  one — a crash in between leaves a copy in at least one place; an existing newer revision wins) and opens it; the
  dialog continues with the normal diff and restore. Otherwise main returns the missing paths and an opaque
  `choiceId`; `recovery:relocate-confirm {key, choiceId}` uses the folder main kept (bound to its key, single use).
- The recovery dialog, when opening fails, shows each copy read-only with **Copy**, **Save as…** and **Discard**
  (confirmed), plus **Choose the folder's new location…** and **Back to the list**. Strings in zh-CN and en; state is
  given in text (role=alert / role=status), never by colour alone; every action is a button.
- Session restore is held back only by pending projects whose folder still exists (`blockingRecoveryCount`). Copies
  of a moved or missing folder stay pending and the dialog still offers them on every start, but the last project
  reopens normally. Nothing is ever removed automatically.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- The renderer never sends a filesystem path on these channels; payload parsers accept only the key, a UUID buffer id
  and a UUID choice id with exact keys, behind the usual sender check (`src/main/ipc.test.ts`).
- `tests/integration/recovery-orphan.test.ts` renames a project with Chinese characters and spaces, then reads, saves
  as (BOM kept, no temp file left) and discards by key, re-targets to the new folder and reviews through the opened
  project, and checks the confirm path for a folder without the recovered files.
- `tests/integration/session-store.test.ts` covers `blockingRecoveryCount` with `decideRestore`.
- `tests/e2e/recovery.spec.ts` kills the app, moves the project folder, relaunches, reads the copy, saves it via a
  faked save dialog in main, discards the other, and in a second run points at the folder's new location and
  restores. The e2e suite runs on the Windows x64 and macOS arm64 CI runners (decision 0021).
- A copy whose project folder never comes back stays in app data until the user saves or discards it, or uses
  "Clear all"; it counts toward the journal quota like any other copy.
