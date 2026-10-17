import { randomBytes } from 'node:crypto';
import { readFile as fsReadFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Err, type Ok, type Result } from '../shared/result';
import { isIgnoredName } from '../workspace/ignore';
import { isListedEntry } from '../workspace/listing-filter';
import { SerialQueue, TEMP_SUFFIX, errorCode, silentLogger, writeFileAtomic, type RecoveryLogger } from './atomic-file';
import type { BlobAccess, BlobPins, SnapshotStore } from './history';
import { PROJECT_KEY, projectKey, sha256Hex } from './keys';

/**
 * Project checkpoints (S56.1, PLAN §12 v0.2): a named (or automatic) picture of the whole project, kept in the
 * app-data directory and never in the project. Separate from undo (editor), autosave, the crash journal and local
 * history (per file) — PLAN §7 keeps these mechanisms apart; a checkpoint is not version control.
 *
 * Layout:
 *   `<dir>/<projectKey>/<id>.json`          one manifest per checkpoint: name, kind, cause, time, and per file its
 *                                           relative path, SHA-256 and size
 *   `<history>/objects/<hh>/<sha256>`       the contents, in local history's content-addressed blob store (S21): a
 *                                           file unchanged since an earlier checkpoint (or kept by history) is
 *                                           stored once
 *
 * Which files: everything the project listing shows (`isListedEntry`, `isIgnoredName`): no dotfiles or dot-folders
 * (`.git`, `.env`, `.noobide`), no `node_modules`, no OS litter, no NoobIDE temporaries; links are not followed.
 *
 * Data-safety rules:
 * - Nothing is written into the project. Manifests are written atomically; blobs before the manifest that names them.
 * - Limits are checked before anything is stored: a checkpoint that would exceed one is refused with the reason (and
 *   the file or size concerned), never stored partially.
 * - One manifest per checkpoint: a damaged one makes only that checkpoint unusable (it is listed as damaged and can
 *   be deleted); a missing or damaged blob makes only that file of that checkpoint unavailable, and compare and
 *   restore report it. Local history is not affected by either.
 * - Every blob a manifest references — or might reference, for a damaged or unreadable one — is pinned in the
 *   history store, which therefore never deletes it. While the checkpoints cannot be read, history deletes no blob.
 * - Automatic checkpoints are pruned by {@link planAutoPrune}; named ones are only ever removed by the user.
 */

export type CheckpointKind = 'named' | 'auto';
/** What made the checkpoint: the user, or the operation it was taken before (S56.3). */
export type CheckpointCause = 'manual' | 'before-ai' | 'before-history-restore' | 'before-checkpoint-restore';
const CAUSES: readonly CheckpointCause[] = [
  'manual',
  'before-ai',
  'before-history-restore',
  'before-checkpoint-restore',
];

export interface CheckpointFile {
  /** Portable relative path, `/`-separated, NFC. */
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

export interface CheckpointRecord {
  readonly id: string;
  readonly rootPath: string;
  readonly name: string;
  readonly kind: CheckpointKind;
  readonly cause: CheckpointCause;
  readonly createdAt: number;
  /** Sorted by path. */
  readonly files: readonly CheckpointFile[];
}

export interface CheckpointSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: CheckpointKind;
  readonly cause: CheckpointCause;
  readonly createdAt: number;
  readonly fileCount: number;
  /** Sum of the file sizes (what a restore would write). */
  readonly bytes: number;
}

/** A checkpoint whose manifest cannot be used: listed so the user sees it and can delete it. */
export interface DamagedCheckpoint {
  readonly id: string;
  readonly reason: 'corrupt' | 'unreadable' | 'newer-format';
}

export interface CheckpointList {
  /** Newest first. */
  readonly checkpoints: readonly CheckpointSummary[];
  readonly damaged: readonly DamagedCheckpoint[];
}

export interface CheckpointLimits {
  /** Files in one checkpoint. */
  readonly maxFiles: number;
  /** Size of one file. */
  readonly maxFileBytes: number;
  /** Sum of the file sizes of one checkpoint. */
  readonly maxCheckpointBytes: number;
  /** Unique blob bytes referenced by all checkpoints of all projects. */
  readonly maxTotalBytes: number;
  /** Named checkpoints per project (never pruned: beyond this, saving another is refused). */
  readonly maxNamed: number;
  /** Automatic checkpoints kept per project (pruning policy, {@link planAutoPrune}). */
  readonly maxAuto: number;
  /** Automatic checkpoints older than this are pruned (the newest automatic one is always kept). */
  readonly maxAutoAgeMs: number;
}

export const DEFAULT_CHECKPOINT_LIMITS: CheckpointLimits = {
  maxFiles: 2000,
  maxFileBytes: 20 * 1024 * 1024,
  maxCheckpointBytes: 200 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxNamed: 50,
  maxAuto: 20,
  maxAutoAgeMs: 14 * 24 * 60 * 60 * 1000,
};

export const MAX_CHECKPOINT_NAME = 80;
/** Folder depth walked (deeper folders would make the listing refuse anyway). */
const MAX_DEPTH = 32;

