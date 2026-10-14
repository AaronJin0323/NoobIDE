import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Result } from '../shared/result';
import { SerialQueue, TEMP_SUFFIX, errorCode, silentLogger, writeFileAtomic, type RecoveryLogger } from './atomic-file';
import { PROJECT_KEY, projectKey, sha256Hex } from './keys';

/**
 * Local history: per-file snapshots of saved versions (S21.1, PLAN §7). Main process only; stored in the app-data
 * directory passed in by main, never in the project. Independent of undo, autosave and the crash journal.
 *
 * Layout:
 *   `<dir>/objects/<first 2 hex>/<sha256>`   content-addressed blobs: identical content is stored once, across
 *                                             files and projects
 *   `<dir>/index/<projectKey>.json`          per project: real root path and, per relative path, its versions
 *                                             (oldest first)
 * All files are written atomically. A version whose content equals the file's newest version is not added (dedupe).
 * Limits: versions and bytes per file, bytes in total; the oldest versions go first and unreferenced blobs are
 * deleted. Usage is reported by `usage()`; `cleanup()` and `clear()` are the cleanup controls.
 */

export type SnapshotReason = 'before-save' | 'after-save' | 'before-format' | 'before-delete' | 'before-restore';

export interface SnapshotMeta {
  /** Unique per version: `<createdAt>-<hash prefix>-<sequence>`. */
  readonly id: string;
  readonly hash: string;
  readonly size: number;
  readonly createdAt: number;
  readonly reason: SnapshotReason;
}

export interface HistoryLimits {
  readonly maxVersionsPerFile: number;
  /** Sum of the sizes of one file's versions. */
  readonly maxBytesPerFile: number;
  /** Unique blob bytes over all projects. */
  readonly maxTotalBytes: number;
  /** Larger contents are not snapshotted. */
  readonly maxSnapshotBytes: number;
  /**
   * Coalesced save batches: an `after-save` version replaces the file's newest version when that is also an
   * `after-save` younger than this (rapid saves keep one version per burst; the `before-save` version of the burst's
   * first save keeps what was on disk before it).
   */
  readonly coalesceMs: number;
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = {
  maxVersionsPerFile: 50,
  maxBytesPerFile: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxSnapshotBytes: 5 * 1024 * 1024,
  coalesceMs: 60_000,
};

export interface HistoryUsage {
  readonly totalBytes: number;
  readonly blobs: number;
  readonly projects: number;
  readonly files: number;
  readonly versions: number;
  readonly limits: HistoryLimits;
}

export interface FileHistoryUsage {
  readonly versions: number;
  readonly bytes: number;
  readonly maxVersions: number;
  readonly maxBytes: number;
}

export type SnapshotError = 'too-large' | 'write-failed';

const FORMAT = 'noobide-history';
const VERSION = 1;
const REASONS: readonly SnapshotReason[] = [
  'before-save',
  'after-save',
  'before-format',
  'before-delete',
  'before-restore',
];

interface ProjectIndex {
  format: typeof FORMAT;
  v: typeof VERSION;
  rootPath: string;
  files: Record<string, SnapshotMeta[]>;
}

export interface HistoryOptions {
  /** App-data directory for history, e.g. `<userData>/history`. Created on demand. */
  readonly dir: string;
  readonly limits?: Partial<HistoryLimits>;
  readonly log?: RecoveryLogger;
  readonly now?: () => number;
}

export class SnapshotStore {
  readonly dir: string;
  readonly limits: HistoryLimits;
  private readonly log: RecoveryLogger;
  private readonly now: () => number;
  private readonly queue = new SerialQueue();
  private sequence = 0;

  constructor(options: HistoryOptions) {
    this.dir = options.dir;
    this.limits = { ...DEFAULT_HISTORY_LIMITS, ...options.limits };
    this.log = options.log ?? silentLogger;
    this.now = options.now ?? Date.now;
  }

