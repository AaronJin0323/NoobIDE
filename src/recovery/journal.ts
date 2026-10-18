import { mkdir, readFile, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isPortableRelPath } from '../shared/ipc/contract';
import { err, ok, type Result } from '../shared/result';
import { SerialQueue, TEMP_SUFFIX, errorCode, silentLogger, writeFileAtomic, type RecoveryLogger } from './atomic-file';
import { BUFFER_ID, PROJECT_KEY, fileKey, projectKey, sha256Hex } from './keys';

/**
 * Crash-recovery journal for unsaved editor buffers (S12.1–S12.3, PLAN §6, §7). Main process only.
 *
 * Separate from undo, autosave and local history: it exists only so that edits survive an abnormal termination and
 * is emptied by a successful save. It lives in the app-data directory passed in by main (never in the project).
 *
 * Layout: `<dir>/<projectKey>/<fileKey>-<bufferId>.json`, one atomically replaced JSON record per open buffer.
 * Each editor buffer has its own random `bufferId`, so a buffer never overwrites another session's copy of the same
 * file: a crash copy the user postponed survives even if they open and edit that file again. Records carry a
 * SHA-256 of their text; truncated, garbled or mismatched records are skipped, logged without content and moved to
 * `<dir>/quarantine/` (bounded). Writes are bounded per entry, in total and in number.
 */

export interface JournalLimits {
  /** Largest single record (JSON bytes). Larger buffers are refused with `too-large`. */
  readonly maxEntryBytes: number;
  /** All records together. A write that would exceed it is refused with `quota-exceeded`. */
  readonly maxTotalBytes: number;
  readonly maxEntries: number;
  /** Corrupt records kept for inspection; older ones are deleted. */
  readonly maxQuarantined: number;
}

export const DEFAULT_JOURNAL_LIMITS: JournalLimits = {
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxEntries: 500,
  maxQuarantined: 20,
};

export interface JournalTarget {
  /** Real path of the project root (ProjectService.rootOf). */
  readonly rootPath: string;
  /** Portable `/`-separated path inside the project. */
  readonly relPath: string;
}

export interface BufferSnapshot {
  readonly bufferId: string;
  /** Monotonic per buffer. Older or equal revisions than the last written one are ignored. */
  readonly revision: number;
  readonly text: string;
  readonly bom: boolean;
}

export interface RecoveredBuffer extends JournalTarget {
  readonly bufferId: string;
  readonly revision: number;
  readonly updatedAt: number;
  readonly text: string;
  readonly bom: boolean;
}

export interface PendingFile {
  readonly relPath: string;
  readonly bufferId: string;
  readonly revision: number;
  readonly updatedAt: number;
}

export interface PendingProject {
  readonly key: string;
  readonly rootPath: string;
  readonly files: readonly PendingFile[];
}

export interface JournalUsage {
  readonly bytes: number;
  readonly entries: number;
  readonly limits: JournalLimits;
}

export type RecordError = 'too-large' | 'quota-exceeded' | 'write-failed';
export type ReadEntryError = 'not-found' | 'corrupt';

const FORMAT = 'noobide-recovery';
const VERSION = 1;
const QUARANTINE = 'quarantine';
const STALE_TEMP_MS = 60_000;
const QUARANTINED_REASONS: ReadonlySet<string> = new Set(['unparseable', 'invalid', 'checksum', 'misplaced']);

interface EntryRecord {
  readonly format: typeof FORMAT;
  readonly v: typeof VERSION;
  readonly rootPath: string;
  readonly relPath: string;
  readonly bufferId: string;
  readonly revision: number;
  readonly updatedAt: number;
  readonly bom: boolean;
  readonly sha256: string;
  readonly text: string;
}

export interface JournalOptions {
  /** App-data directory for the journal, e.g. `<userData>/recovery`. Created on demand. */
  readonly dir: string;
  readonly limits?: Partial<JournalLimits>;
  readonly log?: RecoveryLogger;
  readonly now?: () => number;
}

