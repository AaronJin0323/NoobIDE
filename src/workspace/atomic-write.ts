import { randomUUID } from 'node:crypto';
import { open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Replaces an existing file atomically (AGENTS.md: "Saves are atomic — temp file + rename"). The temporary file is
 * created next to the target, because rename is only atomic within one directory/volume, flushed to disk, given the
 * target's permission bits and then renamed over the target. On any failure the temporary file is removed and the
 * target is left exactly as it was; the caller keeps the in-memory content.
 */
export async function replaceFileAtomic(target: string, data: Uint8Array): Promise<void> {
  const { mode } = await stat(target);
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.noobide-tmp`);
  try {
    const handle = await open(tmp, 'wx', mode & 0o777);
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
