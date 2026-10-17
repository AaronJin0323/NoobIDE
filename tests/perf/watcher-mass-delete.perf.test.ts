import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WatchEvent } from '../../src/shared/ipc/contract';
import { ProjectWatcher } from '../../src/workspace/watcher';
import { checkBudget } from './budget';

const execFileAsync = promisify(execFile);

/** Deletes `dir/f0.txt … f<count-1>.txt` from a separate Node process. */
async function removeElsewhere(dir: string, count: number): Promise<void> {
  const script =
    "const fs=require('node:fs/promises'),path=require('node:path');" +
    'const [dir,n]=process.argv.slice(1);' +
    "Promise.all(Array.from({length:+n},(_,i)=>fs.rm(path.join(dir,'f'+i+'.txt')))).catch(e=>{console.error(e);process.exit(1)});";
  await execFileAsync(process.execPath, ['-e', script, dir, String(count)]);
}

/**
 * S07.3 review finding 5: a mass delete (3 000 files removed by another program) must not stall the main process's
 * event loop while the watcher classifies it (budget: the longest stall stays under 500 ms). The functional half —
 * one `rescan`, the snapshot shrinks — stays in tests/integration/watcher.test.ts; the lag budget lives here (S50.3,
 * ADR 0038): enforced by `npm run verify` on the dev machine, reported on GitHub Actions.
 */
let tmp: string;
let root: string;
let watcher: ProjectWatcher;
let events: WatchEvent[];

const p = (...segments: string[]) => path.join(root, ...segments);

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-watch-perf-')));
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  await mkdir(p('子 文件夹'), { recursive: true });
  await writeFile(p('index.html'), '<p>一</p>\n');
  await mkdir(p('many'));
  await Promise.all(Array.from({ length: 3000 }, (_, i) => writeFile(p('many', `f${i}.txt`), '')));
  events = [];
  watcher = new ProjectWatcher(root, (batch) => events.push(...batch), { debounceMs: 80 });
  await watcher.start();
});

afterEach(async () => {
  watcher.close();
  await rm(tmp, { recursive: true, force: true });
});

describe('watcher event-loop lag budget (S07.3 review finding 5)', () => {
  it('a mass delete never blocks the main process for long: max event-loop lag < 500 ms', async () => {
    expect(watcher.snapshotSize).toBeGreaterThan(3000);
    // FSEvents (macOS) replays the 3000 creations made just before the watch started; that batch is itself a mass
    // change (one rescan). Let it settle so the rescan measured below is the one caused by the deletes.
    await new Promise((r) => setTimeout(r, 400));
    await watcher.idle();
    events = [];
    // Measure event-loop stalls while the deletes are classified.
    let maxLag = 0;
    let last = Date.now();
    const probe = setInterval(() => {
      const now = Date.now();
      maxLag = Math.max(maxLag, now - last - 10);
      last = now;
    }, 10);
    try {
      // The deletes run in a child process, as another program would: only the watcher's own work may stall this
      // event loop (deleting 3000 files from here measured the test's I/O on slow runners, not the watcher).
      await removeElsewhere(p('many'), 3000);
      const deadline = Date.now() + 8000;
      // Wait until the deletes are fully classified: on Windows a rescan can already happen while the other process
      // is still deleting, and the remaining deletes arrive in later batches.
      while ((!events.some((e) => e.type === 'rescan') || watcher.snapshotSize >= 10) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        await watcher.idle();
      }
    } finally {
      clearInterval(probe);
    }
    expect(events).toContainEqual({ type: 'rescan' });
    expect(watcher.snapshotSize).toBeLessThan(10);
    checkBudget('watcher: max event-loop lag during a 3 000-file delete', maxLag, 500);
  }, 20_000);
});
