# 0007 — File watcher: recursive `fs.watch` plus our own classification

- **Status:** accepted
- **Date:** 2026-10-14
- **Feature:** S07.3

## Context

The file tree and (later) external-change conflict handling (S11) need to know when files in the open project are
created, changed, deleted or renamed by other programs — including case-only renames on case-insensitive volumes
(NTFS, default APFS). AGENTS.md prefers pure JS/TS dependencies; a native module needs an ADR plus proof of macOS
arm64 and Windows x64 builds against the pinned Electron ABI.

## Options considered

1. **Node's `fs.watch(root, { recursive: true })`** — built into Electron's Node (no dependency, no native build of
   our own). Recursive mode is native on Windows (ReadDirectoryChangesW) and macOS (FSEvents) and supported on Linux
   since Node 20. Raw events are only `rename`/`change` + a relative file name, with platform-specific shapes.
2. **chokidar 4/5** — pure JS, but since v4 it no longer bundles `fsevents`; on macOS it falls back to one
   non-recursive `fs.watch` per directory (many handles in larger projects) and adds a dependency tree to audit.
   Rename detection still has to be built on top.
3. **@parcel/watcher** — fast and well-tested, but a native module: prebuilt binaries per platform/ABI, an extra
   signing/notarisation surface on macOS and an ADR-level maintenance cost for a solo developer.

## Decision

Option 1. `src/workspace/watcher.ts` wraps one recursive `fs.watch` per open project and normalises its events:

- raw events are collected per path and debounced (100 ms quiet period, at most 1 s);
- each batch is classified against an exact-name snapshot of the project (`known`, taken at start and updated per
  batch): existence is decided by an exact, case-sensitive match in the parent's `readdir`, so a case-only rename
  on a case-insensitive volume becomes "old name gone, new name present";
- a deletion and a creation of the same kind in one batch pair up as `renamed` (same folder, or same name in another
  folder = move), with `caseOnly` when only letter case differs;
- ignored names (node_modules, dotfiles, `*.noobide-tmp`) never produce events; an atomic replace of a known file is
  reported as `changed`;
- a lost watch (root removed, `filename` missing, internal error) produces `rescan`, and the UI reloads the tree.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- No new dependency. `tests/integration/watcher.test.ts` runs on the real file system: create, change (debounced),
  delete, rename, case-only rename, move, folder rename/create/delete, ignore list and atomic replace. It passes on
  Windows x64 (dev machine); the same test runs unchanged on the macOS arm64 CI runner (S06), where FSEvents may
  coalesce events — the classification only looks at the final state per batch, so it does not depend on the raw
  event order.
- The snapshot is capped at 50 000 entries; beyond it, paths it never saw are reported as `created` rather than
  `changed`. Projects that large are outside the beginner target.
- Network drives may not deliver events at all; the tree still works and is refreshed after NoobIDE's own file
  operations.

## Amendment (2026-10-15): FSEvents replays changes made just before the watch started

First run on macOS arm64: FSEvents delivers raw events for files written in the moments _before_ the stream was
created (e.g. a project opened right after it was created from a template, or a test fixture). Classified against
the snapshot they looked like `changed` events for files that had not changed. The watcher now stats a file before
reporting `changed` only when its raw event arrived within `replayWindowMs` (1 s) of attaching, and drops it if the
file's ctime is not newer than the snapshot start (millisecond resolution). Outside that window nothing changes and
no extra I/O is done; on Windows (no replays) the check finds a fresh ctime and reports the change as before. A
replay large enough to exceed `maxBatch` still becomes one harmless `rescan`.

## Amendment (2026-10-15): an entry created and removed within one batch is reported as deleted

macOS arm64 e2e: another program created a file and deleted it ~50 ms later. FSEvents delivered both raw events
within one debounce window, so the batch saw no net change against the snapshot (unknown before, absent now) and
emitted nothing. But the tree had already listed the folder in between — reloading it for an unrelated event — and
kept a ghost row. Such a path ("gone + unknown") is now reported as `deleted` (once, at its outermost folder), so
listeners refresh it; for a path nobody listed it is a harmless reload. The raw event FSEvents/libuv sends for the
watched folder itself (named by the folder's own basename) is not reported. Windows behaves the same way when its
events fall into one batch; nothing else changes. Covered by `tests/integration/watcher.test.ts` (create→delete,
create→delete→create, and a deterministic same-batch case with an injected watch).

## Amendment (2026-10-15): the halves of a rename may arrive in different batches

macOS arm64 CI: the integration test "reports a folder rename once" timed out waiting for `renamed`. libuv creates
its FSEvents stream with `kFSEventStreamCreateFlagNoDefer` and a 50 ms latency: the first event after a quiet period
(the old name) is delivered at once, and the events that follow within the latency (the new name) only when it has
passed. On a busy runner that gap can exceed the debounce, so the old name was classified alone as `deleted` and the
new name in the next batch as `created`: open tabs of files inside a renamed folder would then look deleted. A
deletion that finds no partner in its batch is now held for `renameWaitMs` (400 ms): it stays in the snapshot and
is classified again with the next batch, where a creation of the same kind pairs with it as usual; when the wait is
over without a partner it is reported as `deleted`. A held path that is back on disk by then is reported as
`deleted` followed by `created`, as before the hold (the IDE's own delete followed by a restore from history: the tree
already dropped the row and must add it again). Only unpaired deletions wait; created, changed and renamed events keep
the debounce delay, and a mass change still becomes one `rescan`. Deletions therefore reach listeners up to
~0.5 s later. Covered deterministically with an injected watch (folder rename and file move split across batches,
an unpaired deletion, a delete + restore) in `tests/integration/watcher.test.ts`. The real-file-system tests now
have a 15 s timeout, above the sum of their two 5 s waits, so a wrong or missing event fails with the list of events
that did arrive instead of a bare timeout.
