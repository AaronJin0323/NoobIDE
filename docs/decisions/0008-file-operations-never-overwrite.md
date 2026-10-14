# 0008 — File operations: never overwrite, portable names, case conflicts

- **Status:** accepted
- **Date:** 2026-10-14
- **Feature:** S08.2, S08.4 (after the independent file-ops review)

## Context

Create, rename/move and delete run in main (`src/workspace/file-ops.ts`). AGENTS.md: user data is sacred — never
silently overwrite or delete; names that Windows or macOS cannot represent are explained, never silently changed;
projects move between Windows and macOS. `rename()` replaces an existing file on both platforms, so an
"exists? then rename" sequence has a window in which another program can create the target.

## Options considered

1. `exists()` then `rename()` for everything — simple, but the window above exists for files and folders.
2. Files: `link()` + `unlink()` — `link()` refuses an existing target atomically on NTFS, APFS and ext4; folders
   cannot be hard-linked. Some volumes (FAT/exFAT, some network shares) do not support hard links.
3. Platform calls (`renameat2(RENAME_NOREPLACE)` on Linux, `renamex_np(RENAME_EXCL)` on macOS,
   `MoveFileEx` without `MOVEFILE_REPLACE_EXISTING` on Windows) — atomic for files and folders, but only reachable
   through a native module, which AGENTS.md avoids without strong need.

## Decision

- **Files** are moved with option 2. If `link()` reports that hard links are unsupported (`ENOTSUP`, `EPERM`,
  `EXDEV`, …) or the old name cannot be removed for a reason a rename may still overcome (read-only attribute), the
  second name is removed again and the move falls back to option 1.
- **Folders and links** use option 1. On Windows `rename()` of a folder onto an existing folder fails anyway; on
  macOS it replaces only an _empty_ folder. The residual window is a few microseconds between `lstat()` and
  `rename()` inside a user-initiated action on the user's own folder; it is accepted and documented here.
- **Case conflicts are refused on every volume.** A new name that differs from a sibling only in letter case (or
  Unicode normalisation) is reported as `case-conflict`, also on case-sensitive volumes, because the project must
  keep working on case-insensitive Windows and macOS (PLAN §7: report case conflicts). Therefore the per-volume
  probe `isCaseSensitive` (src/workspace/paths.ts) is not used to _allow_ such siblings; it stays available for
  diagnostics. When checking a rename, only the sibling with exactly the source's own name is skipped — never by
  inode number, which network volumes may report as 0 or reuse.
- **Case-only renames** call `rename()` directly (NTFS and APFS support it) and verify the result by listing the
  folder. Only if the volume kept the old spelling is the entry moved through a visible temporary name
  (`NoobIDE-renaming-<hex>-<name>`, not hidden by the tree). If the second step fails, the first is undone; if that
  fails too, the error names the temporary name so the user can find the file.
- **Existing entries** (rename source, trash, reveal) are resolved only by a name their folder actually lists. This
  rules out NTFS alternate data streams and Windows aliases (`a.html.`), and lets the user rename or trash files
  whose names are not portable (from a zip or another system); the tree flags those and does not open them.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- `tests/integration/file-ops.test.ts` injects failures between the steps (rename hop, rollback, unlink) and a
  target that appears after the check; all pass on Windows x64. The same tests run unchanged on the macOS arm64 CI
  runner (S06); manual confirmation steps are in `harness/MANUAL-CHECKS.md`.
- If a native module is ever accepted for another reason, option 3 should replace option 1 for folders.
