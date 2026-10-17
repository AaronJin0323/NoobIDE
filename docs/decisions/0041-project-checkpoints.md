# 0041 — Project checkpoints share local history's blob store

- **Status:** accepted
- **Date:** 2026-10-17
- **Feature:** S56.1 (also S56.2, S56.3)

## Context

S56 adds named whole-project checkpoints (PLAN §12 v0.2, review `docs/reviews/mainstream-ide-gap-2026-10-17.md`
§4). The criteria ask that they reuse the content-addressed S21 store, so a file unchanged since the last checkpoint,
or already kept by local history, is stored once. Local history deletes blobs it no longer references (limits,
cleanup, "clear all history"). A blob that a checkpoint uses must never go with them, and checkpoints must stay apart
from local history in the UI (PLAN §7: undo, autosave, crash recovery and local history are separate mechanisms).

## Options considered

1. **Checkpoints inside the history index.** A new kind of entry in each project's index. This couples the two
   features' corruption handling (a damaged index would take both) and their UI. Rejected.
2. **A separate blob store for checkpoints.** Simple to reason about, but no dedupe with history, against the
   criteria. Rejected.
3. **Separate manifests, shared blobs, pins.** One manifest per checkpoint in `<userData>/checkpoints/<projectKey>/`.
   Contents go to `<userData>/history/objects/`, written through `SnapshotStore.withBlobs()` inside history's queue.
   The checkpoint store registers `setPins()`. History never deletes a pinned blob, and while the pins are uncertain
   it deletes none. Chosen.

## Decision

Option 3, with these rules:

- **Pins are uncertain until the checkpoint store has loaded, and while any manifest is unreadable.** During that
  time history defers all blob deletion (as it already does for unavailable or quarantined indexes).
- **Blobs are pinned before they are written.** A checkpoint being created pins each blob before `put()`, so
  history's clean-up can never take it in between. A failed or refused create releases only blobs nothing else
  references.
- **A damaged manifest affects only its own checkpoint.** It stays listed as damaged, and every hash in its text
  stays pinned until the user deletes it.
- **Older NoobIDE versions must not delete checkpoint blobs.** They know nothing about pins. So the checkpoint store
  keeps `history/index/00000000000000000000000000000000.json` up to date. It is an index with `format:
noobide-history`, version 1000, that lists every checkpoint blob. Older versions read it as "an index from a newer
  version" and never delete a blob it names (S21 rule). This version skips the file. Caveat: "Clear all history" in
  a version that predates S56 still deletes the whole history folder, checkpoint blobs included. That is an explicit
  user action in a downgraded app, and it is accepted.
- **Limits are checked before anything is stored.** These are: files (2 000), file size (20 MB), checkpoint size
  (200 MB), total unique size of all checkpoints (1 GB), named checkpoints per project (50). A checkpoint over a
  limit is refused with the file or size concerned. To fit the total, older automatic checkpoints are removed, but
  only after the new one was stored.
- **Pruning policy for automatic checkpoints (S56.3).** Per project, keep the newest 20 automatic checkpoints that
  are at most 14 days old, and always the newest automatic one. Named checkpoints are never pruned.
- **Manifest paths must be paths the walk could have produced.** That means NFC, listed and not ignored: no dotfiles,
  `node_modules`, `..`, device names, or trailing dots or spaces. Paths are unique, and no path is a folder of
  another. Restore additionally resolves every path inside the project with realpath checks.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- History's usage "on disk" includes checkpoint blobs (it measures the folder). The Checkpoints window shows the
  checkpoints' own usage.
- `tests/integration/checkpoint-store.test.ts` covers dedupe, ignore rules, limits, damaged and missing blobs, damaged,
  unreadable and crafted manifests, pins before load, clear-all and the legacy marker. CI runs it on Windows x64 and
  macOS arm64, and paths with Chinese characters and spaces are part of the fixtures.
