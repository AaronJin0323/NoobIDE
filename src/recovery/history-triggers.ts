import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { errorCode, silentLogger, type RecoveryLogger } from './atomic-file';
import type { SnapshotReason, SnapshotStore } from './history';

/**
 * When local history takes snapshots (S21.2, PLAN §7: "retaining necessary versions around coalesced save batches
 * and before formatting, deletion, and restoration"). Main process only.
 *
 * - Save: `beforeSave` keeps what is on disk right before a save batch overwrites it, `afterSave` keeps what the batch
 *   wrote. The save pipeline calls them once per coalesced batch; the store dedupes identical content and coalesces
 *   rapid `after-save` versions of one burst.
 * - Format, delete, restore: the current disk content is kept before the operation changes or removes it.
 *
 * History is a safety net, never a gate: every trigger catches its own failures (logged without content) and never
 * blocks or fails the user's save, delete or restore.
 */
export interface SaveHistoryHook {
  beforeSave(rootPath: string, relPath: string, absPath: string): Promise<void>;
  afterSave(rootPath: string, relPath: string, data: Uint8Array): Promise<void>;
}

/** Files under a deleted folder that get a snapshot; larger trees keep the first ones (sorted) only. */
export const MAX_FILES_PER_DELETE = 500;

export class HistoryTriggers implements SaveHistoryHook {
  constructor(
    private readonly store: Pick<SnapshotStore, 'snapshot' | 'limits'>,
    private readonly log: RecoveryLogger = silentLogger,
  ) {}

  async beforeSave(rootPath: string, relPath: string, absPath: string): Promise<void> {
    await this.snapshotFile(rootPath, relPath, absPath, 'before-save');
  }

  async afterSave(rootPath: string, relPath: string, data: Uint8Array): Promise<void> {
    await this.safely(() => this.store.snapshot(rootPath, relPath, data, 'after-save'));
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
   * Before a file or folder is moved to the trash: every regular file inside (links are not followed, dot-folders
   * skipped like the project listing) gets a snapshot, so a deleted file can be restored from history.
   */
  async beforeDelete(rootPath: string, relPath: string, absPath: string): Promise<void> {
    let info;
    try {
      info = await stat(absPath);
    } catch (e) {
      this.log('history.trigger-failed', { reason: 'before-delete', code: errorCode(e) });
      return;
    }
    if (info.isFile()) {
      await this.snapshotFile(rootPath, relPath, absPath, 'before-delete');
      return;
    }
    if (!info.isDirectory()) return;
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
        if (entry.isSymbolicLink()) continue;
        const childRel = `${rel}${path.posix.sep}${entry.name}`;
        const childAbs = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) await walk(childAbs, childRel);
        else if (entry.isFile()) files.push({ rel: childRel, abs: childAbs });
      }
    };
    await walk(absPath, relPath);
    for (const file of files) await this.snapshotFile(rootPath, file.rel, file.abs, 'before-delete');
  }

  private async snapshotFile(rootPath: string, relPath: string, absPath: string, reason: SnapshotReason) {
    let data: Buffer;
    try {
      const info = await stat(absPath);
      if (!info.isFile()) return;
      if (info.size > this.store.limits.maxSnapshotBytes) {
        this.log('history.snapshot-skipped', { reason: 'too-large', bytes: info.size });
        return;
      }
      data = await readFile(absPath);
    } catch (e) {
      // A file that does not exist yet has nothing to keep.
      if (errorCode(e) !== 'ENOENT') this.log('history.trigger-failed', { reason, code: errorCode(e) });
      return;
    }
    await this.safely(() => this.store.snapshot(rootPath, relPath, data, reason));
  }

  private async safely(op: () => Promise<unknown>): Promise<void> {
    try {
      await op();
    } catch (e) {
      this.log('history.trigger-failed', { code: errorCode(e) });
    }
  }
}
