# src/recovery — journal and local history

Crash-recovery journal for unsaved buffers and per-file local history (content-addressed snapshots + JSON index)
stored in app data, never in the project. Undo, autosave, recovery and history stay independent (PLAN §7).

- `journal.ts` (S12) — `RecoveryJournal`: one atomically written JSON record per unsaved editor buffer under
  `<userData>/recovery/<projectKey>/<fileKey>-<bufferId>.json`, removed after the buffer is saved. Records carry a
  SHA-256 of their text; damaged ones are skipped, logged (no content) and moved to `quarantine/`. Bounded per
  record, in total and in number; `clearAll()` is the clear-data control. The renderer side is
  `src/renderer/recovery/` (journal scheduler: a copy within 2 s of an edit; restore dialog with a diff vs disk).
- `history.ts` (S21) — `SnapshotStore`: `<userData>/history/objects/<hh>/<sha256>` blobs and
  `<userData>/history/index/<projectKey>.json`. Dedupe, per-file and total limits, `usage()`, `cleanup()`, `clear()`.
  Only a missing index means "no history": a locked or unreadable index makes that project's history _unavailable_
  (no writes, no blob deletion anywhere), damaged entries are dropped one by one, unparseable indexes are
  quarantined (no blob is deleted while any is kept), indexes from a newer app version are left untouched.
  Index schema `v`: 1 (S21) or 2 (S34.2: `groups`, reasons `before-ai`/`after-ai`); a v1 index is read as it is and
  written as v2 on the next change, a v3+ index is never written.
- **Change groups (S34.2):** the applied changes of one AI agent turn, per step the version kept right before it
  (`before-ai`) and the hash of what it left (`after-ai` snapshot). `recordGroupStep()`, `groups()`,
  `markGroupUndone()`; at most 100 groups per project. The History window and the chat card undo a turn from its
  group (renderer `src/renderer/ai/agent-apply.ts` `undoGroup`): edits through the restore path, created files to
  the trash, renames back, deleted files from history — each only if unchanged since the turn.
- `history-triggers.ts` (S21.2) — snapshots around saves (the save only reads the old bytes, bounded by a timeout;
  storing is queued) and before format, delete (listing filters: no dotfiles, no `node_modules`) and restore.
- `atomic-file.ts`, `keys.ts` — atomic app-data writes, content-free logger, hashed storage keys.

Main creates both stores from `app.getPath('userData')`; tests pass a temporary directory.

**Project identity (decision 0006):** a project's history is keyed by its real root path, a file's by its path
relative to that root (NFC). Moving or renaming the project folder orphans its history; the history window lists
orphaned project histories with their size and clears them (S21.4). S08's rename should move a file's history to
its new path (not done yet: the old path shows as a deleted file with history).

**History window (S21.3, S21.4):** `src/main/history-ipc.ts` (channels `history:*`, contract
`src/shared/ipc/history-contract.ts`) and `src/renderer/history/HistoryDialog.tsx`. Restoring an existing file never
writes it from main: the renderer saves unsaved edits, main takes a `before-restore` snapshot of the disk content,
then the version becomes the tab's content (one undo step) and is saved through the save pipeline. A format, delete or
restore snapshot that dedupes against the newest `after-save` version seals that save burst, so the restored
content's save cannot coalesce over (and drop) the version kept before the restore. A deleted file is created again
with link() from a temporary file, never replacing anything. User documentation: `docs/product/local-history.md`.
