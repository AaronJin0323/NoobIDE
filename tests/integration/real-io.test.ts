// S58.10 — the cleanup a timed-out real-I/O test relies on (checkpoint-restore.test.ts:208 on hosted Windows, 2026-10-18:
// the test was cut off mid-write and its rmdir then failed with ENOTEMPTY).
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REAL_IO, removeTempDir, removeTempDirSync } from './real-io';

/**
 * Writes `rounds` files into each existing folder, as a test that lost its timeout goes on doing, until a write fails.
 * Against it a plain recursive rm fails with ENOTEMPTY (3 of 3 runs on Linux, 2026-10-18).
 */
function keepWriting(folders: string[], rounds = 300): { stopped: Promise<number> } {
  let written = 0;
  const stopped = (async () => {
    while (written < rounds) {
      try {
        await Promise.all(folders.map((f) => writeFile(path.join(f, `页面 ${written}.html`), '<p>还在 写</p>')));
        written += 1;
      } catch {
        return written; // the folder is gone: ENOENT, as for the cut-off test once its cleanup won
      }
    }
    return written;
  })();
  return { stopped };
}

describe('removeTempDir (S58.10)', REAL_IO, () => {
  it('removes a folder that is still being written to while it runs', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-real-io-'));
    const folders = ['a', path.join('b', '子 目录'), path.join('b', 'c', 'd')].map((f) =>
      path.join(tmp, '我的 网站', f),
    );
    for (const f of folders) await mkdir(f, { recursive: true });
    const writer = keepWriting(folders);
    await new Promise((resolve) => setTimeout(resolve, 5)); // let the writer get going
    await removeTempDir(tmp);
    expect(await writer.stopped).toBeGreaterThan(0);
    expect(existsSync(tmp)).toBe(false);
  });

  it('accepts a folder that is missing or was never created', async () => {
    await removeTempDir(path.join(os.tmpdir(), 'noobide-real-io-never-made'));
    await removeTempDir(undefined);
    removeTempDirSync(undefined);
  });
});