export interface CheckpointUsage {
  /** Unique bytes over all checkpoints of all projects (what counts against `maxTotalBytes`). */
  readonly totalBytes: number;
  /** Unique bytes of this project's checkpoints. */
  readonly projectBytes: number;
  readonly named: number;
  readonly automatic: number;
  readonly damaged: number;
  readonly limits: CheckpointLimits;
}

export type CheckpointError =
  | 'too-many-files'
  | 'file-too-large'
  | 'checkpoint-too-large'
  | 'storage-full'
  | 'too-many-named'
  | 'invalid-name'
  | 'unavailable'
  | 'read-failed'
  | 'write-failed'
  | 'not-found'
  | 'damaged'
  | 'corrupt'
  | 'missing'
  /** A file changed or disappeared while the checkpoint was being saved: nothing was kept; try again. */
  | 'project-changed'
  /** A file name a checkpoint cannot hold (not portable): the checkpoint is refused and names it. */
  | 'unsupported-path';

/** Why a checkpoint was refused, for the explanation (a path the user owns, sizes and limits; never contents). */
export interface RefusalDetail {
  readonly relPath?: string;
  readonly bytes?: number;
  readonly limit?: number;
}

export type CheckpointErr<C extends CheckpointError = CheckpointError> = Err<C> & { readonly detail?: RefusalDetail };
export type CheckpointResult<T, C extends CheckpointError = CheckpointError> = Ok<T> | CheckpointErr<C>;

function refuse<C extends CheckpointError>(code: C, message: string, detail: RefusalDetail): CheckpointErr<C> {
  return { ...err(code, message), detail };
}

/** How a file differs between a checkpoint and the project now. */
export type CompareStatus = 'added' | 'changed' | 'removed' | 'same';

export interface CompareEntry {
  readonly relPath: string;
  readonly status: CompareStatus;
  /** SHA-256 of the file in the project now (null: `removed`). */
  readonly currentHash: string | null;
  /** SHA-256 in the checkpoint (null: `added`). */
  readonly checkpointHash: string | null;
  readonly checkpointSize: number | null;
  /** False when the checkpoint's copy is missing or damaged: this file cannot be restored from it. */
  readonly available: boolean;
}

export interface CheckpointCompare {
  readonly checkpoint: CheckpointSummary;
  /** Every file that differs, plus `same` ones; sorted by path. */
  readonly entries: readonly CompareEntry[];
  /** The project could not be read completely (a folder was unreadable): the comparison may be incomplete. */
  readonly incomplete: boolean;
}

export interface CheckpointOptions {
  /** App-data directory for checkpoint manifests, e.g. `<userData>/checkpoints`. Created on demand. */
  readonly dir: string;
  /** Local history's store: its blobs are shared (and pinned against its clean-up). */
  readonly history: Pick<SnapshotStore, 'withBlobs' | 'setPins'>;
  readonly limits?: Partial<CheckpointLimits>;
  readonly log?: RecoveryLogger;
  readonly now?: () => number;
  /** Fault injection for tests (locked manifests); defaults to fs.promises.readFile. */
  readonly readFile?: (file: string) => Promise<Buffer>;
}

const FORMAT = 'noobide-checkpoint';
const VERSION = 1;
const CHECKPOINT_ID = /^\d{1,16}-[0-9a-f]{8}$/;
const HASH = /^[0-9a-f]{64}$/;
const HASH_IN_TEXT = /[0-9a-f]{64}/g;

export const isCheckpointId = (value: unknown): value is string =>
  typeof value === 'string' && CHECKPOINT_ID.test(value);

/** A user-given name, trimmed and on one line; null when empty or too long. */
export function cleanCheckpointName(name: string): string | null {
  const line = name.replace(/\s+/g, ' ').trim();
  return line.length === 0 || line.length > MAX_CHECKPOINT_NAME ? null : line;
}

/**
 * The pruning policy for automatic checkpoints (S56.3): per project, newest first, an automatic checkpoint is kept
 * while it is among the newest `maxAuto` automatic ones and not older than `maxAutoAgeMs` — except that the newest
 * automatic checkpoint is always kept. Named checkpoints are never returned. Returns the ids to remove.
 */
export function planAutoPrune(
  checkpoints: readonly Pick<CheckpointSummary, 'id' | 'kind' | 'createdAt'>[],
  now: number,
  limits: Pick<CheckpointLimits, 'maxAuto' | 'maxAutoAgeMs'>,
): string[] {
  const autos = checkpoints.filter((c) => c.kind === 'auto').sort((a, b) => b.createdAt - a.createdAt);
  return autos
    .filter((c, index) => index > 0 && (index >= limits.maxAuto || now - c.createdAt > limits.maxAutoAgeMs))
    .map((c) => c.id);
}

interface ProjectCheckpoints {
  readonly records: Map<string, CheckpointRecord>;
  readonly damaged: Map<string, DamagedCheckpoint>;
  /** Hashes a damaged manifest's text may reference: kept until that checkpoint is deleted. */
  readonly protectedHashes: Map<string, ReadonlySet<string>>;
}

