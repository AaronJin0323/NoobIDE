import { mkdir, readFile as fsReadFile, readdir, rename, rm, stat } from 'node:fs/promises';
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
 *   `<dir>/quarantine/`                      damaged indexes moved aside (bounded); their blobs are kept
 *
 * Data-safety rules (review of S21, 2026-10-14):
 * - Only a missing index means "no history". Any other read error (a virus scanner or indexer holding the file)
 *   makes that project's history *unavailable*: snapshots for it fail with `write-failed` instead of overwriting it,
 *   and no blob is deleted anywhere while any index is unavailable.
 * - Damaged entries are dropped one by one; an index that cannot be parsed at all is quarantined, an index written
 *   by a newer app version is left untouched. Blobs referenced by quarantined or newer indexes stay until the user
 *   clears history.
 * - The index set is loaded once and kept in memory with reference counts, so a snapshot costs one blob and one
 *   index write, never a scan of all history. Full garbage collection runs only in `cleanup()`.
 * - Limits evict the oldest versions first by a monotonic sequence (not the wall clock) and never a file's newest.
 */

export type SnapshotReason = 'before-save' | 'after-save' | 'before-format' | 'before-delete' | 'before-restore';

export interface SnapshotMeta {
  /** Unique per version: `<createdAt>-<hash prefix>-<seq>`. */
  readonly id: string;
  readonly hash: string;
  readonly size: number;
  readonly createdAt: number;
  readonly reason: SnapshotReason;
  /** Monotonic over the whole store; decides "oldest" for eviction. */
  readonly seq: number;
  /** `after-save` only: when the save burst this version belongs to started. */
  readonly burstStart?: number;
}

export interface HistoryLimits {
  readonly maxVersionsPerFile: number;
  /** Sum of the sizes of one file's versions. */
  readonly maxBytesPerFile: number;
  /** Unique blob bytes over all projects. */
  readonly maxTotalBytes: number;
  /** Larger contents are not snapshotted. Never more than the per-file or total limit. */
  readonly maxSnapshotBytes: number;
  /**
   * Coalesced save batches: an `after-save` version replaces the file's newest version when that is an `after-save`
   * of a burst that started less than this long ago. A long editing session therefore keeps one version per window
   * (not one in total); the `before-save` version of a burst's first save keeps what was on disk before it.
   */
  readonly coalesceMs: number;
  /** Damaged indexes kept in `quarantine/`. */
  readonly maxQuarantined: number;
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = {
  maxVersionsPerFile: 50,
  maxBytesPerFile: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxSnapshotBytes: 5 * 1024 * 1024,
  coalesceMs: 60_000,
  maxQuarantined: 20,
};

export interface HistoryUsage {
  /** Unique bytes of the versions the history can show. */
  readonly totalBytes: number;
  /** Everything the history directory occupies: blobs (including kept/orphaned ones), indexes, quarantine. */
  readonly onDiskBytes: number;
  readonly blobs: number;
  readonly projects: number;
  readonly files: number;
  readonly versions: number;
  readonly quarantined: number;
  /** Projects whose index could not be read just now (history kept, temporarily not usable). */
  readonly unavailable: number;
  readonly limits: HistoryLimits;
}

export interface FileHistoryUsage {
  readonly versions: number;
  readonly bytes: number;
  readonly maxVersions: number;
  readonly maxBytes: number;
}

/** One project's history as the S21.4 storage view lists it (ADR 0006: orphans are shown with their size). */
export interface ProjectHistorySummary {
  readonly key: string;
  /** The real root path the history was recorded under; it may not exist any more (moved or renamed project). */
  readonly rootPath: string;
  readonly files: number;
  readonly versions: number;
  /** Unique bytes of this project's versions (identical versions counted once). */
  readonly bytes: number;
}

export type SnapshotError = 'too-large' | 'write-failed';
export type HistoryReadError = 'unavailable';

const FORMAT = 'noobide-history';
const VERSION = 1;
const REASONS: readonly SnapshotReason[] = [
  'before-save',
  'after-save',
  'before-format',
  'before-delete',
  'before-restore',
];
/** Snapshots taken around an operation (not a save) end the current save burst (S21.3). */
const SEALS_BURST: ReadonlySet<SnapshotReason> = new Set(['before-format', 'before-delete', 'before-restore']);
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'EAGAIN']);
const HASH_IN_TEXT = /[0-9a-f]{64}/g;
const STALE_TEMP_MS = 60_000;

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
  /** Fault injection for tests (locked files); defaults to fs.promises.readFile. */
  readonly readFile?: (file: string) => Promise<Buffer>;
  /** Delay between retries of a transiently failing index read. */
  readonly retryDelayMs?: number;
}

