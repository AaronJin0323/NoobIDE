import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** Suffix of in-flight temporary files. A crash can leave one behind; the stores delete them when they scan. */
export const TEMP_SUFFIX = '.noobide-tmp';

/**
 * Writes an app-data file (journal entry, history index or blob) atomically: temp file in the same directory,
 * flushed, then renamed over the target. Unlike the project save in src/workspace/atomic-write.ts the target may not
 * exist yet, and the directory is created on demand. A reader therefore sees the old or the new file, never half.
 */
export async function writeFileAtomic(target: string, data: Uint8Array | string): Promise<void> {
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
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
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