  /** Adds a version of `relPath` unless it equals the file's newest version. */
  snapshot(
    rootPath: string,
    relPath: string,
    data: Uint8Array,
    reason: SnapshotReason,
  ): Promise<Result<{ snapshot: SnapshotMeta; deduped: boolean }, SnapshotError>> {
    return this.queue.run(async () => {
      if (data.length > this.limits.maxSnapshotBytes) {
        this.log('history.snapshot-skipped', { reason: 'too-large', bytes: data.length });
        return err('too-large', `${data.length} bytes`);
      }
      const hash = sha256Hex(data);
      try {
        const index = await this.readIndex(rootPath);
        const versions = index.files[relPath] ?? [];
        const newest = versions.at(-1);
        if (newest && newest.hash === hash) return ok({ snapshot: newest, deduped: true });

        await this.writeBlob(hash, data);
        const createdAt = this.now();
        const meta: SnapshotMeta = {
          id: `${createdAt}-${hash.slice(0, 12)}-${(this.sequence += 1)}`,
          hash,
          size: data.length,
          createdAt,
          reason,
        };
        const coalesce =
          reason === 'after-save' &&
          newest?.reason === 'after-save' &&
          createdAt - newest.createdAt >= 0 &&
          createdAt - newest.createdAt < this.limits.coalesceMs;
        const next = coalesce ? [...versions.slice(0, -1), meta] : [...versions, meta];
        const kept = trimFile(next, this.limits);
        index.files[relPath] = kept;
        await this.writeIndex(index);
        // Versions dropped by coalescing or the per-file limits may leave blobs nobody references.
        if (kept.length < versions.length + 1) await this.collectGarbage();
        await this.enforceTotal();
        return ok({ snapshot: meta, deduped: false });
      } catch (e) {
        this.log('history.snapshot-failed', { code: errorCode(e) });
        return err('write-failed', errorCode(e), e);
      }
    });
  }

  /** Versions of one file, newest first. */
  list(rootPath: string, relPath: string): Promise<SnapshotMeta[]> {
    return this.queue.run(async () => [...((await this.readIndex(rootPath)).files[relPath] ?? [])].reverse());
  }

  /** Relative paths that have history in a project (including files deleted since). */
  files(rootPath: string): Promise<string[]> {
    return this.queue.run(async () => Object.keys((await this.readIndex(rootPath)).files).sort());
  }

  /** Content of a version; the blob's hash is verified. */
  read(rootPath: string, relPath: string, id: string): Promise<Result<Uint8Array, 'not-found' | 'corrupt'>> {
    return this.queue.run(async () => {
      const meta = (await this.readIndex(rootPath)).files[relPath]?.find((m) => m.id === id);
      if (!meta) return err('not-found', 'no such version');
      let data: Buffer;
      try {
        data = await readFile(this.blobPath(meta.hash));
      } catch (e) {
        return err(errorCode(e) === 'ENOENT' ? 'not-found' : 'corrupt', errorCode(e));
      }
      if (sha256Hex(data) !== meta.hash) {
        this.log('history.blob-corrupt', { hash: meta.hash.slice(0, 12) });
        return err('corrupt', 'content does not match its hash');
      }
      return ok(new Uint8Array(data));
    });
  }

  usage(): Promise<HistoryUsage> {
    return this.queue.run(async () => {
      const indexes = await this.readAllIndexes();
      const blobs = referencedBlobs(indexes);
      let files = 0;
      let versions = 0;
      for (const index of indexes) {
        for (const list of Object.values(index.files)) {
          files += 1;
          versions += list.length;
        }
      }
      return {
        totalBytes: sumValues(blobs),
        blobs: blobs.size,
        projects: indexes.length,
        files,
        versions,
        limits: this.limits,
      };
    });
  }

  fileUsage(rootPath: string, relPath: string): Promise<FileHistoryUsage> {
    return this.queue.run(async () => {
      const versions = (await this.readIndex(rootPath)).files[relPath] ?? [];
      return {
        versions: versions.length,
        bytes: versions.reduce((n, m) => n + m.size, 0),
        maxVersions: this.limits.maxVersionsPerFile,
        maxBytes: this.limits.maxBytesPerFile,
      };
    });
  }