/** `newer`: written by a newer NoobIDE (S28.4 downgrade) — left exactly where it is, never quarantined or removed. */
type SkipReason = 'unreadable' | 'too-large' | 'unparseable' | 'invalid' | 'checksum' | 'misplaced' | 'newer';

export class RecoveryJournal {
  readonly dir: string;
  readonly limits: JournalLimits;
  private readonly log: RecoveryLogger;
  private readonly now: () => number;
  private readonly queue = new SerialQueue();
  /** Bytes of every record on disk, by its path relative to `dir`. Loaded by the first scan. */
  private sizes: Map<string, number> | null = null;
  /** Highest revision written or discarded per buffer in this process; older writes arriving late are dropped. */
  private readonly floors = new Map<string, number>();
  /** Buffers of this process: their records are live, not "left over from a crash". */
  private readonly ownBuffers = new Set<string>();

  constructor(options: JournalOptions) {
    this.dir = options.dir;
    this.limits = { ...DEFAULT_JOURNAL_LIMITS, ...options.limits };
    this.log = options.log ?? silentLogger;
    this.now = options.now ?? Date.now;
  }

  /** Journals the current text of a dirty buffer. Called (debounced) by the renderer at most every ~1.5 s. */
  record(target: JournalTarget, snapshot: BufferSnapshot): Promise<Result<{ written: boolean }, RecordError>> {
    return this.queue.run(async () => {
      const rel = this.entryRel(target, snapshot.bufferId);
      const floor = this.floors.get(rel);
      if (floor !== undefined && snapshot.revision <= floor) return ok({ written: false });
      this.ownBuffers.add(snapshot.bufferId);
      const record: EntryRecord = {
        format: FORMAT,
        v: VERSION,
        rootPath: target.rootPath,
        relPath: target.relPath,
        bufferId: snapshot.bufferId,
        revision: snapshot.revision,
        updatedAt: this.now(),
        bom: snapshot.bom,
        sha256: sha256Hex(snapshot.text),
        text: snapshot.text,
      };
      const data = Buffer.from(JSON.stringify(record), 'utf8');
      if (data.length > this.limits.maxEntryBytes) {
        this.log('recovery.record-refused', { reason: 'too-large', bytes: data.length });
        return err('too-large', `${data.length} bytes`);
      }
      const sizes = await this.loadSizes();
      const previous = sizes.get(rel);
      const total = sumOf(sizes) - (previous ?? 0) + data.length;
      if (total > this.limits.maxTotalBytes || (previous === undefined && sizes.size >= this.limits.maxEntries)) {
        this.log('recovery.record-refused', { reason: 'quota-exceeded', bytes: total, entries: sizes.size });
        return err('quota-exceeded', `${total} bytes in ${sizes.size} entries`);
      }
      try {
        await writeFileAtomic(path.join(this.dir, rel), data);
      } catch (e) {
        this.log('recovery.record-failed', { code: errorCode(e) });
        return err('write-failed', errorCode(e), e);
      }
      sizes.set(rel, data.length);
      this.floors.set(rel, snapshot.revision);
      return ok({ written: true });
    });
  }

  /**
   * After a successful save of `revision`: removes the buffer's record unless it already holds newer edits (typed
   * while the save was running). Later writes of revisions up to `revision` are ignored.
   */
  discardSaved(
    target: JournalTarget,
    bufferId: string,
    revision: number,
  ): Promise<Result<{ removed: boolean }, never>> {
    return this.queue.run(async () => {
      const rel = this.entryRel(target, bufferId);
      const floor = this.floors.get(rel);
      this.floors.set(rel, Math.max(floor ?? -Infinity, revision));
      const onDisk = await this.readRecord(rel);
      if (onDisk.ok && onDisk.value.record.revision > revision) return ok({ removed: false });
      // S26.1: a record that cannot be read right now (locked by a scanner, over a lowered limit) may hold newer
      // edits typed during the save: keep it. At worst an already saved copy is offered once more.
      if (!onDisk.ok && (onDisk.code === 'unreadable' || onDisk.code === 'too-large' || onDisk.code === 'newer')) {
        return ok({ removed: false });
      }
      return ok({ removed: await this.remove(rel) });
    });
  }

