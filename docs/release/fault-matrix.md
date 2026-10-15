# Fault matrix (S26.1)

Every failure case PLAN §11 requires, plus the file-system faults behind "user data is sacred" (AGENTS.md), mapped to
the automated test that proves it or to the manual check that covers what automation cannot. S29 (release acceptance)
re-runs the manual column on clean Windows x64 and Apple Silicon machines.

## How faults are injected

`tests/integration/faults/` holds the dedicated suite. Product code reaches the disk through `node:fs/promises`; each
suite file replaces that module with `faultyFs` from [fault-fs.ts](../../tests/integration/faults/fault-fs.ts), which
fails a chosen operation (`open`, `write`, `sync`, `close`, `rename`, `link`, `unlink`, `mkdir`, `readFile`, `stat`,
`readdir`, `copyFile`, …) on chosen paths with a real errno code. Disk full, permission denied, read-only volumes,
locked files and I/O errors therefore run on any OS, without root, ACL tools or a full disk. A **crash** fault makes
the simulated process die in the middle of an operation — half of the data reaches the disk and nothing afterwards
runs (no cleanup) — and the test then starts a fresh "run" of the services, like a relaunch after a forced
termination. OS privacy protection (S25.3) is simulated the same way in `tests/integration/protected-folder.test.ts`.

Every fault test asserts the same invariants: the editor still holds the text, the file on disk is byte-for-byte
the old or the new version (never a mix), no temp file is left, nothing existing is overwritten, the recovery copy
still exists until a save is confirmed, the error code explains the cause, and the operation succeeds once the
cause is gone. Paths contain Chinese characters and spaces.

Abbreviations: **SF** `tests/integration/faults/save-faults.test.ts`, **JF** `…/faults/journal-faults.test.ts`,
**HF** `…/faults/history-faults.test.ts`, **FF** `…/faults/file-faults.test.ts`, **MC** `harness/MANUAL-CHECKS.md`.

## PLAN §11 required failure cases

| §11 case                               | Automated proof                                                                                                                                                                                                                                                                              | Manual check (real hardware)                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Chinese characters and spaces in paths | Every suite in `tests/integration/faults/` (all fixture paths); `tests/integration/tree.test.ts`, `preview-server.test.ts` "serves nested files with Chinese names and spaces"; e2e `files.spec.ts` "opens a folder with Chinese characters and spaces"                                      | —                                                                  |
| External file changes                  | FF "external changes: a file changed outside NoobIDE is refused"; SF "an external edit landing during the save is never overwritten"; `tests/integration/external-change.test.ts`; e2e `external-change.spec.ts`                                                                             | MC S07.3 / S08 (watcher on Apple Silicon)                          |
| Read-only directories                  | SF "read-only folder on the real file system (POSIX)", "permission denied creating the temp file (read-only folder, EACCES)", "read-only volume (EROFS)"; FF "creating a file fails with EACCES / EROFS"; `tests/integration/unreadable-folder.test.ts`                                      | MC S26.1 step 3 (read-only folder via Windows ACL)                 |
| Failed saves                           | SF table (13 faults: ENOSPC, EDQUOT, ENOSPC on fsync, EACCES, EROFS, EBUSY, EPERM, EIO, EXDEV, fsync EIO, close EIO, read EIO, stat EBUSY) + "read-only file on the real file system"; `save-pipeline.test.ts`; e2e `save.spec.ts`, `files.spec.ts`                                          | MC S26.1 steps 1–2 (real full volume, real locked file on Windows) |
| JavaScript infinite loops in preview   | e2e `preview-isolation.spec.ts` "an endless loop runs in another process and does not block typing", "unresponsive state: Stop recovers"                                                                                                                                                     | MC S04-S05-macos                                                   |
| Heavy console output                   | e2e `preview-isolation.spec.ts` "a console flood keeps the log bounded and every keystroke lands"; `src/preview/preview-units.test.ts` log buffer ("caps a burst and counts what it dropped")                                                                                                | MC S04-S05-macos                                                   |
| Resource 404s                          | `preview-server.test.ts` "answers 404 for missing files"; `src/preview/to-problem.test.ts` "maps failed resources (image 404, module load failure)"; e2e `preview-isolation.spec.ts` "uncaught exception, console error, 404 and module load failure"                                        | —                                                                  |
| Page network failures                  | Partial: module/resource load failures above (e2e S05.4, `to-problem.test.ts`); "Failed to fetch" explained with its possible causes (`src/diagnostics/rules/rules-9-15.test.ts` "rule 10: fetch failures")                                                                                  | MC S26.1 step 4 (fetch to an unreachable host, offline machine)    |
| Recovery after forced termination      | SF "forced termination in the middle of a save" (half-written temp file; just before the rename) and "the journal itself dies mid-write"; JF "the process dies mid-record", "dying while the directory is created"; HF "the process dies while the index is written"; e2e `recovery.spec.ts` | MC S12.4 (kill the real process on both platforms)                 |
| Recovery after deletion                | FF "recovery after deletion", "re-creating a deleted file fails … no empty placeholder", "a deleted file that reappears … never overwritten"; HF (versions survive store faults); e2e `external-change.spec.ts` (S11.3), `history.spec.ts` "a deleted file … can be restored"                | —                                                                  |
| Reopening after renaming               | FF "reopening after renaming: the old path fails cleanly, the new path opens, the recovery copy is kept"; e2e `history.spec.ts` "a moved project leaves an orphaned history"; e2e `recent-projects.spec.ts` "a missing folder is shown as unavailable"                                       | —                                                                  |
| Preview attempts to read files outside | `preview-server.test.ts` "path guard (S04.1)" (absolute paths, drive letters, 8.3 names, junctions, symlinks, dotfiles); e2e `preview-isolation.spec.ts` "a malicious page cannot read local files, other loopback services or the IDE"                                                      | MC S04-S05-macos                                                   |

