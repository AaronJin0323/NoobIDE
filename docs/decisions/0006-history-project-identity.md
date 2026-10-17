# 0006 — Identity of projects and files in local history

- **Status:** proposed
- **Date:** 2026-10-14
- **Feature:** S21.1, S21.2 (affects S21.3, S21.4)

## Context

Local history (`src/recovery/history.ts`) keys a project by `sha256(realpath of the project root)` and a file by its
`/`-separated path relative to the real root, in Unicode NFC. The relative key comes from the real path, so Windows
case variants of one file share a history; macOS NFD names are normalised to NFC. The crash journal uses the same
project key.

Consequences found in the S21 review:

- Renaming or moving the project folder gives it a new key. Its old history is orphaned: still on disk and counted
  in the storage limit, but not shown for the project any more.
- Renaming or moving a file starts a new, empty history for the new path; the old versions stay under the old path
  (as if the file had been deleted).

Relinking is not implemented in this round.

## Options considered

1. **Stable project id in `.noobide/project.json`.** AGENTS.md allows this one file in a project, with relative
   paths and no secrets. A random id written on first save (or on first history snapshot) would survive renames and
   moves, including copying the project to another machine. Cost: writes a file into the user's folder that the
   user did not ask for, which must stay optional (read-only folders, a user who deletes `.noobide/`). Copies of a
   project would share an id; the index must then also store the last root path and treat two live roots with one
   id as two projects.
2. **Content-hash relinking.** When a project is opened without history, look for an orphaned index whose newest
   versions match the current files' hashes (e.g. most files with history match) and offer to link it. No file in
   the project, works after moves. Cost: a scan of orphaned indexes on open; heuristics for partial matches.
3. **Keep the path key, make orphans visible.** List orphaned project histories (root path no longer exists) in the
   history UI with their size, so the user can open them by their old location, relink manually or clear them.

## Decision

For the MVP, keep the path-based key (deterministic, no writes into the project). S21.3/S21.4 must implement
option 3: list orphaned project histories with their size and offer to clear them, so they never silently use up
the limit. For renamed files, the S08 rename operation should carry the history over (rename the key inside the
index) — a cheap, exact relink, because main performs the rename itself.

Options 1 and 2 are candidates for after the MVP if users lose history to folder moves; option 1 needs an AGENTS.md
compatible design for `.noobide/project.json` (opt-in, no absolute paths).

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- `src/recovery/README.md` notes that S21.3 must list orphaned histories.
- `usage()` already counts orphaned histories in `totalBytes` and `onDiskBytes`, so limits stay truthful.
- Verification when S21.3 lands: an integration test renames a project folder (Chinese characters and spaces) and
  checks that its old history is listed as orphaned with its size, on both platforms' CI runners.
- Implemented in S21.3/S21.4: the history window lists orphaned project histories (folder no longer exists) with
  their old path, file count and size, and clears them by opaque key; main refuses to clear a key whose folder
  exists. Verified by `tests/integration/history-ipc.test.ts` (renamed project folder with Chinese characters and
  spaces) and `tests/e2e/history.spec.ts` on Windows x64. User documentation: `docs/product/local-history.md`.
- Implemented in S52.1 (2026-10-17): renaming or moving a file or folder in NoobIDE carries its history over —
  `SnapshotStore.movePath` re-keys every file at or below the old path in the index (an exact relink, because main
  did the move); a file that already had history at the new path keeps both, and the moved file's own versions win
  when the per-file limits trim. Crash-recovery copies follow too (`RecoveryJournal.movePath`, write first, remove
  second). The destination is reported as its real path, so a move through a link or a case variant keeps one
  identity. Moves made outside NoobIDE are not relinked in history (the tab follows; its old versions stay under the
  old path, as before). Verified by `tests/integration/file-move.test.ts` (Chinese characters and spaces) on
  Windows x64.
