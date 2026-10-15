import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isListedEntry } from '../workspace/listing-filter';
import { MAX_TEXT_FILE_BYTES } from '../shared/ipc/contract';
import { errorCode, silentLogger, type RecoveryLogger } from './atomic-file';
import { sha256Hex } from './keys';
import type { SnapshotReason, SnapshotStore } from './history';

/**
 * When local history takes snapshots (S21.2, PLAN §7: "retaining necessary versions around coalesced save batches
 * and before formatting, deletion, and restoration"). Main process only.
 *
 * - Save: before replacing a file the save path hands over the bytes it already read and verified
 *   (`captureBeforeSave`, the one step that must precede the write, bounded by the caller's timeout; it does no disk
 *   I/O, so a loaded machine cannot make it time out). Storing the before/after versions is queued (`recordSave`)
 *   and never awaited by the save, so history work cannot slow down or fail a save.
 * - Format, delete, restore: the current disk content is stored before the operation changes or removes it; these
 *   calls are awaited by their callers because the content is gone afterwards.
 *
 * Every trigger catches its own failures (logged without content).
 */
export interface SaveHistoryHook {
  /**
   * The version of the file about to be replaced that history should keep, given `current` — the bytes the save just
   * read from disk and checked (the replace only proceeds while the file still has exactly these bytes); `null` when
   * there is nothing to keep.
   */
  captureBeforeSave(absPath: string, current: Uint8Array): Promise<Uint8Array | null>;
  /** Queues the versions around one save batch. `after` is `null` when the save failed. Returns immediately. */
  recordSave(rootPath: string, relPath: string, before: Uint8Array | null, after: Uint8Array | null): void;
}

/** Files under a deleted folder that get a snapshot; larger trees keep the first ones (sorted) only. */
export const MAX_FILES_PER_DELETE = 500;

export class HistoryTriggers implements SaveHistoryHook {
  private pending = new Set<Promise<void>>();

  constructor(
    private readonly store: Pick<SnapshotStore, 'snapshot' | 'limits'>,
    private readonly log: RecoveryLogger = silentLogger,
  ) {}

  async captureBeforeSave(_absPath: string, current: Uint8Array): Promise<Uint8Array | null> {
    // S21.5: the save already read (and hash-checked) these bytes; re-reading the file here cost a second disk read
    // that, on a loaded machine, could outlast the save's capture timeout and silently drop the before-save version.
    if (current.length > this.store.limits.maxSnapshotBytes) {
      this.log('history.snapshot-skipped', { reason: 'too-large', bytes: current.length });
      return null;
    }
    return current;
  }

  recordSave(rootPath: string, relPath: string, before: Uint8Array | null, after: Uint8Array | null): void {
    // Both snapshots enter the store's queue now, synchronously, so consecutive saves are stored in save order
    // (before₁, after₁, before₂, after₂ …) and a before-save equal to the previous after-save is deduped.
    const jobs: Promise<void>[] = [];
    if (before) jobs.push(this.safely(() => this.store.snapshot(rootPath, relPath, before, 'before-save')));
    if (after) jobs.push(this.safely(() => this.store.snapshot(rootPath, relPath, after, 'after-save')));
    const work = Promise.all(jobs).then(() => undefined);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  /** Resolves when every queued save snapshot has been stored (tests, orderly shutdown). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /** Before the formatter rewrites a file. */
  async beforeFormat(rootPath: string, relPath: string, absPath: string): Promise<void> {
    await this.snapshotFile(rootPath, relPath, absPath, 'before-format');
  }

  /** Before restoring an older version over the current file. */
  async beforeRestore(rootPath: string, relPath: string, absPath: string): Promise<void> {
    await this.snapshotFile(rootPath, relPath, absPath, 'before-restore');
  }

  /**
   * Before a file or folder is moved to the trash: every file inside that the project listing would show gets a
   * snapshot — the same filters as the listing (no dotfiles such as `.env`, no `node_modules`, links not followed),
   * so secrets and dependency folders are never copied into app data.
   */
  async beforeDelete(rootPath: string, relPath: string, absPath: string): Promise<void> {
    let info;
    try {
      info = await stat(absPath);
    } catch (e) {
      if (errorCode(e) !== 'ENOENT')
        this.log('history.trigger-failed', { reason: 'before-delete', code: errorCode(e) });
      return;
    }
    if (info.isFile()) {
      if (isListedEntry(path.basename(absPath), false))
        await this.snapshotFile(rootPath, relPath, absPath, 'before-delete');
      return;
    }
    if (!info.isDirectory() || !isListedEntry(path.basename(absPath), true)) return;
    const files: { rel: string; abs: string }[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (e) {
        this.log('history.trigger-failed', { reason: 'before-delete', code: errorCode(e) });
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (files.length >= MAX_FILES_PER_DELETE) return;
        if (entry.isSymbolicLink() || !isListedEntry(entry.name, entry.isDirectory())) continue;
        const childRel = `${rel}${path.posix.sep}${entry.name}`;
        const childAbs = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(childAbs, childRel);
        else if (entry.isFile()) files.push({ rel: childRel, abs: childAbs });
      }
    };
    await walk(absPath, relPath);
    for (const file of files) await this.snapshotFile(rootPath, file.rel, file.abs, 'before-delete');
  }

  /**
   * S34.2: keeps a file's current content as a version of an AI change group (`before-ai` right before the change,
   * `after-ai` right after it). Returns the content's hash and the version id (null when the content could not be
   * kept, e.g. too large or history unavailable), or null when the file does not exist or cannot be read.
   */
  async snapshotForGroup(
    rootPath: string,
    relPath: string,
    absPath: string,
    reason: 'before-ai' | 'after-ai',
    group: string,
  ): Promise<{ readonly hash: string; readonly id: string | null } | null> {
    let data: Uint8Array;
    try {
      const info = await stat(absPath);
      // The agent changes text files only; anything larger was not its change.
      if (!info.isFile() || info.size > MAX_TEXT_FILE_BYTES) return null;
      data = await readFile(absPath);
    } catch (e) {
      if (errorCode(e) !== 'ENOENT') this.log('history.trigger-failed', { reason, code: errorCode(e) });
      return null;
    }
    const hash = sha256Hex(data);
    try {
      const stored = await this.store.snapshot(rootPath, relPath, data, reason, { group });
      return { hash, id: stored.ok ? stored.value.snapshot.id : null };
    } catch (e) {
      this.log('history.trigger-failed', { reason, code: errorCode(e) });
      return { hash, id: null };
    }
  }

  private async readSnapshotable(absPath: string, reason: SnapshotReason): Promise<Uint8Array | null> {
    try {
      const info = await stat(absPath);
      if (!info.isFile()) return null;
      if (info.size > this.store.limits.maxSnapshotBytes) {
        this.log('history.snapshot-skipped', { reason: 'too-large', bytes: info.size });
        return null;
      }
      return await readFile(absPath);
    } catch (e) {
      // A file that does not exist yet has nothing to keep.
      if (errorCode(e) !== 'ENOENT') this.log('history.trigger-failed', { reason, code: errorCode(e) });
      return null;
    }
  }

  private async snapshotFile(rootPath: string, relPath: string, absPath: string, reason: SnapshotReason) {
    const data = await this.readSnapshotable(absPath, reason);
    if (data) await this.safely(() => this.store.snapshot(rootPath, relPath, data, reason));
  }

  private async safely(op: () => Promise<unknown>): Promise<void> {
    try {
      await op();
    } catch (e) {
      this.log('history.trigger-failed', { code: errorCode(e) });
    }
  }
}