interface WalkedFile {
  readonly rel: string;
  readonly abs: string;
  readonly size: number;
}

export class CheckpointStore {
  readonly dir: string;
  readonly limits: CheckpointLimits;
  private readonly history: CheckpointOptions['history'];
  private readonly log: RecoveryLogger;
  private readonly now: () => number;
  private readonly readManifest: (file: string) => Promise<Buffer>;
  private readonly queue = new SerialQueue();

  private loaded = false;
  /** The checkpoints folder (or a project's folder in it) could not be read: nothing may be pruned or deleted. */
  private unreadable = false;
  private readonly projects = new Map<string, ProjectCheckpoints>();
  /** Blobs of a checkpoint being created (pinned before they are stored, until its manifest exists or it failed). */
  private readonly pending = new Set<string>();
  /** `pins()` as last computed; reset whenever a manifest, a pending pin or the load state changes. */
  private pinCache: BlobPins | null = null;

  constructor(options: CheckpointOptions) {
    this.dir = options.dir;
    this.limits = { ...DEFAULT_CHECKPOINT_LIMITS, ...options.limits };
    this.history = options.history;
    this.log = options.log ?? silentLogger;
    this.now = options.now ?? Date.now;
    this.readManifest = options.readFile ?? ((file) => fsReadFile(file));
    this.history.setPins(() => this.pins());
  }

  /** Loads every manifest (main calls it at start-up, so local history may delete blobs again). */
  load(): Promise<void> {
    return this.queue.run(() => this.ensureLoaded());
  }

  /** The blobs history must keep. Uncertain until loaded, and while any manifest folder is unreadable. */
  pins(): BlobPins {
    if (this.pinCache) return this.pinCache;
    const hashes = new Set<string>(this.pending);
    for (const project of this.projects.values()) {
      for (const record of project.records.values()) for (const f of record.files) hashes.add(f.hash);
      for (const set of project.protectedHashes.values()) for (const h of set) hashes.add(h);
    }
    const uncertain =
      !this.loaded ||
      this.unreadable ||
      [...this.projects.values()].some((p) => [...p.damaged.values()].some((d) => d.reason === 'unreadable'));
    this.pinCache = { hashes, uncertain };
    return this.pinCache;
  }