  /** Re-applies the limits, deletes unreferenced blobs and leftover temporary files. */
  cleanup(): Promise<{ removedBlobs: number; removedBytes: number }> {
    return this.queue.run(async () => {
      for (const index of await this.readAllIndexes()) {
        let changed = false;
        for (const [relPath, list] of Object.entries(index.files)) {
          const trimmed = trimFile(list, this.limits);
          if (trimmed.length !== list.length) {
            index.files[relPath] = trimmed;
            changed = true;
          }
        }
        if (changed) await this.writeIndex(index);
      }
      await this.enforceTotal();
      return this.collectGarbage();
    });
  }

  /** Clear-history control: one project's history, or everything when `rootPath` is omitted. */
  clear(rootPath?: string): Promise<Result<null, 'clear-failed'>> {
    return this.queue.run(async () => {
      try {
        if (rootPath === undefined) {
          await rm(this.dir, { recursive: true, force: true });
        } else {
          await rm(this.indexPath(rootPath), { force: true });
          await this.collectGarbage();
        }
        this.log('history.cleared', { all: rootPath === undefined });
        return ok(null);
      } catch (e) {
        this.log('history.clear-failed', { code: errorCode(e) });
        return err('clear-failed', errorCode(e), e);
      }
    });
  }

  private indexPath(rootPath: string): string {
    return path.join(this.dir, 'index', `${projectKey(rootPath)}.json`);
  }

  private blobPath(hash: string): string {
    return path.join(this.dir, 'objects', hash.slice(0, 2), hash);
  }

  private async writeBlob(hash: string, data: Uint8Array): Promise<void> {
    const target = this.blobPath(hash);
    try {
      const existing = await stat(target);
      if (existing.size === data.length) return; // content-addressed: already stored
    } catch {
      // not stored yet
    }
    await writeFileAtomic(target, data);
  }

  private async writeIndex(index: ProjectIndex): Promise<void> {
    for (const [relPath, list] of Object.entries(index.files)) if (list.length === 0) delete index.files[relPath];
    const target = this.indexPath(index.rootPath);
    if (Object.keys(index.files).length === 0) await rm(target, { force: true });
    else await writeFileAtomic(target, JSON.stringify(index));
  }

  /** A missing index is empty; a corrupt one is logged, moved aside and treated as empty. Never throws. */
  private async readIndex(rootPath: string): Promise<ProjectIndex> {
    const empty: ProjectIndex = { format: FORMAT, v: VERSION, rootPath, files: nullRecord() };
    const loaded = await this.loadIndexFile(this.indexPath(rootPath));
    return loaded && loaded.rootPath === rootPath ? loaded : empty;
  }

  private async loadIndexFile(file: string): Promise<ProjectIndex | null> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (e) {
      if (errorCode(e) !== 'ENOENT') this.log('history.index-unreadable', { code: errorCode(e) });
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      // A null-prototype map: a file named `__proto__` must be an ordinary key.
      if (isProjectIndex(parsed)) return { ...parsed, files: Object.assign(nullRecord(), parsed.files) };
    } catch {
      // fall through
    }
    this.log('history.index-corrupt', { index: path.basename(file) });
    const aside = path.join(this.dir, 'quarantine', `${this.now()}-${path.basename(file)}`);
    await mkdir(path.dirname(aside), { recursive: true }).catch(() => undefined);
    await rename(file, aside).catch(() => undefined);
    return null;
  }

