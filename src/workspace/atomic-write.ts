import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import { canSyncDirectory, lockedRenameBackoffMs } from '../platform/index';

/**
 * Atomic file replacement (S10.1, AGENTS.md: "Saves are atomic — temp file + rename").
 *
 * 1. Leftover temp files of this target from an earlier crash are removed (only our exact name pattern).
 * 2. A temp file is created next to the target — rename is only atomic within one directory/volume — written,
 *    given the target's permission bits explicitly (open() is subject to the umask) and flushed to disk.
 * 3. The temp file is renamed over the target. On Windows, a target briefly held open by another program makes the
 *    rename fail with EPERM/EACCES/EBUSY; it is retried with backoff and, if it stays locked, reported as
 *    {@link FileInUseError} ("in use"), not as a permission problem.
 * 4. Where supported, the directory is fsynced so the rename itself survives a power loss.
 *
 * On any failure the temp file is removed and the target is left exactly as it was; the caller keeps its content.
 * The file system is injectable so failures (ENOSPC, locks, read-only folders) are tested deterministically.
 */
export interface AtomicFileHandle {
  writeFile(data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicFs {
  stat(target: string): Promise<{ mode: number }>;
  open(target: string, flags: string, mode?: number): Promise<AtomicFileHandle>;
  rename(from: string, to: string): Promise<void>;
  rm(target: string, options: { force: boolean }): Promise<void>;
  readdir(dir: string): Promise<string[]>;
}

export const nodeAtomicFs: AtomicFs = {
  stat: (target) => nodeFs.stat(target),
  open: (target, flags, mode) => nodeFs.open(target, flags, mode),
  rename: (from, to) => nodeFs.rename(from, to),
  rm: (target, options) => nodeFs.rm(target, options),
  readdir: (dir) => nodeFs.readdir(dir),
};

export interface AtomicWriteOptions {
  readonly fs?: AtomicFs;
  /** Write a new file when the target does not exist (save elsewhere). Default: the target must exist. */
  readonly createIfMissing?: boolean;
  /** Delays before each rename retry; default from the platform adapter (Windows only). */
  readonly renameBackoffMs?: readonly number[];
  readonly syncDirectory?: boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The target stayed locked by another program through every rename retry. `code` maps to the "busy" save error. */
export class FileInUseError extends Error {
  readonly code = 'EBUSY';
  constructor(
    readonly originalCode: string,
    readonly attempts: number,
  ) {
    super(`${originalCode} after ${attempts} attempts`);
    this.name = 'FileInUseError';
  }
}

const TEMP_SUFFIX = '.noobide-tmp';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export function tempNameFor(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}${TEMP_SUFFIX}`);
}

/** True only for temp files this module creates for `targetName`: `.<name>.<uuid>.noobide-tmp`. */
export function isOwnTempFile(entry: string, targetName: string): boolean {
  const prefix = `.${targetName}.`;
  if (!entry.startsWith(prefix) || !entry.endsWith(TEMP_SUFFIX)) return false;
  return UUID.test(entry.slice(prefix.length, entry.length - TEMP_SUFFIX.length));
}

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function writeFileAtomic(
  target: string,
  data: Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const fs = options.fs ?? nodeAtomicFs;
  const backoff = options.renameBackoffMs ?? lockedRenameBackoffMs();
  const sleep = options.sleep ?? defaultSleep;

  let mode: number | undefined;
  try {
    mode = (await fs.stat(target)).mode & 0o777;
  } catch (error) {
    if (!(options.createIfMissing && codeOf(error) === 'ENOENT')) throw error;
  }

  const dir = path.dirname(target);
  await removeStaleTempFiles(fs, dir, path.basename(target));

  const tmp = tempNameFor(target);
  try {
    const handle = await fs.open(tmp, 'wx', mode);
    try {
      await handle.writeFile(data);
      if (mode !== undefined) await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(fs, tmp, target, backoff, sleep);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  if (options.syncDirectory ?? canSyncDirectory()) await syncDirectory(fs, dir);
}

/** Replaces an existing file atomically (the file must exist). */
export function replaceFileAtomic(target: string, data: Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  return writeFileAtomic(target, data, { ...options, createIfMissing: false });
}

async function renameWithRetry(
  fs: AtomicFs,
  from: string,
  to: string,
  backoff: readonly number[],
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = codeOf(error);
      if (!LOCK_CODES.has(code) || backoff.length === 0) throw error;
      const delay = backoff[attempt];
      if (delay === undefined) throw new FileInUseError(code, attempt + 1);
      await sleep(delay);
    }
  }
}

/**
 * Removes our own leftovers for one target. Writes within this app are serialized per file, so a temp file seen here
 * is from a crash; a second NoobIDE instance saving the same file at the same moment could lose its temp file and
 * report a failed save (its edits are kept), which is acceptable for a case the single-instance lock already rules out.
 */
async function removeStaleTempFiles(fs: AtomicFs, dir: string, targetName: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return; // The write itself will report an unreadable folder.
  }
  for (const entry of entries) {
    if (isOwnTempFile(entry, targetName)) await fs.rm(path.join(dir, entry), { force: true }).catch(() => undefined);
  }
}

async function syncDirectory(fs: AtomicFs, dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort: the data is already renamed into place; some file systems refuse directory fsync.
  }
}
