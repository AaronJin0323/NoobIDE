import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { SerialQueue, writeFileAtomic, type RecoveryLogger } from '../recovery/atomic-file';
import { backupFile, readJsonFile, schemaVersionOf } from './json-file';

/**
 * Recent projects (S13.3), kept in app data (`recent-projects.json`, versioned like settings). Each entry has an
 * opaque id; the renderer opens or removes projects by that id only, main keeps the real root path. Removing an entry
 * only edits this list — nothing on disk is ever touched. A folder that no longer exists is reported as unavailable
 * (`available: false`) instead of being dropped silently, so the user sees what happened to it. A list written by a
 * newer NoobIDE (S28.4 downgrade) is shown but never written.
 */
export const RECENT_VERSION = 1;
export const MAX_RECENT = 12;

export interface RecentEntry {
  readonly id: string;
  /** Real absolute path of the project root. */
  readonly rootPath: string;
  readonly lastOpened: number;
}

/** One row as the welcome screen shows it (src/renderer/welcome/welcome-model.ts RecentProject). */
export interface RecentProjectView {
  readonly id: string;
  readonly name: string;
  /** Absolute path, for display only. */
  readonly path: string;
  readonly available: boolean;
  readonly lastOpened: number;
}

export interface RecentProjectsOptions {
  readonly file: string;
  readonly log?: RecoveryLogger;
  readonly max?: number;
  readonly now?: () => number;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseEntries(value: unknown): RecentEntry[] | null {
  if (schemaVersionOf(value, RECENT_VERSION).kind === 'invalid') return null;
  // An older or a newer (S28.4) file is read the same way: every well-formed entry is kept.
  const { projects } = value as { projects?: unknown };
  if (!Array.isArray(projects)) return null;
  const out: RecentEntry[] = [];
  for (const p of projects) {
    if (typeof p !== 'object' || p === null) continue;
    const { id, rootPath, lastOpened } = p as Record<string, unknown>;
    // Entries that are not well-formed are skipped one by one; the rest of the list survives.
    if (typeof id !== 'string' || !ID.test(id)) continue;
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) continue;
    if (typeof lastOpened !== 'number' || !Number.isFinite(lastOpened)) continue;
    out.push({ id, rootPath, lastOpened });
  }
  return out;
}

export class RecentProjects {
  private entries: RecentEntry[] = [];
  private loaded: Promise<void> | null = null;
  private writable = true;
  private readonly queue = new SerialQueue();

  constructor(private readonly options: RecentProjectsOptions) {}

  private load(): Promise<void> {
    this.loaded ??= this.queue.run(async () => {
      const read = await readJsonFile(this.options.file);
      if (read.kind === 'missing') return;
      if (read.kind === 'unreadable') {
        this.writable = false;
        this.options.log?.('recent-unreadable', { code: read.code });
        return;
      }
      const parsed = read.kind === 'parsed' ? parseEntries(read.value) : null;
      if (parsed) {
        this.entries = parsed;
        if (read.kind === 'parsed' && schemaVersionOf(read.value, RECENT_VERSION).kind === 'newer') {
          // S28.4 downgrade: written by a newer NoobIDE — use it, never write it (changes last until quit).
          this.writable = false;
          this.options.log?.('recent-newer-version', { readOnly: true });
        }
        return;
      }
      // Unusable list: keep it as a backup (never overwritten) and start empty.
      const backup = await backupFile(this.options.file, 'corrupt');
      this.options.log?.('recent-reset', { backedUp: backup !== null });
      if (backup === null) this.writable = false;
    });
    return this.loaded;
  }

  /** The list, newest first, with each folder's availability checked now. */
  async list(): Promise<RecentProjectView[]> {
    void this.load();
    const entries = await this.queue.run(async () => [...this.entries]);
    return Promise.all(
      entries.map(async (e) => ({
        id: e.id,
        name: path.basename(e.rootPath),
        path: e.rootPath,
        available: await isDirectory(e.rootPath),
        lastOpened: e.lastOpened,
      })),
    );
  }

  /** Root path of an entry, or undefined for an unknown id. */
  async rootOf(id: string): Promise<string | undefined> {
    void this.load();
    return this.queue.run(async () => this.entries.find((e) => e.id === id)?.rootPath);
  }

  /** A project was opened (folder dialog, recent list, crash recovery, session restore): move it to the top. */
  touch(rootPath: string): Promise<void> {
    void this.load();
    return this.queue.run(async () => {
      const existing = this.entries.find((e) => e.rootPath === rootPath);
      const entry: RecentEntry = {
        id: existing?.id ?? randomUUID(),
        rootPath,
        lastOpened: this.options.now?.() ?? Date.now(),
      };
      this.entries = [entry, ...this.entries.filter((e) => e.rootPath !== rootPath)].slice(
        0,
        this.options.max ?? MAX_RECENT,
      );
      await this.persist();
    });
  }

  /** Removes an entry from the list. Only this list changes; the folder is never touched. */
  remove(id: string): Promise<boolean> {
    void this.load();
    return this.queue.run(async () => {
      const before = this.entries.length;
      this.entries = this.entries.filter((e) => e.id !== id);
      if (this.entries.length === before) return false;
      await this.persist();
      return true;
    });
  }

  /** Resolves once every change queued so far is written (or has failed); used before quitting. */
  flush(): Promise<void> {
    return this.queue.run(async () => undefined);
  }

  private async persist(): Promise<void> {
    if (!this.writable) return;
    try {
      const body = { version: RECENT_VERSION, projects: this.entries };
      await writeFileAtomic(this.options.file, `${JSON.stringify(body, null, 2)}\n`);
    } catch (e) {
      this.options.log?.('recent-write-failed', { code: (e as { code?: string }).code ?? 'unknown' });
    }
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
