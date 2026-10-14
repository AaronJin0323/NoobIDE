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
- `history-triggers.ts` (S21.2) — snapshots around saves and before format, delete and restore.
- `atomic-file.ts`, `keys.ts` — atomic app-data writes, content-free logger, hashed storage keys.

Main creates both stores from `app.getPath('userData')`; tests pass a temporary directory.