  /** The user chose to throw this copy away. */
  discard(target: JournalTarget, bufferId: string): Promise<Result<{ removed: boolean }, never>> {
    return this.queue.run(async () => {
      const rel = this.entryRel(target, bufferId);
      this.floors.set(rel, Infinity);
      return ok({ removed: await this.remove(rel) });
    });
  }

  /**
   * Records left by earlier runs (buffers of this process are excluded), grouped by project, newest first.
   * Corrupt records are skipped, logged and quarantined; records written by a newer NoobIDE are skipped and left in
   * place (S28.4); leftover temporary files are removed. Never throws.
   */
  listPending(): Promise<PendingProject[]> {
    return this.queue.run(async () => {
      const records = await this.scan();
      const projects = new Map<string, { rootPath: string; files: PendingFile[] }>();
      for (const { key, record } of records) {
        if (this.ownBuffers.has(record.bufferId)) continue;
        const project = projects.get(key) ?? { rootPath: record.rootPath, files: [] };
        project.files.push({
          relPath: record.relPath,
          bufferId: record.bufferId,
          revision: record.revision,
          updatedAt: record.updatedAt,
        });
        projects.set(key, project);
      }
      return [...projects.entries()]
        .map(([key, p]) => ({ key, rootPath: p.rootPath, files: p.files.sort((a, b) => b.updatedAt - a.updatedAt) }))
        .sort((a, b) => (b.files[0]?.updatedAt ?? 0) - (a.files[0]?.updatedAt ?? 0));
    });
  }

  /** Root path stored in the records of a pending project, for reopening it without the folder dialog. */
  async rootOfPending(key: string): Promise<string | undefined> {
    if (!PROJECT_KEY.test(key)) return undefined;
    const pending = await this.listPending();
    return pending.find((p) => p.key === key)?.rootPath;
  }

  read(target: JournalTarget, bufferId: string): Promise<Result<RecoveredBuffer, ReadEntryError>> {
    return this.queue.run(async () => {
      const result = await this.readRecord(this.entryRel(target, bufferId));
      if (!result.ok) return err(result.code === 'not-found' ? 'not-found' : 'corrupt', result.code);
      const r = result.value.record;
      if (r.rootPath !== target.rootPath || r.relPath !== target.relPath) return err('corrupt', 'misplaced');
      return ok({
        rootPath: r.rootPath,
        relPath: r.relPath,
        bufferId: r.bufferId,
        revision: r.revision,
        updatedAt: r.updatedAt,
        text: r.text,
        bom: r.bom,
      });
    });
  }

  /**
   * Decision 0033: reads a copy left by an earlier run by its project key and buffer id, without the project being
   * open — its folder may have been moved, renamed or be on a drive that is not connected. Buffers of this process
   * are not pending and are never returned here.
   */
  readPending(key: string, bufferId: string): Promise<Result<RecoveredBuffer, ReadEntryError>> {
    return this.queue.run(async () => {
      const rel = await this.pendingRel(key, bufferId);
      if (rel === undefined) return err('not-found', 'no record');
      const result = await this.readRecord(rel);
      if (!result.ok) return err(result.code === 'not-found' ? 'not-found' : 'corrupt', result.code);
      const r = result.value.record;
      return ok({
        rootPath: r.rootPath,
        relPath: r.relPath,
        bufferId: r.bufferId,
        revision: r.revision,
        updatedAt: r.updatedAt,
        text: r.text,
        bom: r.bom,
      });
    });
  }

  /** Decision 0033: the user threw away (or saved elsewhere) a pending copy of a project that is not open. */
  discardPending(key: string, bufferId: string): Promise<Result<{ removed: boolean }, never>> {
    return this.queue.run(async () => {
      const rel = await this.pendingRel(key, bufferId);
      if (rel === undefined) return ok({ removed: false });
      this.floors.set(rel, Infinity);
      return ok({ removed: await this.remove(rel) });
    });
  }