  private async readAllIndexes(): Promise<ProjectIndex[]> {
    let names: string[];
    try {
      names = await readdir(path.join(this.dir, 'index'));
    } catch {
      return [];
    }
    const out: ProjectIndex[] = [];
    for (const name of names) {
      const file = path.join(this.dir, 'index', name);
      if (name.endsWith(TEMP_SUFFIX)) {
        await rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      if (!name.endsWith('.json') || !PROJECT_KEY.test(name.slice(0, -5))) continue;
      const index = await this.loadIndexFile(file);
      if (index && `${projectKey(index.rootPath)}.json` === name) out.push(index);
    }
    return out;
  }

  /** Drops the globally oldest versions until the unique blob bytes fit the total limit. */
  private async enforceTotal(): Promise<void> {
    const indexes = await this.readAllIndexes();
    const blobs = referencedBlobs(indexes);
    const refs = new Map<string, number>();
    for (const index of indexes) {
      for (const list of Object.values(index.files))
        for (const m of list) refs.set(m.hash, (refs.get(m.hash) ?? 0) + 1);
    }
    let total = sumValues(blobs);
    if (total <= this.limits.maxTotalBytes) return;
    const all = indexes
      .flatMap((index) =>
        Object.entries(index.files).flatMap(([relPath, list]) => list.map((m) => ({ index, relPath, m }))),
      )
      .sort((a, b) => a.m.createdAt - b.m.createdAt);
    const touched = new Set<ProjectIndex>();
    for (const { index, relPath, m } of all) {
      if (total <= this.limits.maxTotalBytes) break;
      index.files[relPath] = (index.files[relPath] ?? []).filter((x) => x.id !== m.id);
      touched.add(index);
      const left = (refs.get(m.hash) ?? 1) - 1;
      refs.set(m.hash, left);
      if (left === 0) total -= m.size;
    }
    for (const index of touched) await this.writeIndex(index);
    this.log('history.trimmed-total', { bytes: total });
    await this.collectGarbage();
  }

  private async collectGarbage(): Promise<{ removedBlobs: number; removedBytes: number }> {
    const live = referencedBlobs(await this.readAllIndexes());
    let removedBlobs = 0;
    let removedBytes = 0;
    const objects = path.join(this.dir, 'objects');
    let shards: string[];
    try {
      shards = await readdir(objects);
    } catch {
      return { removedBlobs, removedBytes };
    }
    for (const shard of shards) {
      let names: string[];
      try {
        names = await readdir(path.join(objects, shard));
      } catch {
        continue;
      }
      for (const name of names) {
        if (live.has(name)) continue;
        const file = path.join(objects, shard, name);
        try {
          const { size } = await stat(file);
          await rm(file, { force: true });
          if (!name.endsWith(TEMP_SUFFIX)) {
            removedBlobs += 1;
            removedBytes += size;
          }
        } catch (e) {
          this.log('history.gc-failed', { code: errorCode(e) });
        }
      }
    }
    return { removedBlobs, removedBytes };
  }
}

/** Applies the per-file limits: oldest versions go first; the newest version is always kept. */
function trimFile(list: SnapshotMeta[], limits: HistoryLimits): SnapshotMeta[] {
  const out = [...list];
  let bytes = out.reduce((n, m) => n + m.size, 0);
  while (out.length > 1 && (out.length > limits.maxVersionsPerFile || bytes > limits.maxBytesPerFile)) {
    bytes -= out.shift()?.size ?? 0;
  }
  return out;
}

function nullRecord(): Record<string, SnapshotMeta[]> {
  return Object.create(null) as Record<string, SnapshotMeta[]>;
}

function referencedBlobs(indexes: readonly ProjectIndex[]): Map<string, number> {
  const blobs = new Map<string, number>();
  for (const index of indexes) {
    for (const list of Object.values(index.files)) for (const m of list) blobs.set(m.hash, m.size);
  }
  return blobs;
}

function sumValues(map: Map<string, number>): number {
  let total = 0;
  for (const n of map.values()) total += n;
  return total;
}

function isSnapshotMeta(value: unknown): value is SnapshotMeta {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    typeof m.hash === 'string' &&
    /^[0-9a-f]{64}$/.test(m.hash) &&
    typeof m.size === 'number' &&
    m.size >= 0 &&
    typeof m.createdAt === 'number' &&
    REASONS.includes(m.reason as SnapshotReason)
  );
}

function isProjectIndex(value: unknown): value is ProjectIndex {
  if (typeof value !== 'object' || value === null) return false;
  const i = value as Record<string, unknown>;
  if (i.format !== FORMAT || i.v !== VERSION || typeof i.rootPath !== 'string') return false;
  if (typeof i.files !== 'object' || i.files === null || Array.isArray(i.files)) return false;
  return Object.values(i.files).every((list) => Array.isArray(list) && list.every(isSnapshotMeta));
}
