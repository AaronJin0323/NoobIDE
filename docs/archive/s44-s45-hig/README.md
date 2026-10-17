# Archived: S44/S45 HIG refinement (half-landed in a110002)

Commit `a110002` ("S44 + S45: HIG refinement") committed only the files that work **added**. Every edit it made to
existing files (PreviewPane, i18n catalogues, icons, dialogs, the command registry, …) was never committed and could
not be recovered from git or any worktree. The tree therefore did not typecheck and 18 unit tests failed.

On 2026-10-16 (key-feature visibility session) the owner chose to restore the last green code (`3222c89`) for every
file that commit touched and keep the commit's own versions here, out of the build, typecheck, lint and tests, as
reference for a rebuild (backlog feature S45.9). Paths below mirror the repository paths.

Two parts of this design are deliberately **not** to be rebuilt as written (owner request 2026-10-16, "key features
must always be visible"):

- `PreviewMoreMenu.tsx` puts Annotate inside the ⋯ More menu and hides the annotations strip until an annotation
  exists.
- `AddContextMenu.tsx` folds the chat's three Add-context buttons into an icon-only "+" menu.

## Status (S50.1, 2026-10-18)

Backlog feature S45.9 is superseded by S50.1. The archived parts are accounted for as follows:

- `Sheet.tsx` / `Sheet.test.ts` — rebuilt on the calm rules as `src/renderer/workbench/Sheet.tsx` (S49.1 shell, S50.1:
  the shared `SheetFrame` the command palette also uses, the `calc(100dvh - 2 × max(32px, titlebar inset))` height
  cap and the 2px blur plus dim of a covered sheet); tests in `sheet.test.ts` and `tests/e2e/sheets.spec.ts`.
- `Notice.tsx` / `notice.test.ts` / `i18n/notices.ts` — rebuilt by S50.2.
- `PreviewMoreMenu.tsx` and `AddContextMenu.tsx` — **dropped** (owner request 2026-10-16: Annotate and the
  Add-context buttons stay visible, never inside a menu).
- `header-fit.ts`, the per-area CSS files and the archived e2e specs — dropped; the container-query ladder of S49.6
  and the calm stylesheet replace them.