  /**
   * Takes a checkpoint of the whole project. An automatic checkpoint identical to the project's newest checkpoint is
   * not stored again (`deduped`: that one is returned). Limits are checked before anything is stored.
   */
  create(
    rootPath: string,
    request: {
      readonly name: string;
      readonly kind: CheckpointKind;
      readonly cause: CheckpointCause;
      /** A checkpoint that must survive this create (never pruned or removed for room): the one being restored. */
      readonly keep?: string;
    },
  ): Promise<CheckpointResult<{ checkpoint: CheckpointSummary; deduped: boolean }>> {
    return this.queue.run(async () => {
      const name = cleanCheckpointName(request.name);
      if (name === null) return refuse('invalid-name', 'empty or too long', { limit: MAX_CHECKPOINT_NAME });
      await this.reloadIfUnsure();
      const key = projectKey(rootPath);
      // While any manifest is unreadable the blob references are uncertain (and the older-version marker cannot be
      // kept complete): nothing new is stored until it can be read again.
      if (this.unreadable || this.pins().uncertain) return err('unavailable', 'checkpoints cannot be read now');
      const project = this.projectOf(key);
      if (request.kind === 'named') {
        const named = [...project.records.values()].filter((r) => r.kind === 'named').length;
        if (named >= this.limits.maxNamed) {
          return refuse('too-many-named', `${named} named checkpoints`, { limit: this.limits.maxNamed });
        }
      }

      const walked = await walkProject(rootPath);
      if (!walked.ok) return err('read-failed', walked.message);
      const files = walked.value;
      if (files.length > this.limits.maxFiles) {
        return refuse('too-many-files', `${files.length} files`, { bytes: files.length, limit: this.limits.maxFiles });
      }
      // A name the manifest could not hold (e.g. `a?.html` on macOS, a Windows device name) is refused here, never
      // stored as a checkpoint its next load would reject.
      const unsupported = files.find((f) => !isCheckpointPath(f.rel));
      if (unsupported) return refuse('unsupported-path', 'name not supported', { relPath: unsupported.rel });
      let total = 0;
      for (const f of files) {
        if (f.size > this.limits.maxFileBytes) {
          return refuse('file-too-large', `${f.size} bytes`, {
            relPath: f.rel,
            bytes: f.size,
            limit: this.limits.maxFileBytes,
          });
        }
        total += f.size;
      }
      if (total > this.limits.maxCheckpointBytes) {
        return refuse('checkpoint-too-large', `${total} bytes`, {
          bytes: total,
          limit: this.limits.maxCheckpointBytes,
        });
      }

      // Hash first (nothing stored yet, one file in memory at a time), so the storage limit is checked on what would
      // really be added.
      const hashed: CheckpointFile[] = [];
      for (const file of files) {
        const read = await this.readProjectFile(file);
        if (read === 'gone') continue;
        if (!read.ok) return read;
        hashed.push({ path: file.rel, hash: sha256Hex(read.value), size: read.value.length });
      }
      const sorted = (list: CheckpointFile[]) => list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      let manifestFiles = sorted(hashed);

      if (request.kind === 'auto') {
        const newest = newestOf(project);
        if (newest && sameFiles(newest.files, manifestFiles)) {
          return ok({ checkpoint: summaryOf(newest), deduped: true });
        }
      }

      // Storage limit over all checkpoints: older automatic checkpoints of this project may make room. Which ones is
      // only planned here; they are removed after the new checkpoint was stored (a refused or failed checkpoint never
      // costs the user an older one).
      const makeRoom = this.planRoom(project, manifestFiles, request.keep);
      if (makeRoom === null) {
        return refuse('storage-full', 'over the storage limit', {
          bytes: this.totalBytes() + this.bytesAdded(manifestFiles),
          limit: this.limits.maxTotalBytes,
        });
      }

      // Store: every blob is pinned before it is written, so history's clean-up can never take it in between. A file
      // that changed since it was hashed refuses the checkpoint: the limits were checked on what was hashed.
      const mine: string[] = [];
      const pin = (hash: string) => {
        if (!this.pending.has(hash)) {
          this.pending.add(hash);
          mine.push(hash);
          this.pinCache = null;
        }
      };
      const unpin = () => {
        for (const h of mine) this.pending.delete(h);
        this.pinCache = null;
      };
      const expected = new Map(manifestFiles.map((f) => [f.path, f.hash]));
      const createdAt = this.now();
      let record: CheckpointRecord;
      try {
        const stored: CheckpointFile[] = [];
        const failure = await this.history.withBlobs(async (blobs) => {
          for (const file of files) {
            const read = await this.readProjectFile(file);
            if (read === 'gone') {
              if (expected.has(file.rel)) return refuse('project-changed', 'a file was deleted', { relPath: file.rel });
              continue;
            }
            if (!read.ok) return read;
            const hash = sha256Hex(read.value);
            if (expected.get(file.rel) !== hash) {
              return refuse('project-changed', 'a file changed while the checkpoint was saved', { relPath: file.rel });
            }
            pin(hash);
            await blobs.put(read.value);
            stored.push({ path: file.rel, hash, size: read.value.length });
          }
          return null;
        });
        if (failure) {
          unpin();
          await this.releaseUnreferenced(mine);
          return failure;
        }
        manifestFiles = sorted(stored);
        record = {
          id: `${createdAt}-${randomBytes(4).toString('hex')}`,
          rootPath,
          name,
          kind: request.kind,
          cause: request.cause,
          createdAt,
          files: manifestFiles,
        };
        await writeFileAtomic(
          this.manifestPath(key, record.id),
          JSON.stringify({ format: FORMAT, v: VERSION, ...record }),
        );
        project.records.set(record.id, record);
        this.pinCache = null;
      } catch (e) {
        this.log('checkpoint.write-failed', { code: errorCode(e) });
        unpin();
        await this.releaseUnreferenced(mine);
        return err('write-failed', errorCode(e), e);
      }
      unpin();
      this.log('checkpoint.created', { kind: record.kind, cause: record.cause, files: manifestFiles.length });
      for (const id of makeRoom) {
        try {
          await this.remove(key, id);
        } catch (e) {
          this.log('checkpoint.prune-failed', { code: errorCode(e) });
        }
      }
      await this.pruneAuto(key, request.keep);
      await this.writeLegacyPins();
      return ok({ checkpoint: summaryOf(record), deduped: false });
    });
  }

  /** The project's checkpoints, newest first, and the damaged ones. */
  list(rootPath: string): Promise<Result<CheckpointList, 'unavailable'>> {
    return this.queue.run(async () => {
      await this.reloadIfUnsure();
      if (this.unreadable) return err('unavailable', 'checkpoints cannot be read now');
      const project = this.projects.get(projectKey(rootPath));
      const checkpoints = [...(project?.records.values() ?? [])]
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
        .map(summaryOf);
      return ok({ checkpoints, damaged: [...(project?.damaged.values() ?? [])] });
    });
  }

  /** Renames a checkpoint; renaming an automatic one makes it named (kept until the user deletes it). */
  rename(rootPath: string, id: string, newName: string): Promise<CheckpointResult<CheckpointSummary>> {
    return this.queue.run(async () => {
      const name = cleanCheckpointName(newName);
      if (name === null) return refuse('invalid-name', 'empty or too long', { limit: MAX_CHECKPOINT_NAME });
      await this.reloadIfUnsure();
      if (this.unreadable) return err('unavailable', 'checkpoints cannot be read now');
      const key = projectKey(rootPath);
      const project = this.projects.get(key);
      const record = project?.records.get(id);
      if (!project || !record) return err(project?.damaged.has(id) ? 'damaged' : 'not-found', 'no such checkpoint');
      if (record.kind === 'auto') {
        const named = [...project.records.values()].filter((r) => r.kind === 'named').length;
        if (named >= this.limits.maxNamed) {
          return refuse('too-many-named', `${named} named checkpoints`, { limit: this.limits.maxNamed });
        }
      }
      const renamed: CheckpointRecord = { ...record, name, kind: 'named' };
      try {
        await writeFileAtomic(this.manifestPath(key, id), JSON.stringify({ format: FORMAT, v: VERSION, ...renamed }));
      } catch (e) {
        this.log('checkpoint.write-failed', { code: errorCode(e) });
        return err('write-failed', errorCode(e), e);
      }
      project.records.set(id, renamed);
      return ok(summaryOf(renamed));
    });
  }