/** Portable relative path as a history key: `/`-separated, Unicode NFC (macOS may hand out NFD names). */
export function historyKey(relPath: string): string {
  return relPath.normalize('NFC');
}

export class SnapshotStore {
  readonly dir: string;
  readonly limits: HistoryLimits;
  private readonly log: RecoveryLogger;
  private readonly now: () => number;
  private readonly readFile: (file: string) => Promise<Buffer>;
  private readonly retryDelayMs: number;
  private readonly queue = new SerialQueue();

  private loaded = false;
  private readonly indexes = new Map<string, ProjectIndex>();
  /** Project keys whose index exists but could not be read (with the error code). */
  private readonly unavailable = new Map<string, string>();
  /** Project keys whose index was written by a newer app version: never written or trimmed by this version. */
  private readonly newer = new Set<string>();
  /** Blobs referenced by quarantined or newer indexes: never deleted until history is cleared. */
  private readonly protectedHashes = new Set<string>();
  /**
   * Damaged indexes in `quarantine/`. A truncated index may reference blobs whose hashes were cut off, so while any
   * is kept no blob is deleted at all (the user can still clear history); usage() reports the count.
   */
  private quarantined = 0;
  private readonly refs = new Map<string, { count: number; size: number }>();
  private seq = 0;

  constructor(options: HistoryOptions) {
    this.dir = options.dir;
    this.limits = sanitizeLimits({ ...DEFAULT_HISTORY_LIMITS, ...options.limits });
    this.log = options.log ?? silentLogger;
    this.now = options.now ?? Date.now;
    this.readFile = options.readFile ?? ((file) => fsReadFile(file));
    this.retryDelayMs = options.retryDelayMs ?? 50;
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
      await this.load();
      const key = projectKey(rootPath);
      const blocked =
        this.unavailable.get(key) ?? this.unavailable.get('*') ?? (this.newer.has(key) ? 'newer-format' : undefined);
      if (blocked !== undefined) {
        // Never overwrite a history this process cannot read.
        this.log('history.snapshot-refused', { reason: blocked });
        return err('write-failed', `history unavailable: ${blocked}`);
      }
      const rel = historyKey(relPath);
      const hash = sha256Hex(data);
      try {
        const index = this.indexes.get(key) ?? newIndex(rootPath);
        const versions = index.files[rel] ?? [];
        const newest = versions.at(-1);
        if (newest && newest.hash === hash) {
          // S21.3: a format, delete or restore is a boundary. When it finds the content already kept as the newest
          // after-save version, that version's save burst is sealed, so the next save (e.g. the restored content)
          // is added as a new version instead of replacing — and losing — the one kept "before" the operation.
          if (SEALS_BURST.has(reason) && newest.burstStart !== undefined) {
            const { burstStart: _sealed, ...rest } = newest;
            const sealed: SnapshotMeta = rest;
            index.files[rel] = [...versions.slice(0, -1), sealed];
            await this.writeIndex(index);
            return ok({ snapshot: sealed, deduped: true });
          }
          return ok({ snapshot: newest, deduped: true });
        }

        await this.ensureBlob(hash, data);
        const createdAt = this.now();
        const seq = (this.seq += 1);
        const coalesce =
          reason === 'after-save' &&
          newest?.reason === 'after-save' &&
          newest.burstStart !== undefined &&
          createdAt >= newest.createdAt &&
          createdAt - newest.burstStart < this.limits.coalesceMs;
        const meta: SnapshotMeta = {
          id: `${createdAt}-${hash.slice(0, 12)}-${seq}`,
          hash,
          size: data.length,
          createdAt,
          reason,
          seq,
          ...(reason === 'after-save' ? { burstStart: coalesce ? newest.burstStart : createdAt } : {}),
        };
        const kept = trimFile(coalesce ? [...versions.slice(0, -1), meta] : [...versions, meta], this.limits);
        const keptIds = new Set(kept.map((m) => m.id));
        index.files[rel] = kept;
        this.indexes.set(key, index);
        await this.writeIndex(index);
        this.addRef(meta);
        const released = versions.filter((m) => !keptIds.has(m.id)).flatMap((m) => this.releaseRef(m));
        released.push(...(await this.enforceTotal()));
        await this.deleteBlobs(released);
        return ok({ snapshot: meta, deduped: false });
      } catch (e) {
        this.log('history.snapshot-failed', { code: errorCode(e) });
        this.invalidate(); // reload from disk next time instead of trusting a half-applied cache
        return err('write-failed', errorCode(e), e);
      }
    });
  }

  /** Versions of one file, newest first. */
  list(rootPath: string, relPath: string): Promise<Result<SnapshotMeta[], HistoryReadError>> {
    return this.queue.run(async () => {
      const index = await this.readableIndex(rootPath);
      if (!index.ok) return index;
      return ok([...(index.value?.files[historyKey(relPath)] ?? [])].reverse());
    });
  }

  /** Relative paths that have history in a project (including files deleted since). */
  files(rootPath: string): Promise<Result<string[], HistoryReadError>> {
    return this.queue.run(async () => {
      const index = await this.readableIndex(rootPath);
      if (!index.ok) return index;
      return ok(Object.keys(index.value?.files ?? {}).sort());
    });
  }

  /** Every project with readable history, with its stored root path and size (S21.4, ADR 0006). */
  projects(): Promise<ProjectHistorySummary[]> {
    return this.queue.run(async () => {
      await this.load();
      return [...this.indexes.entries()].map(([key, index]) => {
        const lists = Object.values(index.files);
        const unique = new Map<string, number>();
        for (const m of lists.flat()) unique.set(m.hash, m.size);
        return {
          key,
          rootPath: index.rootPath,
          files: lists.length,
          versions: lists.reduce((n, list) => n + list.length, 0),
          bytes: [...unique.values()].reduce((n, size) => n + size, 0),
        };
      });
    });
  }

  /** Content of a version; the blob's hash is verified. */
  read(
    rootPath: string,
    relPath: string,
    id: string,
  ): Promise<Result<Uint8Array, 'not-found' | 'corrupt' | HistoryReadError>> {
    return this.queue.run(async () => {
      const index = await this.readableIndex(rootPath);
      if (!index.ok) return index;
      const meta = index.value?.files[historyKey(relPath)]?.find((m) => m.id === id);
      if (!meta) return err('not-found', 'no such version');
      let data: Buffer;
      try {
        data = await fsReadFile(this.blobPath(meta.hash));
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
      await this.load();
      let files = 0;
      let versions = 0;
      for (const index of this.indexes.values()) {
        for (const list of Object.values(index.files)) {
          files += 1;
          versions += list.length;
        }
      }
      return {
        totalBytes: this.referencedBytes(),
        onDiskBytes: await directoryBytes(this.dir),
        blobs: [...this.refs.values()].filter((r) => r.count > 0).length,
        projects: this.indexes.size,
        files,
        versions,
        quarantined: (await readdir(path.join(this.dir, 'quarantine')).catch(() => [])).length,
        unavailable: this.unavailable.size,
        limits: this.limits,
      };
    });
  }

  fileUsage(rootPath: string, relPath: string): Promise<FileHistoryUsage> {
    return this.queue.run(async () => {
      await this.load();
      const versions = this.indexes.get(projectKey(rootPath))?.files[historyKey(relPath)] ?? [];
      return {
        versions: versions.length,
        bytes: versions.reduce((n, m) => n + m.size, 0),
        maxVersions: this.limits.maxVersionsPerFile,
        maxBytes: this.limits.maxBytesPerFile,
      };
    });
  }

  /**
   * Cleanup control: re-applies the limits, deletes unreferenced blobs and stale temporary files, caps the
   * quarantine. Deletes nothing while any index is unavailable.
   */
  cleanup(): Promise<{ removedBlobs: number; removedBytes: number }> {
    return this.queue.run(async () => {
      this.invalidate();
      await this.load();
      const released: string[] = [];
      for (const [key, index] of this.indexes) {
        if (this.newer.has(key)) continue;
        let changed = false;
        for (const [rel, list] of Object.entries(index.files)) {
          const trimmed = trimFile(list, this.limits);
          if (trimmed.length === list.length) continue;
          const keep = new Set(trimmed.map((m) => m.id));
          released.push(...list.filter((m) => !keep.has(m.id)).flatMap((m) => this.releaseRef(m)));
          index.files[rel] = trimmed;
          changed = true;
        }
        if (changed) await this.writeIndex(index);
      }
      released.push(...(await this.enforceTotal()));
      await this.deleteBlobs(released);
      await this.capQuarantine();
      return this.collectGarbage();
    });
  }

  /** Clear-history control: one project's history, or everything (including the quarantine) when omitted. */
  clear(rootPath?: string): Promise<Result<null, 'clear-failed'>> {
    return this.queue.run(async () => {
      try {
        if (rootPath === undefined) {
          await rm(this.dir, { recursive: true, force: true });
          this.invalidate();
        } else {
          const key = projectKey(rootPath);
          await rm(this.indexPath(key), { force: true });
          const index = this.indexes.get(key);
          this.indexes.delete(key);
          this.unavailable.delete(key);
          this.newer.delete(key);
          const released = index
            ? Object.values(index.files)
                .flat()
                .flatMap((m) => this.releaseRef(m))
            : [];
          await this.deleteBlobs(released);
        }
        this.log('history.cleared', { all: rootPath === undefined });
        return ok(null);
      } catch (e) {
        this.log('history.clear-failed', { code: errorCode(e) });
        this.invalidate();
        return err('clear-failed', errorCode(e), e);
      }
    });
  }

  /** Resolves when every queued operation has finished (tests, orderly shutdown). */
  idle(): Promise<void> {
    return this.queue.run(async () => undefined);
  }

  // ── loading ────────────────────────────────────────────────────────────

  private invalidate(): void {
    this.loaded = false;
    this.indexes.clear();
    this.unavailable.clear();
    this.newer.clear();
    this.protectedHashes.clear();
    this.refs.clear();
    this.quarantined = 0;
  }

  /**
   * Loads every index once. While anything is unavailable, every call reloads from disk (cheap compared with the
   * risk), so a lock that has gone away is noticed on the next operation. Never throws.
   */
  private async load(): Promise<void> {
    if (this.loaded && this.unavailable.size === 0) return;
    if (this.loaded) this.invalidate();
    const indexDir = path.join(this.dir, 'index');
    let names: string[];
    try {
      names = await readdir(indexDir);
    } catch (e) {
      if (errorCode(e) !== 'ENOENT') {
        // The whole index folder is unreadable: nothing may be written or deleted.
        this.unavailable.set('*', errorCode(e));
        this.log('history.index-unreadable', { code: errorCode(e) });
      } else this.unavailable.delete('*');
      this.loaded = true;
      return;
    }
    for (const name of names) {
      const file = path.join(indexDir, name);
      if (name.endsWith(TEMP_SUFFIX)) {
        await removeIfStale(file);
        continue;
      }
      const key = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!PROJECT_KEY.test(key)) continue;
      await this.loadIndex(key, file);
    }
    const kept = await readdir(path.join(this.dir, 'quarantine')).catch(() => [] as string[]);
    this.quarantined = kept.length;
    for (const q of kept) await this.protectHashesIn(path.join(this.dir, 'quarantine', q));
    for (const index of this.indexes.values()) {
      for (const list of Object.values(index.files)) for (const m of list) this.seq = Math.max(this.seq, m.seq);
    }
    this.loaded = true;
  }

  private async loadIndex(key: string, file: string): Promise<void> {
    let raw: string;
    try {
      raw = (await this.readWithRetry(file)).toString('utf8');
    } catch (e) {
      const code = errorCode(e);
      if (code === 'ENOENT') {
        this.unavailable.delete(key);
        return;
      }
      this.unavailable.set(key, code);
      this.log('history.index-unreadable', { code });
      return;
    }
    this.unavailable.delete(key);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    if (record && record.format === FORMAT && typeof record.v === 'number' && record.v > VERSION) {
      // Written by a newer NoobIDE: leave it exactly as it is and keep everything it may reference.
      this.newer.add(key);
      this.protectText(raw);
      this.log('history.index-newer', { v: record.v });
      return;
    }
    const index = record ? toIndex(record) : null;
    if (!index || projectKey(index.index.rootPath) !== key) {
      this.log('history.index-corrupt', { index: `${key}.json` });
      this.protectText(raw);
      await this.quarantine(file, key);
      return;
    }
    if (index.dropped > 0) this.log('history.entries-dropped', { count: index.dropped });
    this.indexes.set(key, index.index);
    for (const m of Object.values(index.index.files).flat()) this.addRef(m);
  }

  private async readWithRetry(file: string): Promise<Buffer> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.readFile(file);
      } catch (e) {
        if (attempt >= 3 || !TRANSIENT.has(errorCode(e))) throw e;
        await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
      }
    }
  }

  /** The project's index for reading, `null` when it has no history; `unavailable` when it cannot be read now. */
  private async readableIndex(rootPath: string): Promise<Result<ProjectIndex | null, HistoryReadError>> {
    await this.load();
    const key = projectKey(rootPath);
    const code = this.unavailable.get(key) ?? this.unavailable.get('*');
    if (code !== undefined) return err('unavailable', code);
    if (this.newer.has(key)) return err('unavailable', 'newer-format');
    return ok(this.indexes.get(key) ?? null);
  }

  // ── writing ────────────────────────────────────────────────────────────

  private indexPath(key: string): string {
    return path.join(this.dir, 'index', `${key}.json`);
  }

  private blobPath(hash: string): string {
    return path.join(this.dir, 'objects', hash.slice(0, 2), hash);
  }

  /** Stores the blob unless an intact copy exists; a damaged copy (bit flip) is replaced. */
  private async ensureBlob(hash: string, data: Uint8Array): Promise<void> {
    const target = this.blobPath(hash);
    try {
      if (sha256Hex(await fsReadFile(target)) === hash) return;
      this.log('history.blob-repaired', { hash: hash.slice(0, 12) });
    } catch {
      // not stored yet
    }
    await writeFileAtomic(target, data);
  }

  private async writeIndex(index: ProjectIndex): Promise<void> {
    for (const [rel, list] of Object.entries(index.files)) if (list.length === 0) delete index.files[rel];
    const key = projectKey(index.rootPath);
    if (Object.keys(index.files).length === 0) {
      await rm(this.indexPath(key), { force: true });
      this.indexes.delete(key);
    } else await writeFileAtomic(this.indexPath(key), JSON.stringify(index));
  }

  private addRef(meta: SnapshotMeta): void {
    const ref = this.refs.get(meta.hash) ?? { count: 0, size: meta.size };
    ref.count += 1;
    this.refs.set(meta.hash, ref);
  }

  /** Returns the hash when nothing references it any more (a deletion candidate). */
  private releaseRef(meta: SnapshotMeta): string[] {
    const ref = this.refs.get(meta.hash);
    if (!ref) return [];
    ref.count -= 1;
    if (ref.count > 0) return [];
    this.refs.delete(meta.hash);
    return [meta.hash];
  }

  private referencedBytes(): number {
    let total = 0;
    for (const ref of this.refs.values()) if (ref.count > 0) total += ref.size;
    return total;
  }

  /** Evicts the globally oldest versions (by sequence) until the total fits; a file's newest version is kept. */
  private async enforceTotal(): Promise<string[]> {
    let total = this.referencedBytes();
    if (total <= this.limits.maxTotalBytes) return [];
    const candidates: { key: string; rel: string; m: SnapshotMeta }[] = [];
    for (const [key, index] of this.indexes) {
      if (this.newer.has(key)) continue;
      for (const [rel, list] of Object.entries(index.files)) {
        for (const m of list.slice(0, -1)) candidates.push({ key, rel, m });
      }
    }
    candidates.sort((a, b) => a.m.seq - b.m.seq);
    const touched = new Set<string>();
    const released: string[] = [];
    for (const { key, rel, m } of candidates) {
      if (total <= this.limits.maxTotalBytes) break;
      const index = this.indexes.get(key);
      if (!index) continue;
      index.files[rel] = (index.files[rel] ?? []).filter((x) => x.id !== m.id);
      touched.add(key);
      const freed = this.releaseRef(m);
      if (freed.length > 0) total -= m.size;
      released.push(...freed);
    }
    for (const key of touched) {
      const index = this.indexes.get(key);
      if (index) await this.writeIndex(index);
    }
    this.log('history.trimmed-total', { bytes: total, over: total > this.limits.maxTotalBytes });
    return released;
  }

  /** False while some index is unreadable or quarantined: then nothing can be proven unreferenced. */
  private mayDeleteBlobs(): boolean {
    if (this.unavailable.size === 0 && this.quarantined === 0) return true;
    this.log('history.gc-deferred', { unavailable: this.unavailable.size, quarantined: this.quarantined });
    return false;
  }

  /** Deletes blobs nobody references — never while deletion is deferred, never protected ones. */
  private async deleteBlobs(hashes: readonly string[]): Promise<void> {
    if (hashes.length === 0 || !this.mayDeleteBlobs()) return;
    for (const hash of hashes) {
      if (this.refs.has(hash) || this.protectedHashes.has(hash)) continue;
      await rm(this.blobPath(hash), { force: true }).catch((e: unknown) =>
        this.log('history.gc-failed', { code: errorCode(e) }),
      );
    }
  }

  /** Full scan of `objects/` (cleanup only). */
  private async collectGarbage(): Promise<{ removedBlobs: number; removedBytes: number }> {
    let removedBlobs = 0;
    let removedBytes = 0;
    if (!this.mayDeleteBlobs()) return { removedBlobs, removedBytes };
    const objects = path.join(this.dir, 'objects');
    for (const shard of await readdir(objects).catch(() => [] as string[])) {
      for (const name of await readdir(path.join(objects, shard)).catch(() => [] as string[])) {
        const file = path.join(objects, shard, name);
        if (name.endsWith(TEMP_SUFFIX)) {
          await removeIfStale(file);
          continue;
        }
        if (this.refs.has(name) || this.protectedHashes.has(name)) continue;
        try {
          const { size } = await stat(file);
          await rm(file, { force: true });
          removedBlobs += 1;
          removedBytes += size;
        } catch (e) {
          this.log('history.gc-failed', { code: errorCode(e) });
        }
      }
    }
    return { removedBlobs, removedBytes };
  }

  private protectText(raw: string): void {
    for (const hash of raw.match(HASH_IN_TEXT) ?? []) this.protectedHashes.add(hash);
  }

  private async protectHashesIn(file: string): Promise<void> {
    try {
      this.protectText((await fsReadFile(file)).toString('utf8'));
    } catch (e) {
      // An unreadable quarantined index: we cannot tell what it references, so nothing may be deleted.
      this.unavailable.set(`quarantine:${path.basename(file)}`, errorCode(e));
    }
  }

  private async quarantine(file: string, key: string): Promise<void> {
    const aside = path.join(this.dir, 'quarantine', `${this.now()}-${key}.json`);
    try {
      await mkdir(path.dirname(aside), { recursive: true });
      await rename(file, aside);
      this.quarantined += 1;
    } catch (e) {
      // Cannot move it: treat the project as unavailable rather than overwrite it.
      this.unavailable.set(key, errorCode(e));
      this.log('history.quarantine-failed', { code: errorCode(e) });
    }
    await this.capQuarantine();
  }

  /** Keeps the newest `maxQuarantined` damaged indexes; blobs only they referenced become collectable. */
  private async capQuarantine(): Promise<void> {
    const qdir = path.join(this.dir, 'quarantine');
    const names = (await readdir(qdir).catch(() => [] as string[])).sort();
    const excess = names.slice(0, Math.max(0, names.length - this.limits.maxQuarantined));
    for (const name of excess) await rm(path.join(qdir, name), { force: true }).catch(() => undefined);
    this.quarantined = names.length - excess.length;
    if (excess.length === 0) return;
    this.protectedHashes.clear();
    for (const name of names.slice(excess.length)) await this.protectHashesIn(path.join(qdir, name));
    for (const key of this.newer) {
      await this.readFile(this.indexPath(key))
        .then((raw) => this.protectText(raw.toString('utf8')))
        .catch((e: unknown) => this.unavailable.set(key, errorCode(e)));
    }
  }
}

