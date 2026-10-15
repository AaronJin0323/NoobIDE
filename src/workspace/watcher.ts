import { watch as fsWatch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
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
 * After a quiet period the batch is classified against an exact-name snapshot of the project, indexed by folder:
 *   exists now + known → changed (files only) · exists + unknown → created · gone + known → deleted ·
 *   gone + unknown (created and removed again within the batch) → deleted, because a listing made meanwhile may
 *   show it (a create and delete that fall into one batch is common with FSEvents' delivery latency on macOS).
 * Existence is decided by an exact, case-sensitive name match in the parent's listing, so a case-only rename on a
 * case-insensitive volume (Windows, default macOS) is still seen. A deletion and a creation of the same kind in one
 * batch pair up as a rename (same folder) or move (same name); `caseOnly` marks renames that only change case.
 * The two halves of a rename can arrive in different batches: libuv creates its FSEvents stream with `NoDefer`, so
 * the first event after a quiet period (the old name) is delivered at once and the rest (the new name) only after
 * the stream's 50 ms latency, which on a busy machine can exceed the debounce. So a deletion that finds no partner is
 * held for `renameWaitMs` (re-checked with the next batch) before it is reported; a creation arriving meanwhile
 * still pairs with it. Only unpaired deletions wait; everything else is reported after the debounce as before.
 *
 * Cost stays bounded: snapshot updates touch only the affected folder subtree, and a batch with more than
 * `maxBatch` paths (a mass delete, an unzip) becomes one `rescan` instead of per-path work. If the OS watch fails
 * or stops (`error`), the watcher reports `rescan` and restarts itself with a growing delay.
 *
 * FSEvents (macOS) replays changes made shortly *before* the stream was created: right after attaching, every file
 * written in the last moments (e.g. a project just created from a template) arrives as a raw event, which would be
 * classified as `changed` although nothing changed since the snapshot. So for raw events received within
 * `replayWindowMs` of attaching, a `changed` is only reported if the file's ctime is not older than the snapshot.
 * ctime cannot be set by programs, and any write or rename updates it; outside the window no stat is made.
 */
export interface WatcherOptions {
  /** Quiet period before a batch is emitted. */
  readonly debounceMs?: number;
  /** Upper bound on how long events are held while changes keep arriving. */
  readonly maxWaitMs?: number;
  /** Largest number of entries kept in the snapshot; beyond it, unknown paths count as created. */
  readonly maxKnown?: number;
  /** Batches with more changed paths than this are reported as a single `rescan`. */
  readonly maxBatch?: number;
  /** Delays before restart attempts after the OS watch failed (the last one repeats). */
  readonly restartDelaysMs?: readonly number[];
  /** After attaching, how long raw events are checked for being replays of changes made before the snapshot. */
  readonly replayWindowMs?: number;
  /** How long a deletion without a matching creation waits for the other half of a rename (see class comment). */
  readonly renameWaitMs?: number;
  /** The OS watch, injectable for tests. */
  readonly watch?: WatchFn;
}

/** The part of fs.watch the watcher uses. */
export type WatchFn = (
  root: string,
  onChange: (filename: string | null) => void,
) => { on(event: 'error', listener: (error: unknown) => void): unknown; close(): void };

const defaultWatch: WatchFn = (root, onChange) =>
  fsWatch(root, { recursive: true, encoding: 'utf8' }, (_eventType, filename) => onChange(filename));

type Kind = 'file' | 'directory';

/** Allowed ctime-vs-Date.now() clock disagreement when deciding whether a raw event is a replay (see predatesSnapshot). */
const CLOCK_SKEW_TOLERANCE_MS = 2;

export class ProjectWatcher {
  private watcher: ReturnType<WatchFn> | null = null;
  /** Snapshot: children (exact name → kind) per folder relPath; `''` is the root. */
  private readonly dirs = new Map<string, Map<string, Kind>>();
  private knownCount = 0;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private firstPendingAt = 0;
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;
  /** When the current snapshot was started (ms since epoch) and when the OS watch was last attached. */
  private snapshotStartedAt = 0;
  private attachedAt = 0;
  /** Paths whose raw events arrived inside the replay window (see class comment). */
  private early = new Set<string>();
  /** Deletions waiting for the other half of a rename: relPath → when to report them as deleted (ms since epoch). */
  private readonly held = new Map<string, number>();
  private readonly replayWindowMs: number;
  private readonly renameWaitMs: number;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly maxKnown: number;
  private readonly maxBatch: number;
  private readonly restartDelaysMs: readonly number[];
  private readonly watchFn: WatchFn;

  constructor(
    private readonly root: string,
    private readonly emit: (events: WatchEvent[]) => void,
    options: WatcherOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 100;
    this.maxWaitMs = options.maxWaitMs ?? 1000;
    this.maxKnown = options.maxKnown ?? 50_000;
    this.maxBatch = options.maxBatch ?? 500;
    this.restartDelaysMs = options.restartDelaysMs ?? [1000, 2000, 5000, 10_000, 30_000];
    this.watchFn = options.watch ?? defaultWatch;
    this.replayWindowMs = options.replayWindowMs ?? 1000;
    this.renameWaitMs = options.renameWaitMs ?? 400;
  }

  /** Takes the snapshot, then starts watching. Resolves once events will be reported (or a restart is scheduled). */
  async start(): Promise<void> {
    await this.rebuildSnapshot();
    this.attach();
  }

  close(): void {
    this.closed = true;
    this.detach();
    if (this.timer) clearTimeout(this.timer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.timer = null;
    this.restartTimer = null;
    this.pending.clear();
    this.early.clear();
    this.held.clear();
    this.dirs.clear();
    this.knownCount = 0;
  }

  /**
   * S25.1/S25.2 (decision 0027): the computer woke from sleep. An OS watch can die silently or miss events while
   * the machine sleeps (FSEvents may coalesce or drop history; ReadDirectoryChangesW handles can be dropped by a
   * network or USB volume going away), so the watch is re-attached on a fresh snapshot and `rescan` is reported:
   * listeners reload the tree and compare open files with the disk. Serialised after batches already in flight;
   * pending raw events are dropped because the rescan covers them. Never rejects.
   */
  resync(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.flushing = this.flushing
      .then(async () => {
        if (this.closed) return;
        this.detach();
        if (this.timer) clearTimeout(this.timer);
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.timer = null;
        this.restartTimer = null;
        this.pending.clear();
        this.early.clear();
        this.held.clear();
        await this.rebuildSnapshot();
        if (this.closed) return;
        this.attach();
        this.emit([{ type: 'rescan' }]);
      })
      .catch(() => {
        if (this.closed) return;
        this.emit([{ type: 'rescan' }]);
        if (!this.watcher) this.scheduleRestart(); // never left without a watch
      });
    return this.flushing;
  }

  /** Resolves when every batch received so far has been emitted (tests). */
  async idle(): Promise<void> {
    await this.flushing;
  }

  /** Number of entries in the snapshot (tests). */
  get snapshotSize(): number {
    return this.knownCount;
  }

  private attach(): void {
    if (this.closed) return;
    this.detach(); // never two OS watches (a resync can overlap the first start)
    try {
      const watcher = this.watchFn(this.root, (filename) => this.onRaw(filename));
      watcher.on('error', () => this.lost(watcher));
      this.watcher = watcher;
      this.attachedAt = Date.now();
      this.restartAttempt = 0;
    } catch {
      this.scheduleRestart();
    }
  }

  private detach(): void {
    try {
      this.watcher?.close();
    } catch {
      // already closed by the OS
    }
    this.watcher = null;
  }

  /** The OS watch died (folder removed or renamed, handle limit…): report it and try again later. */
  private lost(watcher: ReturnType<WatchFn>): void {
    if (this.closed || watcher !== this.watcher) return;
    this.detach();
    this.emit([{ type: 'rescan' }]);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.closed || this.restartTimer) return;
    const delays = this.restartDelaysMs;
    const delay = delays[Math.min(this.restartAttempt, delays.length - 1)] ?? 30_000;
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.rebuildSnapshot().then(() => {
        if (this.closed) return;
        this.attach();
        if (this.watcher) this.emit([{ type: 'rescan' }]); // changes while not watching are picked up by a reload
      });
    }, delay);
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
    if (now - this.attachedAt < this.replayWindowMs) this.early.add(relPath);
    if (this.timer === null) this.firstPendingAt = now;
    else clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstPendingAt + this.maxWaitMs - now));
    this.timer = setTimeout(this.fire, wait);
  }

  /** Classifies everything pending as one batch (after the batches before it). */
  private readonly fire = (): void => {
    this.timer = null;
    const batch = this.pending;
    this.pending = new Set();
    this.flushing = this.flushing.then(() => this.flush(batch)).catch(() => this.emit([{ type: 'rescan' }]));
  };

  /** Puts held deletions back into the pending batch; it is classified by the next raw event or when the first wait ends. */
  private requeueHeld(relPaths: readonly string[]): void {
    if (relPaths.length === 0 || this.closed) return;
    for (const relPath of relPaths) this.pending.add(relPath);
    if (this.timer !== null) return; // a batch is already scheduled and takes them along
    const now = Date.now();
    const due = Math.min(...relPaths.map((relPath) => this.held.get(relPath) ?? now));
    this.firstPendingAt = now;
    this.timer = setTimeout(this.fire, Math.max(0, due - now));
  }

  private async flush(batch: Set<string>): Promise<void> {
    if (this.closed) return;
    const early = new Set([...batch].filter((relPath) => this.early.delete(relPath)));
    if (batch.size > this.maxBatch) {
      // Mass change: one reload is cheaper than classifying every path, and keeps the main process responsive.
      this.held.clear();
      await this.rebuildSnapshot();
      if (!this.closed) this.emit([{ type: 'rescan' }]);
      return;
    }
    const listings = new Map<string, Map<string, Kind> | null>();
    const listing = async (dirRel: string) => {
      if (!listings.has(dirRel)) listings.set(dirRel, await this.list(dirRel));
      return listings.get(dirRel) ?? null;
    };

    const created: { relPath: string; kind: Kind }[] = [];
    const deleted: { relPath: string; kind: Kind }[] = [];
    const changed: string[] = [];
    /** Held deletions that are back on disk: reported as deleted, then created (listeners may have dropped them). */
    const returned: { relPath: string; kind: Kind }[] = [];
    const createdDirs = new Set<string>();
    const deletedDirs = new Set<string>();
    /** Paths that came and went within this batch: neither in the snapshot nor on disk now. */
    const vanished = new Set<string>();
    const underAny = (relPath: string, dirsSet: Set<string>) => {
      for (let p = parentOf(relPath); p !== ''; p = parentOf(p)) if (dirsSet.has(p)) return true;
      return false;
    };
    // Parents first, so a folder created together with its files is reported once, as the folder.
    const paths = [...batch].sort((a, b) => a.split('/').length - b.split('/').length);
    for (const relPath of paths) {
      const nowKind = (await listing(parentOf(relPath)))?.get(baseOf(relPath));
      const before = this.getKnown(relPath);
      if (nowKind !== undefined && before === undefined) {
        if (underAny(relPath, createdDirs)) continue;
        created.push({ relPath, kind: nowKind });
        if (nowKind === 'directory') createdDirs.add(relPath);
      } else if (nowKind === undefined && before !== undefined) {
        if (underAny(relPath, deletedDirs)) continue;
        deleted.push({ relPath, kind: before });
        if (before === 'directory') deletedDirs.add(relPath);
      } else if (nowKind !== undefined && before !== undefined && this.held.has(relPath)) {
        returned.push({ relPath, kind: nowKind });
      } else if (nowKind === 'file' && before === 'file') {
        // Written in place (`change`) or replaced by a rename (an external editor's atomic save).
        if (early.has(relPath) && (await this.predatesSnapshot(relPath))) continue;
        changed.push(relPath);
      } else if (nowKind === undefined && before === undefined) {
        // Created and removed again before the batch was classified. There is no net change against the snapshot,
        // but a folder listing made in between (e.g. the tree reloading for an unrelated event) may show the entry:
        // report it gone so it is refreshed. Entries inside a folder that is reported anyway are covered by it.
        if (underAny(relPath, deletedDirs) || underAny(relPath, createdDirs) || underAny(relPath, vanished)) continue;
        // FSEvents (via libuv) names an event on the watched folder itself by the folder's own name.
        if (relPath === path.basename(this.root)) continue;
        vanished.add(relPath);
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
    // A deletion without a partner may be the first half of a rename whose second half is still on its way.
    const now = Date.now();
    const waiting: string[] = [];
    for (const relPath of batch) {
      if (!deleted.some((d) => d.relPath === relPath)) this.held.delete(relPath); // paired, back, or something else
    }
    for (const d of deleted) {
      const due = this.held.get(d.relPath) ?? now + this.renameWaitMs;
      if (due > now) {
        this.held.set(d.relPath, due);
        waiting.push(d.relPath);
        continue;
      }
      this.held.delete(d.relPath);
      events.push({ type: 'deleted', relPath: d.relPath });
      this.forget(d.relPath);
    }
    for (const relPath of vanished) events.push({ type: 'deleted', relPath });
    for (const r of returned) {
      events.push({ type: 'deleted', relPath: r.relPath }, { type: 'created', relPath: r.relPath });
      this.forget(r.relPath);
      this.remember(r.relPath, r.kind);
      if (r.kind === 'directory') await this.scan(r.relPath);
    }
    for (const c of created) {
      events.push({ type: 'created', relPath: c.relPath });
      this.remember(c.relPath, c.kind);
      if (c.kind === 'directory') await this.scan(c.relPath);
    }
    for (const relPath of changed) events.push({ type: 'changed', relPath });
    if (events.length > 0 && !this.closed) this.emit(events);
    this.requeueHeld(waiting);
  }

  /** Whether the file's last change (ctime) is older than the snapshot, i.e. the raw event was a replay. */
  private async predatesSnapshot(relPath: string): Promise<boolean> {
    try {
      const info = await stat(path.join(this.root, ...relPath.split('/')));
      // Date.now() and file timestamps come from different clocks. On Windows the NTFS ctime of a write that
      // finished just before the snapshot can read up to ~1 ms *later* than Date.now() taken afterwards (measured:
      // +1 ms in ~5% of writes, also under CPU load); elsewhere the sub-ms truncation alone gives the same shape.
      // Allow a small tolerance so such a write still counts as predating the snapshot. A genuine edit made after
      // attaching lands well past it (editors and the tests need more than a couple of ms to start the change).
      return Math.floor(info.ctimeMs) <= this.snapshotStartedAt + CLOCK_SKEW_TOLERANCE_MS;
    } catch {
      return false;
    }
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

  private async rebuildSnapshot(): Promise<void> {
    this.dirs.clear();
    this.knownCount = 0;
    this.snapshotStartedAt = Date.now();
    await this.scan('');
  }

  /** Adds `relDir`'s subtree to the snapshot (breadth-first, async, bounded by maxKnown). */
  private async scan(relDir: string): Promise<void> {
    const queue = [relDir];
    while (queue.length > 0 && !this.closed) {
      const dir = queue.shift() as string;
      if (this.knownCount >= this.maxKnown) return;
      const names = await this.list(dir);
      if (!names) continue;
      for (const [name, kind] of names) {
        if (this.knownCount >= this.maxKnown) return;
        const relPath = dir === '' ? name : `${dir}/${name}`;
        this.remember(relPath, kind);
        if (kind === 'directory') queue.push(relPath);
      }
    }
  }

  private getKnown(relPath: string): Kind | undefined {
    return this.dirs.get(parentOf(relPath))?.get(baseOf(relPath));
  }

  private remember(relPath: string, kind: Kind): void {
    const parent = parentOf(relPath);
    let children = this.dirs.get(parent);
    if (!children) {
      children = new Map();
      this.dirs.set(parent, children);
    }
    if (!children.has(baseOf(relPath))) {
      if (this.knownCount >= this.maxKnown) return;
      this.knownCount += 1;
    }
    children.set(baseOf(relPath), kind);
  }

  /** Removes an entry and, for a folder, its subtree — cost proportional to that subtree only. */
  private forget(relPath: string): void {
    const children = this.dirs.get(parentOf(relPath));
    if (children?.delete(baseOf(relPath))) this.knownCount -= 1;
    this.dropSubtree(relPath);
  }

  private dropSubtree(dir: string): Map<string, Map<string, Kind>> {
    const removed = new Map<string, Map<string, Kind>>();
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      const children = this.dirs.get(current);
      if (!children) continue;
      this.dirs.delete(current);
      removed.set(current, children);
      this.knownCount -= children.size;
      for (const [name, kind] of children) if (kind === 'directory') stack.push(`${current}/${name}`);
    }
    return removed;
  }

  /** Moves an entry (and a folder's subtree) to its new path. */
  private rebaseKnown(from: string, to: string): void {
    const kind = this.getKnown(from);
    if (kind === undefined) return;
    if (this.dirs.get(parentOf(from))?.delete(baseOf(from))) this.knownCount -= 1;
    const subtree = this.dropSubtree(from);
    this.remember(to, kind);
    for (const [dir, children] of subtree) {
      this.dirs.set(to + dir.slice(from.length), children);
      this.knownCount += children.size;
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