  /** Deletes a checkpoint (also a damaged one). Its blobs go once nothing — checkpoint or history — references them. */
  delete(rootPath: string, id: string): Promise<CheckpointResult<null>> {
    return this.queue.run(async () => {
      await this.reloadIfUnsure();
      const key = projectKey(rootPath);
      const project = this.projects.get(key);
      if (!project || (!project.records.has(id) && !project.damaged.has(id)))
        return err('not-found', 'no such checkpoint');
      try {
        await this.remove(key, id);
        await this.writeLegacyPins();
        return ok(null);
      } catch (e) {
        this.log('checkpoint.delete-failed', { code: errorCode(e) });
        return err('write-failed', errorCode(e), e);
      }
    });
  }

  /** A checkpoint's manifest. */
  get(
    rootPath: string,
    id: string,
  ): Promise<CheckpointResult<CheckpointRecord, 'not-found' | 'damaged' | 'unavailable'>> {
    return this.queue.run(async () => {
      await this.reloadIfUnsure();
      if (this.unreadable) return err('unavailable', 'checkpoints cannot be read now');
      const project = this.projects.get(projectKey(rootPath));
      const record = project?.records.get(id);
      if (record) return ok(record);
      return err(project?.damaged.has(id) ? 'damaged' : 'not-found', 'no such checkpoint');
    });
  }

  /** One file's content in a checkpoint, hash-verified. `corrupt` / `missing`: this file's copy is unusable. */
  readFile(
    rootPath: string,
    id: string,
    relPath: string,
  ): Promise<CheckpointResult<Uint8Array, 'not-found' | 'damaged' | 'unavailable' | 'corrupt' | 'missing'>> {
    return this.queue.run(async () => {
      await this.reloadIfUnsure();
      const project = this.projects.get(projectKey(rootPath));
      const record = project?.records.get(id);
      if (!record) return err(project?.damaged.has(id) ? 'damaged' : 'not-found', 'no such checkpoint');
      const file = record.files.find((f) => f.path === relPath.normalize('NFC'));
      if (!file) return err('not-found', 'no such file in the checkpoint');
      const data = await this.history.withBlobs((blobs) => blobs.read(file.hash));
      if (!data.ok) {
        this.log('checkpoint.blob-unavailable', { code: data.code });
        return err(data.code === 'not-found' ? 'missing' : 'corrupt', data.message);
      }
      return ok(data.value);
    });
  }

  /** File-by-file comparison of a checkpoint with the project now (every copy the restore would need is checked). */
  compare(
    rootPath: string,
    id: string,
  ): Promise<CheckpointResult<CheckpointCompare, 'not-found' | 'damaged' | 'unavailable' | 'read-failed'>> {
    return this.queue.run(async () => {
      await this.reloadIfUnsure();
      if (this.unreadable) return err('unavailable', 'checkpoints cannot be read now');
      const project = this.projects.get(projectKey(rootPath));
      const record = project?.records.get(id);
      if (!record) return err(project?.damaged.has(id) ? 'damaged' : 'not-found', 'no such checkpoint');
      const walked = await walkProject(rootPath, { tolerant: true });
      if (!walked.ok) return err('read-failed', walked.message);
      const current = new Map<string, string>();
      let incomplete = walked.incomplete;
      for (const f of walked.value) {
        try {
          current.set(f.rel, sha256Hex(await fsReadFile(f.abs)));
        } catch (e) {
          if (errorCode(e) !== 'ENOENT') incomplete = true;
        }
      }
      const wanted = new Map(record.files.map((f) => [f.path, f]));
      const intact = await this.history.withBlobs(async (blobs) => {
        const out = new Map<string, boolean>();
        for (const f of record.files) {
          if (out.has(f.hash)) continue;
          // Only the copies a restore would write are verified; `same` files are not needed.
          if (current.get(f.path) === f.hash) continue;
          out.set(f.hash, await blobs.intact(f.hash));
        }
        return out;
      });
      const entries: CompareEntry[] = [];
      for (const f of record.files) {
        const now = current.get(f.path) ?? null;
        const status: CompareStatus = now === null ? 'removed' : now === f.hash ? 'same' : 'changed';
        entries.push({
          relPath: f.path,
          status,
          currentHash: now,
          checkpointHash: f.hash,
          checkpointSize: f.size,
          available: status === 'same' || intact.get(f.hash) === true,
        });
      }
      for (const [rel, hash] of current) {
        if (!wanted.has(rel)) {
          entries.push({
            relPath: rel,
            status: 'added',
            currentHash: hash,
            checkpointHash: null,
            checkpointSize: null,
            available: true,
          });
        }
      }
      entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
      const missing = entries.filter((e) => !e.available).length;
      if (missing > 0) this.log('checkpoint.files-unavailable', { count: missing });
      return ok({ checkpoint: summaryOf(record), entries, incomplete });
    });
  }

