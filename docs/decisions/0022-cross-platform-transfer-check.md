# 0022 — Cross-platform transfer problems are reported on open, never repaired automatically

- **Status:** accepted
- **Date:** 2026-10-15
- **Feature:** S13.5

## Context

PLAN §7: when a project moves between Mac and Windows, "explicitly report names that cannot be represented on the
target system and any case conflicts; do not silently rename files". Some hazards cannot even exist on the volume
the user is on (a default APFS volume is case- and Unicode-normalisation-insensitive; NTFS refuses `?` and `CON`),
so a detector must be testable without the disk, and the check must never change what it inspects.

## Options considered

1. **Repair on open** (rename to a portable form, unify line endings). Violates "user data is sacred" and PLAN §7.
2. **Check only when a file is opened or saved.** Misses folders the user never opens and case conflicts entirely.
3. **Read-only scan of the opened project, reported in a non-blocking notice.** The user decides what to rename.

## Decision

Option 3. `src/shared/portability.ts` is a pure detector over one folder's names (case conflicts, NFC/NFD twins,
decomposed names, names invalid on Windows or macOS via `src/shared/file-names`); `src/workspace/portability-scan.ts`
walks the project with `readdir` and read-only file handles (bounded: 5000 entries, depth 8, 500 text files) and adds
files with mixed CRLF/LF line endings (decision 0011). The renderer asks for the report over the S13 app-data IPC
(`project:portability`, projectId only; main resolves the root) and shows `TransferNotice` (`role="status"`, up to 8
lines, dismissible). Decomposed (NFD) names are reported because a link typed on Windows (NFC) does not find them.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- Unit: `src/shared/portability.test.ts` (injected listings no single volume can hold),
  `src/renderer/workbench/transfer-notice.test.ts` (every kind has a zh-CN and en message),
  `src/main/app-data-ipc.test.ts` (sender, payload, unknown project).
- Integration: `tests/integration/portability.test.ts` copies `tests/fixtures/跨平台 迁移` and adds whichever hazards
  the volume accepts, then hashes names (raw bytes), sizes, mtimes and contents before and after scan + open + list.
- E2E: `tests/e2e/portability.spec.ts` opens the project in the app, checks the notice, and compares the same snapshot.
- On Windows the Windows-invalid names cannot be created, so those cases rely on the injected listings there; on a
  case-sensitive volume (Linux CI, case-sensitive APFS) the case and NFC/NFD twins are also proven on disk.
