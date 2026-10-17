import { versionChanged, type FileContent, type FileVersion, type WatchEvent } from '../../shared/ipc/contract';
import { isSameOrBelow } from './file-tree-model';
import type { DocumentSaver } from './save-controller';
import { isUnsaved } from './save-machine';

/**
 * External change detection for open files (S11.1–S11.3, PLAN §7). Watcher events only say *that* something
 * happened; what it means is decided by reading the file again and comparing its content hash with the version the
 * editor last read or wrote (`known`). Our own atomic saves (temp file + rename) therefore never look like external
 * edits: their hash is the one the save reported. Timing is never trusted.
 *
 *   same content                    → nothing (also a `touch`, or our own save seen late)
 *   changed, buffer has no edits    → reload silently with a notice (S11.1)
 *   changed, buffer has edits       → conflict: autosave stops, the user compares and chooses (S11.2)
 *   gone                            → marked deleted, text kept, re-save offered (S11.3)
 *   renamed/moved (S52.1)           → the tab follows when the file at the new path has the buffer's base content;
 *                                     otherwise it is a delete + create: the tab stays, marked deleted
 *
 * Pure apart from the injected deps, so every rule is unit-tested.
 */
export type DiskRead =
  { readonly ok: true; readonly content: FileContent } | { readonly ok: false; readonly code: string };

export interface DiskSyncTab {
  readonly saver: DocumentSaver;
  /** The disk version the buffer is based on (last read, reload or confirmed save). */
  known(): FileVersion | undefined;
}

export interface DiskSyncDeps {
  tab(relPath: string): DiskSyncTab | undefined;
  read(relPath: string): Promise<DiskRead>;
  /** Clean buffer, new disk content: replace the buffer (keeping the cursor where possible) and show a notice. */
  reload(relPath: string, content: FileContent): void;
  /** Unsaved edits, new disk content: conflict with this disk version for the comparison. */
  conflict(relPath: string, content: FileContent): void;
  /** The file is gone from disk. */
  deleted(relPath: string): void;
  /** S52.1: the file moved to `to` with the same content: the tab follows it (unsaved edits included). */
  moved(from: string, to: string, content: FileContent): void;
}

/** S52.1: an open file that a rename or move on disk took from `from` to `to`. */
export interface TabMove {
  readonly from: string;
  readonly to: string;
}

/**
 * S52.1: what a batch of watcher events means for the open files. A rename or move of an open file (or of a folder
 * holding open files) is replayed as a move ({@link DiskSync.replayMove} decides by content hash); every other open
 * file the batch may concern is checked as before ({@link pathsToCheck}). A file in a move is not checked again.
 */
export function planWatchEvents(
  events: readonly WatchEvent[],
  open: readonly string[],
): { readonly moves: readonly TabMove[]; readonly check: readonly string[] } {
  const moves = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'renamed' || event.from === event.to) continue;
    for (const path of open) {
      if (isSameOrBelow(path, event.from) && event.from !== '' && !moves.has(path)) {
        moves.set(path, event.to + path.slice(event.from.length));
      }
    }
  }
  const check = pathsToCheck(events, open).filter((path) => !moves.has(path));
  return { moves: [...moves].map(([from, to]) => ({ from, to })), check };
}

/** Open files a batch of watcher events may concern (a folder event concerns every open file below it). */
export function pathsToCheck(events: readonly WatchEvent[], open: readonly string[]): string[] {
  const out = new Set<string>();
  const below = (relPath: string) => {
    for (const path of open) if (isSameOrBelow(path, relPath)) out.add(path);
  };
  for (const event of events) {
    switch (event.type) {
      case 'rescan':
        for (const path of open) out.add(path);
        break;
      case 'renamed':
        below(event.from); // gone from the old name (a case-only rename on Windows/macOS still reads the same file)
        below(event.to);
        break;
      default:
        below(event.relPath);
    }
  }
  return [...out];
}

export class DiskSync {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly deps: DiskSyncDeps) {}

  /** Checks one open file against the disk. Checks of one file run one after another. */
  check(relPath: string): Promise<void> {
    const previous = this.queues.get(relPath) ?? Promise.resolve();
    const run = previous.then(() => this.checkNow(relPath)).catch(() => undefined);
    this.queues.set(relPath, run);
    void run.then(() => {
      if (this.queues.get(relPath) === run) this.queues.delete(relPath);
    });
    return run;
  }

  /**
   * S52.1: the watcher saw the open file `from` renamed or moved to `to`. The tab follows only when the file at `to`
   * has exactly the content the buffer is based on (its hash); anything else is a delete + create: `from` is checked
   * as usual, so the tab is kept with its text and marked deleted. Runs in `from`'s queue, after any write of ours.
   */
  replayMove(from: string, to: string): Promise<void> {
    const previous = this.queues.get(from) ?? Promise.resolve();
    const run = previous.then(() => this.replayNow(from, to)).catch(() => undefined);
    this.queues.set(from, run);
    void run.then(() => {
      if (this.queues.get(from) === run) this.queues.delete(from);
    });
    return run;
  }

  private async replayNow(from: string, to: string): Promise<void> {
    const before = this.deps.tab(from);
    if (!before) return;
    await before.saver.whenIdle();
    const read = await this.deps.read(to);
    const tab = this.deps.tab(from);
    if (!tab || tab.saver !== before.saver) return; // closed or reopened meanwhile
    const known = tab.known();
    if (read.ok && known !== undefined && !versionChanged(known, read.content.version) && !tab.saver.busy) {
      this.deps.moved(from, to, read.content);
      return;
    }
    await this.checkNow(from);
  }

  private async checkNow(relPath: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = this.deps.tab(relPath);
      if (!before) return;
      // A write of ours in flight would make the disk look "changed": wait for it and its reported version.
      await before.saver.whenIdle();
      const read = await this.deps.read(relPath);
      const tab = this.deps.tab(relPath);
      if (!tab || tab.saver !== before.saver) return; // closed or reopened meanwhile
      if (tab.saver.busy) continue; // the user saved while we read: read again after that write
      this.apply(relPath, tab, read);
      return;
    }
  }

  private apply(relPath: string, tab: DiskSyncTab, read: DiskRead): void {
    const { saver } = tab;
    if (!read.ok) {
      if (read.code === 'not-found') this.deps.deleted(relPath);
      // Other failures (unreadable, became binary or too large) change nothing: the buffer and its state stay.
      return;
    }
    const known = tab.known();
    const changed = known === undefined || versionChanged(known, read.content.version);
    if (saver.state.deleted) saver.markReappeared();
    if (!changed) {
      // Same content as the buffer's base. A conflict still waiting for the user gets its comparison refreshed.
      if (saver.state.conflict) this.deps.conflict(relPath, read.content);
      return;
    }
    if (!isUnsaved(saver.state) && !saver.state.conflict) this.deps.reload(relPath, read.content);
    else this.deps.conflict(relPath, read.content);
  }
}