  usage(rootPath?: string): Promise<CheckpointUsage> {
    return this.queue.run(async () => {
      await this.reloadIfUnsure();
      const project = rootPath === undefined ? undefined : this.projects.get(projectKey(rootPath));
      const records = [...(project?.records.values() ?? [])];
      const unique = new Map<string, number>();
      for (const r of records) for (const f of r.files) unique.set(f.hash, f.size);
      return {
        totalBytes: this.totalBytes(),
        projectBytes: [...unique.values()].reduce((n, s) => n + s, 0),
        named: records.filter((r) => r.kind === 'named').length,
        automatic: records.filter((r) => r.kind === 'auto').length,
        damaged: project?.damaged.size ?? 0,
        limits: this.limits,
      };
    });
  }

  /** Applies the automatic-checkpoint pruning policy to a project now. Returns how many were removed. */
  prune(rootPath: string): Promise<number> {
    return this.queue.run(async () => {
      await this.reloadIfUnsure();
      return this.pruneAuto(projectKey(rootPath));
    });
  }

  /** Resolves when every queued operation has finished (tests). */
  idle(): Promise<void> {
    return this.queue.run(async () => undefined);
  }

  // ── internals (inside the queue) ───────────────────────────────────────

  /** A project file's bytes; 'gone' when it was deleted meanwhile (it is then not part of the checkpoint). */
  private async readProjectFile(
    file: WalkedFile,
  ): Promise<Ok<Uint8Array> | CheckpointErr<'file-too-large' | 'read-failed'> | 'gone'> {
    let data: Uint8Array;
    try {
      data = new Uint8Array(await fsReadFile(file.abs));
    } catch (e) {
      if (errorCode(e) === 'ENOENT') return 'gone';
      this.log('checkpoint.read-failed', { code: errorCode(e) });
      return refuse('read-failed', errorCode(e), { relPath: file.rel });
    }
    if (data.length > this.limits.maxFileBytes) {
      return refuse('file-too-large', `${data.length} bytes`, {
        relPath: file.rel,
        bytes: data.length,
        limit: this.limits.maxFileBytes,
      });
    }
    return ok(data);
  }

  private projectOf(key: string): ProjectCheckpoints {
    let project = this.projects.get(key);
    if (!project) {
      project = { records: new Map(), damaged: new Map(), protectedHashes: new Map() };
      this.projects.set(key, project);
    }
    return project;
  }

  private manifestPath(key: string, id: string): string {
    return path.join(this.dir, key, `${id}.json`);
  }

  /** Unique bytes of all checkpoints, without the ones in `without`. */
  private totalBytes(without: ReadonlySet<string> = new Set()): number {
    const unique = new Map<string, number>();
    for (const p of this.projects.values()) {
      for (const r of p.records.values()) {
        if (!without.has(r.id)) for (const f of r.files) unique.set(f.hash, f.size);
      }
    }
    return [...unique.values()].reduce((n, s) => n + s, 0);
  }

  /** Bytes `files` add to the checkpoints' unique total (the ones in `without` not counted). */
  private bytesAdded(files: readonly CheckpointFile[], without: ReadonlySet<string> = new Set()): number {
    const known = new Set<string>();
    for (const p of this.projects.values()) {
      for (const r of p.records.values()) if (!without.has(r.id)) for (const f of r.files) known.add(f.hash);
    }
    const added = new Map<string, number>();
    for (const f of files) if (!known.has(f.hash)) added.set(f.hash, f.size);
    return [...added.values()].reduce((n, s) => n + s, 0);
  }

