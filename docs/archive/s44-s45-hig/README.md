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
