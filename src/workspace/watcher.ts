import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { WatchEvent } from '../shared/ipc/contract';
import { differsOnlyByCase } from '../shared/file-names';
import { isIgnoredName, isIgnoredRelPath } from './ignore';

/**
 * Project file watcher (S07.3, ADR 0007). One recursive `fs.watch` per open project — native on Windows
 * (ReadDirectoryChangesW) and macOS (FSEvents), no extra dependency — followed by our own debounce and
 * classification, because raw events differ per platform: Windows reports a rename as two `rename` events,
 * macOS may coalesce several, and both report atomic saves as renames.
 *
 * After a quiet period the batch is classified against `known`, an exact-name snapshot of the project:
 *   exists now + known → changed (files only) · exists + unknown → created · gone + known → deleted.
 * Existence is decided by an exact, case-sensitive name match in the parent's listing, so a case-only rename on a
 * case-insensitive volume (Windows, default macOS) is still seen. A deletion and a creation of the same kind in one
 * batch pair up as a rename (same folder) or move (same name); `caseOnly` marks renames that only change case.
 */
export interface WatcherOptions {
  /** Quiet period before a batch is emitted. */
  readonly debounceMs?: number;
  /** Upper bound on how long events are held while changes keep arriving. */
  readonly maxWaitMs?: number;
  /** Largest number of entries kept in the snapshot; beyond it, unknown paths count as created. */
  readonly maxKnown?: number;
}

type Kind = 'file' | 'directory';

export class ProjectWatcher {
  private watcher: FSWatcher | null = null;
  private readonly known = new Map<string, Kind>();
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private firstPendingAt = 0;
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly maxKnown: number;

  constructor(
    private readonly root: string,
    private readonly emit: (events: WatchEvent[]) => void,
    options: WatcherOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 100;
    this.maxWaitMs = options.maxWaitMs ?? 1000;
    this.maxKnown = options.maxKnown ?? 50_000;
  }

