// S58.10 — shared by the integration tests that do real file-system or process I/O (docs/perf/ci-runners.md §2).
import { rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';

/**
 * Functional timeout for a test or hook that writes real files or spawns processes. A starved hosted Windows runner was
 * 20-30x slower than the dev machine on disk writes and blew the 5 s Vitest default (runs 39018194387, 39084558959,
 * 39097174400). It decides how long a hung test takes to fail; it is not a speed budget, which belongs in tests/perf.
 */
export const REAL_IO = { timeout: 60_000 } as const;

// rm retries ENOTEMPTY, EBUSY, EPERM, EMFILE and ENFILE, waiting retryDelay × attempt between tries (5.5 s in all).
// ENOTEMPTY: a test cut off by its timeout keeps writing into the folder while the cleanup removes it. EBUSY / EPERM: a
// virus scanner or indexer holding a just-written file on Windows.
const RETRY = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;

/** Removes a test's temporary folder, retrying while files are still appearing in it or are briefly locked. */
export async function removeTempDir(dir: string | undefined): Promise<void> {
  if (dir) await rm(dir, RETRY);
}

/** The synchronous variant for tests that set up with the *Sync APIs. */
export function removeTempDirSync(dir: string | undefined): void {
  if (dir) rmSync(dir, RETRY);
}
