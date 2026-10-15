import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { lockedRenameBackoffMs } from '../platform/index';

/** Suffix of in-flight temporary files. A crash can leave one behind; the stores delete them when they scan. */
export const TEMP_SUFFIX = '.noobide-tmp';

/**
 * Writes an app-data file (journal entry, history index or blob) atomically: temp file in the same directory,
 * flushed, then renamed over the target. Unlike the project save in src/workspace/atomic-write.ts the target may not
 * exist yet, and the directory is created on demand. A reader therefore sees the old or the new file, never half.
 *
 * On Windows a target that another program (antivirus, indexer, a reader of the file) holds open makes the rename
 * fail with EPERM/EACCES/EBUSY for a moment; like the project save, the rename is retried with the platform's backoff
 * before the write is reported as failed. POSIX renames do not hit this, so there it fails at once.
 */
export interface WriteFileAtomicOptions {
  /** Delays before each rename retry; default from the platform adapter (Windows only). */
  readonly renameBackoffMs?: readonly number[];
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
}

const LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export async function writeFileAtomic(
  target: string,
  data: Uint8Array | string,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${randomUUID()}${TEMP_SUFFIX}`);
  try {
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, target, options);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function renameWithRetry(from: string, to: string, options: WriteFileAtomicOptions): Promise<void> {
  const backoff = options.renameBackoffMs ?? lockedRenameBackoffMs();
  const doRename = options.rename ?? rename;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await doRename(from, to);
      return;
    } catch (error) {
      const delay = backoff[attempt];
      if (!LOCK_CODES.has(errorCode(error)) || delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

/** OS error code (ENOENT, EACCES…) or the error's name. Safe to log: never contains file contents. */
export function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown';
}

/**
 * Structured, content-free log line. Recovery and history modules log only event names, counts, hashed keys and
 * error codes — never text, file contents or user paths (AGENTS.md: logs never contain source code).
 */
export type RecoveryLogger = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;

export const silentLogger: RecoveryLogger = () => undefined;

/** Main-process logger: event name and content-free fields only. */
export const consoleLogger: RecoveryLogger = (event, fields) =>
  console.warn(`[noobide] ${event} ${JSON.stringify(fields)}`);

/** Runs async operations one after another (per store), so index read-modify-write cycles never interleave. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.tail.then(op, op);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