function newIndex(rootPath: string): ProjectIndex {
  return { format: FORMAT, v: VERSION, rootPath, files: nullRecord() };
}

/** Clamps limits to sane values: positive integers, a snapshot never larger than what a file or the store may hold. */
function sanitizeLimits(limits: HistoryLimits): HistoryLimits {
  const pick = (value: number, fallback: number, min = 1) =>
    Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
  const d = DEFAULT_HISTORY_LIMITS;
  const maxBytesPerFile = pick(limits.maxBytesPerFile, d.maxBytesPerFile);
  const maxTotalBytes = pick(limits.maxTotalBytes, d.maxTotalBytes);
  return {
    maxVersionsPerFile: pick(limits.maxVersionsPerFile, d.maxVersionsPerFile),
    maxBytesPerFile,
    maxTotalBytes,
    maxSnapshotBytes: Math.min(pick(limits.maxSnapshotBytes, d.maxSnapshotBytes), maxBytesPerFile, maxTotalBytes),
    coalesceMs: pick(limits.coalesceMs, d.coalesceMs, 0),
    maxQuarantined: pick(limits.maxQuarantined, d.maxQuarantined, 0),
  };
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

/** Per-entry validation: bad entries are dropped, the rest of the index survives. `null` when the shape is wrong. */
function toIndex(r: Record<string, unknown>): { index: ProjectIndex; dropped: number } | null {
  if (r.format !== FORMAT || r.v !== VERSION || typeof r.rootPath !== 'string' || r.rootPath === '') return null;
  if (typeof r.files !== 'object' || r.files === null || Array.isArray(r.files)) return null;
  const files = nullRecord();
  let dropped = 0;
  let order = 0;
  for (const [rel, list] of Object.entries(r.files as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      dropped += 1;
      continue;
    }
    const good: SnapshotMeta[] = [];
    for (const item of list) {
      const meta = toMeta(item, (order += 1));
      if (meta) good.push(meta);
      else dropped += 1;
    }
    if (good.length > 0) files[historyKey(rel)] = good;
  }
  return { index: { format: FORMAT, v: VERSION, rootPath: r.rootPath, files }, dropped };
}

function toMeta(value: unknown, fallbackSeq: number): SnapshotMeta | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  if (
    typeof m.id !== 'string' ||
    typeof m.hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(m.hash) ||
    typeof m.size !== 'number' ||
    !Number.isSafeInteger(m.size) ||
    m.size < 0 ||
    typeof m.createdAt !== 'number' ||
    !Number.isFinite(m.createdAt) ||
    !REASONS.includes(m.reason as SnapshotReason)
  ) {
    return null;
  }
  const seq = typeof m.seq === 'number' && Number.isSafeInteger(m.seq) ? m.seq : fallbackSeq;
  const burstStart = typeof m.burstStart === 'number' && Number.isFinite(m.burstStart) ? m.burstStart : undefined;
  return {
    id: m.id,
    hash: m.hash,
    size: m.size,
    createdAt: m.createdAt,
    reason: m.reason as SnapshotReason,
    seq,
    ...(burstStart !== undefined ? { burstStart } : {}),
  };
}

async function removeIfStale(file: string): Promise<void> {
  const age = await stat(file).then(
    (info) => Date.now() - info.mtimeMs,
    () => 0,
  );
  if (age > STALE_TEMP_MS) await rm(file, { force: true }).catch(() => undefined);
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full);
    else
      total += await stat(full).then(
        (s) => s.size,
        () => 0,
      );
  }
  return total;
}