  /** Takes the snapshot, then starts watching. Resolves once events will be reported. */
  async start(): Promise<void> {
    await this.scan(this.root, '');
    if (this.closed) return;
    this.watcher = fsWatch(this.root, { recursive: true, encoding: 'utf8' }, (_eventType, filename) =>
      this.onRaw(filename),
    );
    // The project folder itself was removed, renamed or became unreadable: the tree must be reloaded.
    this.watcher.on('error', () => this.emit([{ type: 'rescan' }]));
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Resolves when every batch received so far has been emitted (tests). */
  async idle(): Promise<void> {
    await this.flushing;
  }

  private onRaw(filename: string | null): void {
    if (this.closed) return;
    if (filename === null) {
      this.emit([{ type: 'rescan' }]);
      return;
    }
    const relPath = filename.split(path.sep).join('/');
    if (relPath === '' || isIgnoredRelPath(relPath)) return;
    this.pending.add(relPath);
    const now = Date.now();
    if (this.timer === null) this.firstPendingAt = now;
    else clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstPendingAt + this.maxWaitMs - now));
    this.timer = setTimeout(() => {
      this.timer = null;
      const batch = this.pending;
      this.pending = new Set();
      this.flushing = this.flushing.then(() => this.flush(batch)).catch(() => this.emit([{ type: 'rescan' }]));
    }, wait);
  }

  private async flush(batch: Set<string>): Promise<void> {
    if (this.closed) return;
    const listings = new Map<string, Map<string, Kind> | null>();
    const listing = async (dirRel: string) => {
      if (!listings.has(dirRel)) listings.set(dirRel, await this.list(dirRel));
      return listings.get(dirRel) ?? null;
    };

    const created: { relPath: string; kind: Kind }[] = [];
    const deleted: { relPath: string; kind: Kind }[] = [];
    const changed: string[] = [];
    // Parents first, so a folder created together with its files is reported once, as the folder.
    const paths = [...batch].sort((a, b) => a.split('/').length - b.split('/').length);
    for (const relPath of paths) {
      const slash = relPath.lastIndexOf('/');
      const parent = slash < 0 ? '' : relPath.slice(0, slash);
      const name = relPath.slice(slash + 1);
      const nowKind = (await listing(parent))?.get(name);
      const before = this.known.get(relPath);
      if (nowKind !== undefined && before === undefined) {
        if (created.some((c) => c.kind === 'directory' && relPath.startsWith(`${c.relPath}/`))) continue;
        created.push({ relPath, kind: nowKind });
      } else if (nowKind === undefined && before !== undefined) {
        if (deleted.some((d) => d.kind === 'directory' && relPath.startsWith(`${d.relPath}/`))) continue;
        deleted.push({ relPath, kind: before });
      } else if (nowKind === 'file' && before === 'file') {
        // Written in place (`change`) or replaced by a rename (an external editor's atomic save).
        changed.push(relPath);
      }
    }

    const events: WatchEvent[] = [];
    // Pair renames and moves: one deletion with one creation of the same kind, same folder or same name.
    for (const gone of [...deleted]) {
      const goneParent = parentOf(gone.relPath);
      const goneName = baseOf(gone.relPath);
      const sameFolder = created.filter((c) => c.kind === gone.kind && parentOf(c.relPath) === goneParent);
      const sameName = created.filter((c) => c.kind === gone.kind && baseOf(c.relPath) === goneName);
      const match = sameFolder.length === 1 ? sameFolder[0] : sameName.length === 1 ? sameName[0] : undefined;
      if (!match) continue;
      created.splice(created.indexOf(match), 1);
      deleted.splice(deleted.indexOf(gone), 1);
      events.push({
        type: 'renamed',
        from: gone.relPath,
        to: match.relPath,
        caseOnly: goneParent === parentOf(match.relPath) && differsOnlyByCase(goneName, baseOf(match.relPath)),
      });
      this.rebaseKnown(gone.relPath, match.relPath);
    }
    for (const d of deleted) {
      events.push({ type: 'deleted', relPath: d.relPath });
      this.forget(d.relPath);
    }
    for (const c of created) {
      events.push({ type: 'created', relPath: c.relPath });
      this.remember(c.relPath, c.kind);
      if (c.kind === 'directory') await this.scan(path.join(this.root, ...c.relPath.split('/')), c.relPath);
    }
    for (const relPath of changed) events.push({ type: 'changed', relPath });
    if (events.length > 0 && !this.closed) this.emit(events);
  }

  private async list(dirRel: string): Promise<Map<string, Kind> | null> {
    try {
      const dirents = await readdir(path.join(this.root, ...(dirRel === '' ? [] : dirRel.split('/'))), {
        withFileTypes: true,
      });
      const names = new Map<string, Kind>();
      for (const d of dirents) {
        if (isIgnoredName(d.name)) continue;
        if (d.isDirectory()) names.set(d.name, 'directory');
        else if (d.isFile() || d.isSymbolicLink()) names.set(d.name, 'file');
      }
      return names;
    } catch {
      return null; // The folder itself is gone: everything in it counts as deleted.
    }
  }

  private async scan(dir: string, relDir: string): Promise<void> {
    if (this.known.size >= this.maxKnown) return;
    const names = await this.list(relDir);
    if (!names) return;
    for (const [name, kind] of names) {
      if (this.known.size >= this.maxKnown) return;
      const relPath = relDir === '' ? name : `${relDir}/${name}`;
      this.known.set(relPath, kind);
      if (kind === 'directory') await this.scan(path.join(dir, name), relPath);
    }
  }

  private remember(relPath: string, kind: Kind): void {
    if (this.known.size < this.maxKnown) this.known.set(relPath, kind);
  }

  private forget(relPath: string): void {
    for (const key of [...this.known.keys()]) {
      if (key === relPath || key.startsWith(`${relPath}/`)) this.known.delete(key);
    }
  }

  private rebaseKnown(from: string, to: string): void {
    for (const [key, kind] of [...this.known.entries()]) {
      if (key === from || key.startsWith(`${from}/`)) {
        this.known.delete(key);
        this.known.set(to + key.slice(from.length), kind);
      }
    }
  }
}

function parentOf(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? '' : relPath.slice(0, i);
}

function baseOf(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1);
}
