# 0011 — Files with mixed line endings are unified on save, with a notice first

- **Status:** accepted
- **Date:** 2026-10-14
- **Feature:** S09.1 / S10 (raised by the S03 security review)

## Context

PLAN §7 asks to preserve the existing line-ending style of a file. A Monaco text model holds exactly one end-of-line
sequence: when a file contains both CRLF and LF, the model converts every line break to the dominant one on load. The
first save then rewrites all minority line breaks — a change to the user's file that the user did not type. Files
with a single line-ending style (the normal case) round-trip byte for byte, including a UTF-8 BOM (e2e
`tests/e2e/save.spec.ts` checks CRLF + BOM on disk).

## Options considered

1. **Keep mixed line endings exactly.** Would need a per-line EOL map that is re-applied to edited text, i.e. a
   line-level diff between the loaded and the saved buffer on every save. Complex, easy to get subtly wrong
   (inserted / moved lines have no "original" ending), and it only serves files that are already inconsistent.
2. **Refuse to save mixed files.** Safe for the bytes but blocks a beginner from editing a file that many tools
   produce (copy-paste from the web, files edited on both systems).
3. **Unify to the dominant line ending, and say so before anything is written.** Simple and predictable.

## Decision

Option 3. `decodeText` detects mixed line endings (`hasMixedEol`), the read result carries `mixedEol: true`, and the
editor shows a note above the file naming the line ending that saving will use. Opening the file writes nothing;
only an edit (and its save) unifies the line breaks. Nothing is unified silently.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- Unit tests: `src/workspace/text-codec.test.ts` (detection); e2e `tests/e2e/save.spec.ts` (the note is shown and the
  file is unchanged on disk after opening).
- Option 1 can be revisited if users report problems; local history (S21) keeps the pre-save version either way.