  /**
   * Decision 0033: the project folder of pending copies was moved; the user pointed at its new location. Every
   * readable record of `key` is rewritten for `newRoot` (a real path) under the new project key, then the old record
   * is removed — write first, remove second, so an interruption leaves a copy in at least one place. A record that
   * already exists at the new place with the same or a newer revision wins. Unreadable records stay where they are.
   */
  retarget(key: string, newRoot: string): Promise<Result<{ moved: number }, 'not-found' | 'write-failed'>> {
    return this.queue.run(async () => {
      if (!PROJECT_KEY.test(key)) return err('not-found', 'bad key');
      const newKey = projectKey(newRoot);
      if (newKey === key) return ok({ moved: 0 });
      let names: string[];
      try {
        names = await readdir(path.join(this.dir, key));
      } catch (e) {
        return err('not-found', errorCode(e));
      }
      const sizes = await this.loadSizes();
      let moved = 0;
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const rel = path.join(key, name);
        const result = await this.readRecord(rel);
        if (!result.ok) continue;
        const old = result.value.record;
        if (this.ownBuffers.has(old.bufferId)) continue;
        const newRel = path.join(newKey, `${fileKey(old.relPath)}-${old.bufferId}.json`);
        const existing = await this.readRecord(newRel);
        // A record at the new place that cannot be read right now (locked, over a limit, from a newer NoobIDE) is
        // never replaced: the old copy stays where it is (S26.1, S28.4).
        if (!existing.ok && existing.code !== 'not-found' && !QUARANTINED_REASONS.has(existing.code)) continue;
        if (!existing.ok || existing.value.record.revision < old.revision) {
          const record: EntryRecord = { ...old, rootPath: newRoot };
          const data = Buffer.from(JSON.stringify(record), 'utf8');
          // A longer root path can push a record over the entry limit: keep the old, readable copy instead.
          if (data.length > this.limits.maxEntryBytes) {
            this.log('recovery.retarget-skipped', { reason: 'too-large', bytes: data.length });
            continue;
          }
          try {
            await writeFileAtomic(path.join(this.dir, newRel), data);
          } catch (e) {
            this.log('recovery.retarget-failed', { code: errorCode(e) });
            return err('write-failed', errorCode(e), e);
          }
          sizes.set(newRel, data.length);
        }
        // A locked old record stays (counted where it is); it is offered again next start, nothing is lost.
        if (await this.remove(rel)) moved += 1;
      }
      this.log('recovery.retargeted', { moved });
      return ok({ moved });
    });
  }

  /**
   * S52.1: NoobIDE renamed or moved a file or folder of the open project at `rootPath`; every record of a file at or
   * below `from` (this run's buffers and copies left by a crash alike) is rewritten for the same path below `to`,
   * then the old record is removed — write first, remove second, so an interruption leaves a copy in at least one
   * place. Unreadable records stay where they are; recovery still offers them under the old name.
   */
  movePath(rootPath: string, from: string, to: string): Promise<Result<{ moved: number }, 'write-failed'>> {
    return this.queue.run(async () => {
      if (from === to || !isPortableRelPath(to)) return ok({ moved: 0 });
      const key = projectKey(rootPath);
      let names: string[];
      try {
        names = await readdir(path.join(this.dir, key));
      } catch {
        return ok({ moved: 0 }); // no records for this project
      }
      const sizes = await this.loadSizes();
      let moved = 0;
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const rel = path.join(key, name);
        const result = await this.readRecord(rel);
        if (!result.ok) continue;
        const old = result.value.record;
        // Compared in NFC: macOS may hand out NFD names for what the tab knows as NFC (like history keys).
        const recorded = old.relPath.normalize('NFC');
        const source = from.normalize('NFC');
        if (old.rootPath !== rootPath || !(recorded === source || recorded.startsWith(`${source}/`))) continue;
        const relPath = to + recorded.slice(source.length);
        const newRel = this.entryRel({ rootPath, relPath }, old.bufferId);
        // A rename that only changes the Unicode normalisation (NFD → NFC) can map a record onto its own place:
        // removing the "old" record after writing the new one would delete the only copy of the unsaved edits.
        if (newRel === rel) continue;
        const record: EntryRecord = { ...old, relPath };
        const data = Buffer.from(JSON.stringify(record), 'utf8');
        try {
          await writeFileAtomic(path.join(this.dir, newRel), data);
        } catch (e) {
          this.log('recovery.move-failed', { code: errorCode(e) });
          return err('write-failed', errorCode(e), e);
        }
        sizes.set(newRel, data.length);
        const floor = this.floors.get(rel);
        if (floor !== undefined) this.floors.set(newRel, Math.max(floor, this.floors.get(newRel) ?? -Infinity));
        if (await this.remove(rel)) moved += 1;
      }
      if (moved > 0) this.log('recovery.moved', { moved });
      return ok({ moved });
    });
  }

  usage(): Promise<JournalUsage> {
    return this.queue.run(async () => {
      const sizes = await this.loadSizes();
      return { bytes: sumOf(sizes), entries: sizes.size, limits: this.limits };
    });
  }

  /** Clear-data control: deletes every record and the quarantine. Live buffers re-journal on their next edit. */
  clearAll(): Promise<Result<null, 'clear-failed'>> {
    return this.queue.run(async () => {
      try {
        await rm(this.dir, { recursive: true, force: true });
      } catch (e) {
        this.log('recovery.clear-failed', { code: errorCode(e) });
        this.sizes = null;
        return err('clear-failed', errorCode(e), e);
      }
      this.sizes = new Map();
      this.floors.clear();
      this.log('recovery.cleared', {});
      return ok(null);
    });
  }

  private entryRel(target: JournalTarget, bufferId: string): string {
    if (!BUFFER_ID.test(bufferId)) throw new Error('invalid buffer id');
    return path.join(projectKey(target.rootPath), `${fileKey(target.relPath)}-${bufferId}.json`);
  }

  /** The record of a pending (earlier run's) buffer under a project key; undefined for anything else. */
  private async pendingRel(key: string, bufferId: string): Promise<string | undefined> {
    if (!PROJECT_KEY.test(key) || !BUFFER_ID.test(bufferId) || this.ownBuffers.has(bufferId)) return undefined;
    const names = await readdir(path.join(this.dir, key)).catch(() => [] as string[]);
    const name = names.find((n) => n.endsWith(`-${bufferId}.json`));
    return name === undefined ? undefined : path.join(key, name);
  }

  private async remove(rel: string): Promise<boolean> {
    const sizes = await this.loadSizes();
    try {
      await rm(path.join(this.dir, rel));
    } catch (e) {
      if (errorCode(e) === 'ENOENT') sizes.delete(rel);
      else this.log('recovery.remove-failed', { code: errorCode(e) }); // still on disk: keep counting it
      return false;
    }
    sizes.delete(rel);
    // Empty project folders are tidied up; a concurrent write recreates the folder.
    await rmdir(path.join(this.dir, path.dirname(rel))).catch(() => undefined);
    return true;
  }

  private async loadSizes(): Promise<Map<string, number>> {
    if (!this.sizes) await this.scan();
    return this.sizes ?? new Map();
  }

  private async readRecord(
    rel: string,
  ): Promise<Result<{ record: EntryRecord; bytes: number }, ReadEntryError | SkipReason>> {
    let raw: Buffer;
    try {
      const info = await stat(path.join(this.dir, rel));
      if (info.size > this.limits.maxEntryBytes) return err('too-large', `${info.size} bytes`);
      raw = await readFile(path.join(this.dir, rel));
    } catch (e) {
      return errorCode(e) === 'ENOENT' ? err('not-found', 'no record') : err('unreadable', errorCode(e));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return err('unparseable', 'not JSON');
    }
    if (isNewerRecord(parsed)) return err('newer', 'written by a newer NoobIDE');
    if (!isEntryRecord(parsed)) return err('invalid', 'schema');
    if (sha256Hex(parsed.text) !== parsed.sha256) return err('checksum', 'text does not match its checksum');
    const expected = path.join(projectKey(parsed.rootPath), `${fileKey(parsed.relPath)}-${parsed.bufferId}.json`);
    if (expected !== rel) return err('misplaced', 'record does not match its file name');
    return ok({ record: parsed, bytes: raw.length });
  }

  /** Reads every record, rebuilding the size table. Must run inside the queue. */
  private async scan(): Promise<{ key: string; record: EntryRecord }[]> {
    const sizes = new Map<string, number>();
    const records: { key: string; record: EntryRecord }[] = [];
    let projectDirs: string[] = [];
    try {
      projectDirs = (await readdir(this.dir, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && PROJECT_KEY.test(d.name))
        .map((d) => d.name);
    } catch (e) {
      if (errorCode(e) !== 'ENOENT') this.log('recovery.scan-failed', { code: errorCode(e) });
    }
    for (const key of projectDirs) {
      let names: string[];
      try {
        names = await readdir(path.join(this.dir, key));
      } catch (e) {
        this.log('recovery.scan-failed', { code: errorCode(e) });
        continue;
      }
      for (const name of names) {
        const rel = path.join(key, name);
        if (name.endsWith(TEMP_SUFFIX)) {
          // An interrupted atomic write; the previous record (if any) is intact. Recent ones may still be in
          // flight in another process (e.g. the self-test run next to the app), so only stale ones are removed.
          const file = path.join(this.dir, rel);
          const age = await stat(file).then(
            (info) => Date.now() - info.mtimeMs,
            () => 0,
          );
          if (age > STALE_TEMP_MS) await rm(file, { force: true }).catch(() => undefined);
          continue;
        }
        if (!name.endsWith('.json')) continue;
        const result = await this.readRecord(rel);
        if (result.ok) {
          records.push({ key, record: result.value.record });
          sizes.set(rel, result.value.bytes);
        } else if (result.code !== 'not-found') {
          this.log('recovery.entry-skipped', { reason: result.code, entry: `${key}/${name}` });
          // Only records that are certainly damaged are moved aside. Locked or oversized ones stay where they are
          // (skipped this time, still counted) so a transient error never costs a valid copy.
          if (QUARANTINED_REASONS.has(result.code)) await this.quarantine(rel);
          else
            sizes.set(
              rel,
              await stat(path.join(this.dir, rel)).then(
                (i) => i.size,
                () => 0,
              ),
            );
        }
      }
    }
    this.sizes = sizes;
    return records;
  }

  private async quarantine(rel: string): Promise<void> {
    const qdir = path.join(this.dir, QUARANTINE);
    try {
      await mkdir(qdir, { recursive: true });
      await rename(path.join(this.dir, rel), path.join(qdir, `${this.now()}-${path.basename(rel)}`));
      const kept = (await readdir(qdir)).sort();
      for (const old of kept.slice(0, Math.max(0, kept.length - this.limits.maxQuarantined))) {
        await rm(path.join(qdir, old), { force: true });
      }
    } catch (e) {
      this.log('recovery.quarantine-failed', { code: errorCode(e) });
    }
  }
}

function sumOf(sizes: Map<string, number>): number {
  let total = 0;
  for (const n of sizes.values()) total += n;
  return total;
}

/** A record of this journal's format with a higher version than this NoobIDE writes (S28.4). */
function isNewerRecord(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return r.format === FORMAT && typeof r.v === 'number' && Number.isInteger(r.v) && r.v > VERSION;
}

function isEntryRecord(value: unknown): value is EntryRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.format === FORMAT &&
    r.v === VERSION &&
    typeof r.rootPath === 'string' &&
    r.rootPath.length > 0 &&
    typeof r.relPath === 'string' &&
    isPortableRelPath(r.relPath) &&
    typeof r.bufferId === 'string' &&
    BUFFER_ID.test(r.bufferId) &&
    typeof r.revision === 'number' &&
    Number.isFinite(r.revision) &&
    typeof r.updatedAt === 'number' &&
    Number.isFinite(r.updatedAt) &&
    typeof r.bom === 'boolean' &&
    typeof r.sha256 === 'string' &&
    typeof r.text === 'string'
  );
}