## File-system faults (AGENTS.md "user data is sacred")

| Fault                                                            | Where it is injected                                                             | Automated proof                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disk full / quota (ENOSPC, EDQUOT)                               | temp write, fsync; journal; history blob + index; project creation copy          | SF table; JF "a ENOSPC/EDQUOT while recording"; HF "disk full writing the version / the index"; FF "creating a project runs out of space half-way"                                                                                                               |
| Permission denied / read-only (EACCES, EROFS)                    | temp create; journal dir; history dir; create/rename                             | SF table + real chmod tests; SF "a failing recovery journal never blocks saving"; JF EACCES; HF EACCES; FF create/rename                                                                                                                                         |
| macOS privacy protection (TCC), Windows Controlled Folder Access | simulated EPERM/EACCES below Documents/Desktop                                   | `tests/integration/protected-folder.test.ts`, `src/platform/protected-folders.test.ts` (S25.3)                                                                                                                                                                   |
| Locked file (EBUSY, Windows EPERM sharing violation)             | rename over the target; stat; journal and history reads; unlink during a move    | SF "file locked … through every retry", "EPERM rename", "a lock that clears during the retries"; JF "a record that cannot be read right now", "a discard that fails"; HF "a briefly locked index"; FF "removing the old name fails after the new one was linked" |
| Rename failure (EIO, EXDEV)                                      | final rename of the save; case-only rename hop                                   | SF "rename fails with an I/O error", "rename across devices refused"; FF "a case-only rename that cannot finish or be undone"                                                                                                                                    |
| fsync / close failure (EIO)                                      | temp file flush and close                                                        | SF "fsync fails", "closing the temp file fails"                                                                                                                                                                                                                  |
| Crash mid-write                                                  | temp write (half the bytes), before rename, journal record, history index, mkdir | SF, JF, HF crash tests (see "Recovery after forced termination")                                                                                                                                                                                                 |
| Damaged app data (torn JSON)                                     | journal record, history index                                                    | JF "damaged records are quarantined"; HF "a torn index is quarantined, its versions are never deleted"                                                                                                                                                           |
| Unreadable app-data folder                                       | journal scan; history index                                                      | JF "an unreadable journal folder never throws at startup"; HF "an index that stays unreadable … never overwritten"                                                                                                                                               |
| Trash failure                                                    | `shell.trashItem` rejects; history snapshot before delete fails                  | FF "a failed move to the trash keeps the file"; e2e `file-tree.spec.ts` "a failed move to the trash is explained"                                                                                                                                                |