  /**
   * The automatic checkpoints of this project (oldest first) that must go for `files` to fit the storage limit; an
   * empty list when it fits, null when even removing all of them is not enough. Removes nothing.
   */
  private planRoom(project: ProjectCheckpoints, files: readonly CheckpointFile[], keep?: string): string[] | null {
    const fits = (without: ReadonlySet<string>) =>
      this.totalBytes(without) + this.bytesAdded(files, without) <= this.limits.maxTotalBytes;
    const doomed = new Set<string>();
    if (fits(doomed)) return [];
    const autos = [...project.records.values()]
      .filter((r) => r.kind === 'auto' && r.id !== keep)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const auto of autos) {
      doomed.add(auto.id);
      if (fits(doomed)) return [...doomed];
    }
    return null;
  }

  private async pruneAuto(key: string, keep?: string): Promise<number> {
    const project = this.projects.get(key);
    if (!project || this.unreadable) return 0;
    const doomed = planAutoPrune([...project.records.values()], this.now(), this.limits).filter((id) => id !== keep);
    let removed = 0;
    for (const id of doomed) {
      try {
        await this.remove(key, id);
        removed += 1;
      } catch (e) {
        this.log('checkpoint.prune-failed', { code: errorCode(e) });
      }
    }
    if (removed > 0) {
      this.log('checkpoint.pruned', { count: removed });
      await this.writeLegacyPins();
    }
    return removed;
  }

  /** Removes a manifest, then the blobs nothing references any more. */
  private async remove(key: string, id: string): Promise<void> {
    const project = this.projects.get(key);
    if (!project) return;
    const record = project.records.get(id);
    const protectedSet = project.protectedHashes.get(id);
    await rm(this.manifestPath(key, id), { force: true });
    project.records.delete(id);
    project.damaged.delete(id);
    project.protectedHashes.delete(id);
    this.pinCache = null;
    const candidates = [...(record?.files.map((f) => f.hash) ?? []), ...(protectedSet ?? [])];
    await this.releaseUnreferenced(candidates);
  }

  /**
   * Keeps history's marker for older NoobIDE versions current (decision 0038): they do not know about checkpoints,
   * but never delete a blob named by an index from a newer version.
   */
  private async writeLegacyPins(): Promise<void> {
    const pins = this.pins();
    if (pins.uncertain) return;
    const hashes = new Set(pins.hashes);
    for (const h of this.pending) hashes.delete(h);
    try {
      await this.history.withBlobs((blobs) => blobs.writeLegacyPins([...hashes].sort()));
    } catch (e) {
      this.log('checkpoint.legacy-pins-failed', { code: errorCode(e) });
    }
  }

  private async releaseUnreferenced(hashes: readonly string[]): Promise<void> {
    if (hashes.length === 0) return;
    const pinned = this.pins();
    if (pinned.uncertain) return;
    const free = [...new Set(hashes)].filter((h) => !pinned.hashes.has(h));
    if (free.length > 0) await this.history.withBlobs((blobs: BlobAccess) => blobs.release(free));
  }

  private async reloadIfUnsure(): Promise<void> {
    const unsure =
      this.unreadable ||
      [...this.projects.values()].some((p) => [...p.damaged.values()].some((d) => d.reason === 'unreadable'));
    if (this.loaded && unsure) {
      this.loaded = false;
      this.unreadable = false;
      this.projects.clear();
      this.pinCache = null;
    }
    await this.ensureLoaded();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    let keys: string[];
    try {
      keys = await readdir(this.dir);
    } catch (e) {
      if (errorCode(e) !== 'ENOENT') {
        this.unreadable = true;
        this.log('checkpoint.dir-unreadable', { code: errorCode(e) });
      }
      this.loaded = true;
      this.pinCache = null;
      return;
    }
    for (const key of keys) {
      if (!PROJECT_KEY.test(key)) continue;
      let names: string[];
      try {
        names = await readdir(path.join(this.dir, key));
      } catch (e) {
        if (errorCode(e) === 'ENOTDIR' || errorCode(e) === 'ENOENT') continue;
        this.unreadable = true;
        this.log('checkpoint.dir-unreadable', { code: errorCode(e) });
        continue;
      }
      const project = this.projectOf(key);
      for (const name of names) {
        const file = path.join(this.dir, key, name);
        if (name.endsWith(TEMP_SUFFIX)) {
          await removeIfStale(file);
          continue;
        }
        const id = name.endsWith('.json') ? name.slice(0, -5) : '';
        if (!CHECKPOINT_ID.test(id)) continue;
        await this.loadManifest(key, id, file, project);
      }
    }
    this.loaded = true;
    this.pinCache = null;
    await this.writeLegacyPins();
  }

  private async loadManifest(key: string, id: string, file: string, project: ProjectCheckpoints): Promise<void> {
    let raw: string;
    try {
      raw = (await this.readManifest(file)).toString('utf8');
    } catch (e) {
      if (errorCode(e) === 'ENOENT') return;
      project.damaged.set(id, { id, reason: 'unreadable' });
      this.log('checkpoint.manifest-unreadable', { code: errorCode(e) });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const r = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    if (r?.format === FORMAT && typeof r.v === 'number' && r.v > VERSION) {
      project.damaged.set(id, { id, reason: 'newer-format' });
      project.protectedHashes.set(id, new Set(raw.match(HASH_IN_TEXT) ?? []));
      return;
    }
    const record = r ? toRecord(r, id) : null;
    if (!record || projectKey(record.rootPath) !== key) {
      // Only this checkpoint is unusable; whatever its text names stays (it may be repaired or deleted).
      project.damaged.set(id, { id, reason: 'corrupt' });
      project.protectedHashes.set(id, new Set(raw.match(HASH_IN_TEXT) ?? []));
      this.log('checkpoint.manifest-corrupt', { id });
      return;
    }
    project.records.set(id, record);
  }
}

function toRecord(r: Record<string, unknown>, id: string): CheckpointRecord | null {
  if (r.format !== FORMAT || r.v !== VERSION || r.id !== id) return null;
  if (typeof r.rootPath !== 'string' || r.rootPath === '') return null;
  if (typeof r.name !== 'string' || cleanCheckpointName(r.name) === null) return null;
  if (r.kind !== 'named' && r.kind !== 'auto') return null;
  if (!CAUSES.includes(r.cause as CheckpointCause)) return null;
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) return null;
  if (!Array.isArray(r.files)) return null;
  const files: CheckpointFile[] = [];
  for (const item of r.files as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const f = item as Record<string, unknown>;
    if (typeof f.path !== 'string' || !isCheckpointPath(f.path)) return null;
    if (typeof f.hash !== 'string' || !HASH.test(f.hash)) return null;
    if (typeof f.size !== 'number' || !Number.isSafeInteger(f.size) || f.size < 0) return null;
    files.push({ path: f.path, hash: f.hash, size: f.size });
  }
  if (!consistentPaths(files.map((f) => f.path))) return null;
  return {
    id,
    rootPath: r.rootPath,
    name: r.name,
    kind: r.kind,
    cause: r.cause as CheckpointCause,
    createdAt: r.createdAt,
    files,
  };
}

/** Device names Windows reserves in every folder (with or without an extension). */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * A manifest's path must be one the project walk could have produced: portable, relative, NFC, every segment a
 * listed and not ignored name (never `..`, a dotfile such as `.git` or `.noobide`, `node_modules`), no Windows device
 * names or trailing dots and spaces. A crafted manifest can therefore never make a restore write elsewhere.
 */
export function isCheckpointPath(rel: string): boolean {
  if (rel === '' || rel.length > 1024 || rel !== rel.normalize('NFC')) return false;
  if (rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return false;
  const segments = rel.split('/');
  return segments.every(
    (seg, i) =>
      seg !== '' &&
      ![...seg].some((ch) => ch.charCodeAt(0) < 0x20 || '<>:"|?*'.includes(ch)) &&
      !/[. ]$/.test(seg) &&
      !RESERVED.test(seg) &&
      isListedEntry(seg, i < segments.length - 1) &&
      !isIgnoredName(seg),
  );
}

/** Unique paths, none of them also a folder of another (`a` and `a/b`). */
function consistentPaths(paths: readonly string[]): boolean {
  const set = new Set(paths);
  if (set.size !== paths.length) return false;
  return paths.every((p) => {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i += 1) if (set.has(parts.slice(0, i).join('/'))) return false;
    return true;
  });
}

function summaryOf(r: CheckpointRecord): CheckpointSummary {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    cause: r.cause,
    createdAt: r.createdAt,
    fileCount: r.files.length,
    bytes: r.files.reduce((n, f) => n + f.size, 0),
  };
}

function newestOf(project: ProjectCheckpoints): CheckpointRecord | undefined {
  let newest: CheckpointRecord | undefined;
  for (const r of project.records.values()) if (!newest || r.createdAt >= newest.createdAt) newest = r;
  return newest;
}

function sameFiles(a: readonly CheckpointFile[], b: readonly CheckpointFile[]): boolean {
  return a.length === b.length && a.every((f, i) => f.path === b[i]?.path && f.hash === b[i]?.hash);
}

/**
 * The project's files as the listing shows them: hidden and ignored names skipped, links not followed. Strict mode
 * (create) fails on any unreadable folder — a checkpoint is never silently missing part of the project; tolerant mode
 * (compare) notes it as `incomplete`.
 */
async function walkProject(
  root: string,
  options: { readonly tolerant?: boolean } = {},
): Promise<(Ok<WalkedFile[]> & { readonly incomplete: boolean }) | Err<'read-failed'>> {
  const files: WalkedFile[] = [];
  let incomplete = false;
  const walk = async (dir: string, rel: string, depth: number): Promise<string | null> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (options.tolerant && depth > 0) {
        incomplete = true;
        return null;
      }
      return errorCode(e);
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !isListedEntry(entry.name, entry.isDirectory()) || isIgnoredName(entry.name)) {
        continue;
      }
      const childRel = (rel ? `${rel}/${entry.name}` : entry.name).normalize('NFC');
      const childAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth + 1 > MAX_DEPTH) {
          if (options.tolerant) incomplete = true;
          else return 'too-deep';
          continue;
        }
        const failed = await walk(childAbs, childRel, depth + 1);
        if (failed !== null) return failed;
      } else if (entry.isFile()) {
        try {
          files.push({ rel: childRel, abs: childAbs, size: (await stat(childAbs)).size });
        } catch (e) {
          if (errorCode(e) !== 'ENOENT') {
            if (options.tolerant) incomplete = true;
            else return errorCode(e);
          }
        }
      }
    }
    return null;
  };
  const failed = await walk(root, '', 0);
  if (failed !== null) return err('read-failed', failed);
  return { ...ok(files), incomplete };
}

async function removeIfStale(file: string): Promise<void> {
  const age = await stat(file).then(
    (info) => Date.now() - info.mtimeMs,
    () => 0,
  );
  if (age > 60_000) await rm(file, { force: true }).catch(() => undefined);
}