## Bugs the suite found (fixed with regression tests)

1. **Journal discard could delete newer unsaved edits** (`src/recovery/journal.ts` `discardSaved`): when the record
   could not be read at that moment (locked by a scanner, EBUSY), the record — possibly holding edits typed during
   the save — was removed, so a crash right after lost them. Now an unreadable or oversized record is kept. Test: JF
   "newer edits journaled during a save survive a discard that cannot read the record".
2. **Failed re-create left an empty placeholder** (`src/workspace/project-service.ts` `write` with `create`): the
   empty file that reserved a deleted file's name stayed when the following write failed (disk full, I/O error), so
   the retry saw "the deleted file came back with other content" and showed a false conflict. Now a still-empty
   placeholder is removed on failure. Test: FF "re-creating a deleted file fails … no empty placeholder".

## Manual-only parts

Listed in `harness/MANUAL-CHECKS.md` under **S26.1**. Automation cannot reproduce these, so each is checked by hand
on Windows 11 x64 and macOS on Apple Silicon:

| Manual-only case                                     | Why automation cannot cover it                                                      | Step         |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------ |
| A really full volume                                 | needs a small real disk image; the suite injects ENOSPC/EDQUOT instead              | MC S26.1 / 1 |
| A file really held open by another program (Windows) | needs a second process holding a share-deny handle; the suite injects EBUSY/EPERM   | MC S26.1 / 2 |
| A read-only folder via Windows ACLs                  | `chmod` does not apply ACLs; the suite injects EACCES/EROFS and uses chmod on POSIX | MC S26.1 / 3 |
| Page network failures (offline, unreachable host)    | needs the machine's network unplugged; rule 10 and resource failures are tested     | MC S26.1 / 4 |
| Forced termination of the real app                   | kills the packaged process; the suite simulates the crash in-process                | MC S12.4     |
| Real macOS privacy prompt (TCC) / Windows CFA        | needs the OS protection switched on for the app; the suite simulates the OS refusal | MC S25.3     |

## Running on CI (S26.2)

Both CI jobs (`windows-x64` on `windows-latest`, `macos-arm64` on `macos-14`) run the suite as its own step,
**Fault suite (S26.2)** = `npm run test:faults` ([scripts/faults.mjs](../../scripts/faults.mjs)), before `verify`
(which runs it again with every other test). The step runs `tests/integration/faults/` and
`tests/integration/protected-folder.test.ts`, writes `reports/faults/<platform>-<arch>/` (`junit.xml`,
`results.json`, `summary.md` — per-file passed/failed/skipped counts and every skip with its reason), appends the
summary to the job summary, and uploads it as the artifact `fault-suite-windows-x64` / `fault-suite-macos-arm64`
(also when the step fails). `tests/integration/ci-workflow.test.ts` checks the step and the upload are in the
workflow; `tests/integration/fault-suite-report.test.ts` checks the skip policy.

The step **fails** when a test fails, when nothing ran, or when a test is skipped on a platform without an entry in
`SKIP_POLICY` in the script, so a fault test cannot be silently skipped on one OS. The only allowed skips:

| Test                                                                             | Skipped on | Why, and what covers it there                                                                                                                     |
| -------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| SF "read-only folder on the real file system (POSIX)"                            | Windows    | `chmod 0o555` does not make an NTFS folder read-only. The injected EACCES/EROFS save faults run on Windows; real ACLs are MC S26.1 step 3.        |
| `protected-folder.test.ts` "macOS privacy protection (TCC), simulated" (6 tests) | Windows    | needs POSIX path strings for the macOS adapter; the adapter is tested with POSIX strings on every OS in `src/platform/protected-folders.test.ts`. |
| SF "read-only folder on the real file system (POSIX)"                            | any, root  | root ignores folder permissions (not the case on GitHub runners).                                                                                 |

Everything else — including the Windows Controlled Folder Access simulation, which runs on both — runs on both jobs.
