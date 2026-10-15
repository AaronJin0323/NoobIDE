import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WatchEvent } from '../../src/shared/ipc/contract';
import { ProjectWatcher, type WatchFn } from '../../src/workspace/watcher';

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
 * S07.3: the watcher on the real file system (ReadDirectoryChangesW on Windows, FSEvents on macOS) in a project
 * path with Chinese characters and spaces. Each test waits for the debounced batch it expects.
 */
let tmp: string;
let root: string;
let watcher: ProjectWatcher;
let events: WatchEvent[];

const p = (...segments: string[]) => path.join(root, ...segments);

async function startWatching() {
  events = [];
  watcher = new ProjectWatcher(root, (batch) => events.push(...batch), { debounceMs: 80 });
  await watcher.start();
  // Let the OS watch settle before the first change.
  await new Promise((r) => setTimeout(r, 150));
}

/** Waits until `expected` has arrived (in any order), then a little longer to catch unexpected extra events. */
async function expectEvents(expected: WatchEvent[], timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  const has = () => expected.every((e) => events.some((got) => JSON.stringify(got) === JSON.stringify(e)));
  while (!has() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 250));
  await watcher.idle();
  expect(events).toEqual(expect.arrayContaining(expected));
  expect(events).toHaveLength(expected.length);
  events = [];
}

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-watch-')));
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  await mkdir(p('子 文件夹'), { recursive: true });
  await writeFile(p('index.html'), '<p>一</p>\n');
  await writeFile(p('子 文件夹', '页面 二.html'), '<p>二</p>\n');
  await startWatching();
});

afterEach(async () => {
  watcher.close();
  await rm(tmp, { recursive: true, force: true });
});

/** A watcher whose OS events the test delivers itself (`raw`), to reproduce a delivery order deterministically. */
async function startScripted(options: { debounceMs: number; renameWaitMs?: number }) {
  watcher.close();
  let raw: (filename: string | null) => void = () => undefined;
  const watch: WatchFn = (_root, onChange) => {
    raw = onChange;
    return { on: () => undefined, close: () => undefined };
  };
  events = [];
  watcher = new ProjectWatcher(root, (batch) => events.push(...batch), { ...options, watch });
  await watcher.start();
  return (relPath: string) => raw(relPath.split('/').join(path.sep));
}

// Every test waits for the OS to deliver its events: up to 5 s per expectEvents call (FSEvents on a busy CI runner can
// be slow), and a test may make two such waits. The test timeout is above their sum so that a missing or wrong event
// fails expectEvents' own assertion, which lists what did arrive, instead of a bare timeout. Nothing here measures speed.
describe('file watcher (S07.3)', { timeout: 15_000 }, () => {
  it('reports a created file', async () => {
    await writeFile(p('新 文件.css'), 'h1 {}\n');
    await expectEvents([{ type: 'created', relPath: '新 文件.css' }]);
  });

  it('reports a changed file once per debounced burst', async () => {
    for (let i = 0; i < 5; i += 1) await appendFile(p('index.html'), `<p>${i}</p>\n`);
    await expectEvents([{ type: 'changed', relPath: 'index.html' }]);
  });

  it('reports a deleted file', async () => {
    await rm(p('子 文件夹', '页面 二.html'));
    await expectEvents([{ type: 'deleted', relPath: '子 文件夹/页面 二.html' }]);
  });

  it('a file created by another program and deleted right away ends up reported as deleted', async () => {
    // FSEvents (macOS) often delivers the creation late enough that the deletion lands in the same debounced
    // batch. Whether the two arrive together or apart, the last word on the path must be "deleted": the tree may
    // already list the file (reloaded for another event) and would otherwise keep a ghost row.
    await writeFile(p('外部 新建.js'), 'console.log(1);\n');
    await rm(p('外部 新建.js'));
    await expect.poll(() => events, { timeout: 5000 }).toContainEqual({ type: 'deleted', relPath: '外部 新建.js' });
    await new Promise((r) => setTimeout(r, 250));
    await watcher.idle();
    expect(events.at(-1)).toEqual({ type: 'deleted', relPath: '外部 新建.js' });
    expect(events.every((e) => e.type === 'created' || e.type === 'deleted')).toBe(true);
  });

  it('create, delete, create of the same file is reported as created, a later delete as deleted', async () => {
    await writeFile(p('外部 新建.js'), '1\n');
    await rm(p('外部 新建.js'));
    await writeFile(p('外部 新建.js'), '2\n');
    await expect.poll(() => events, { timeout: 5000 }).toContainEqual({ type: 'created', relPath: '外部 新建.js' });
    await new Promise((r) => setTimeout(r, 250));
    await watcher.idle();
    expect(events.at(-1)).toEqual({ type: 'created', relPath: '外部 新建.js' });
    events = [];
    await rm(p('外部 新建.js'));
    await expectEvents([{ type: 'deleted', relPath: '外部 新建.js' }]);
  });

  it('entries that came and went within one batch are reported as deleted, a folder once', async () => {
    watcher.close();
    let raw: (filename: string | null) => void = () => undefined;
    const watch: WatchFn = (_root, onChange) => {
      raw = onChange;
      return { on: () => undefined, close: () => undefined };
    };
    events = [];
    watcher = new ProjectWatcher(root, (batch) => events.push(...batch), { debounceMs: 20, watch });
    await watcher.start();
    // The OS reports each step, but all of them before the batch is classified.
    await writeFile(p('外部 新建.js'), '');
    raw('外部 新建.js');
    await rm(p('外部 新建.js'));
    raw('外部 新建.js');
    await mkdir(p('临时'));
    raw('临时');
    await writeFile(p('临时', 'a.js'), '');
    raw(path.join('临时', 'a.js'));
    await rm(p('临时'), { recursive: true });
    raw(path.join('临时', 'a.js'));
    raw('临时');
    await expect.poll(() => events.length).toBeGreaterThan(0);
    await watcher.idle();
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'deleted', relPath: '外部 新建.js' },
        { type: 'deleted', relPath: '临时' },
      ]),
    );
    expect(events).toHaveLength(2);
  });

  it('reports a rename in the same folder', async () => {
    await rename(p('index.html'), p('首页.html'));
    await expectEvents([{ type: 'renamed', from: 'index.html', to: '首页.html', caseOnly: false }]);
  });

  it('reports a case-only rename (also on case-insensitive volumes)', async () => {
    await rename(p('index.html'), p('Index.html'));
    await expectEvents([{ type: 'renamed', from: 'index.html', to: 'Index.html', caseOnly: true }]);
  });

  it('reports a move into another folder', async () => {
    await rename(p('index.html'), p('子 文件夹', 'index.html'));
    await expectEvents([{ type: 'renamed', from: 'index.html', to: '子 文件夹/index.html', caseOnly: false }]);
  });

  it('reports a folder rename once, and tracks the files inside it under the new name', async () => {
    await rename(p('子 文件夹'), p('pages'));
    await expectEvents([{ type: 'renamed', from: '子 文件夹', to: 'pages', caseOnly: false }]);
    await rm(p('pages', '页面 二.html'));
    await expectEvents([{ type: 'deleted', relPath: 'pages/页面 二.html' }]);
  });

  it('pairs the halves of a folder rename that arrive in different batches (FSEvents NoDefer on a busy machine)', async () => {
    const raw = await startScripted({ debounceMs: 20, renameWaitMs: 300 });
    await rename(p('子 文件夹'), p('pages'));
    raw('子 文件夹'); // delivered at once…
    await new Promise((r) => setTimeout(r, 120)); // …the new name only after more than one debounce
    await watcher.idle();
    expect(events).toEqual([]); // the deletion waits for its partner
    raw('pages');
    await expect.poll(() => events).toEqual([{ type: 'renamed', from: '子 文件夹', to: 'pages', caseOnly: false }]);
    // The files inside are tracked under the new name.
    events = [];
    await rm(p('pages', '页面 二.html'));
    raw('pages/页面 二.html');
    await expect.poll(() => events).toEqual([{ type: 'deleted', relPath: 'pages/页面 二.html' }]);
    await new Promise((r) => setTimeout(r, 400));
    await watcher.idle();
    expect(events).toHaveLength(1);
  });

  it('pairs a file move whose halves arrive in different batches', async () => {
    const raw = await startScripted({ debounceMs: 20, renameWaitMs: 300 });
    await rename(p('index.html'), p('子 文件夹', 'index.html'));
    raw('index.html');
    await new Promise((r) => setTimeout(r, 120));
    raw('子 文件夹/index.html');
    await expect
      .poll(() => events)
      .toEqual([{ type: 'renamed', from: 'index.html', to: '子 文件夹/index.html', caseOnly: false }]);
  });

  it('reports a deletion without a partner once its wait is over; a file back within the wait as deleted, then created', async () => {
    const raw = await startScripted({ debounceMs: 20, renameWaitMs: 150 });
    await rm(p('index.html'));
    raw('index.html');
    await new Promise((r) => setTimeout(r, 80));
    await watcher.idle();
    expect(events).toEqual([]);
    await expect.poll(() => events).toEqual([{ type: 'deleted', relPath: 'index.html' }]);
    await new Promise((r) => setTimeout(r, 300));
    await watcher.idle();
    expect(events).toHaveLength(1);
    // Deleted and restored within the wait (the IDE's own delete, then a restore from history): listeners may already
    // have dropped the entry, so it is reported as it happened — deleted, then created — not as a change.
    events = [];
    await rm(p('子 文件夹', '页面 二.html'));
    raw('子 文件夹/页面 二.html');
    await new Promise((r) => setTimeout(r, 60));
    await writeFile(p('子 文件夹', '页面 二.html'), '<p>新</p>\n');
    raw('子 文件夹/页面 二.html');
    await expect
      .poll(() => events)
      .toEqual([
        { type: 'deleted', relPath: '子 文件夹/页面 二.html' },
        { type: 'created', relPath: '子 文件夹/页面 二.html' },
      ]);
    await new Promise((r) => setTimeout(r, 300));
    await watcher.idle();
    expect(events).toHaveLength(2);
  });

  it('reports a new folder with files as the folder only, then later changes inside it', async () => {
    await mkdir(p('图片'));
    await writeFile(p('图片', 'a.svg'), '<svg/>');
    await expectEvents([{ type: 'created', relPath: '图片' }]);
    await appendFile(p('图片', 'a.svg'), '\n');
    await expectEvents([{ type: 'changed', relPath: '图片/a.svg' }]);
  });

  it('reports a deleted folder once', async () => {
    await rm(p('子 文件夹'), { recursive: true });
    await expectEvents([{ type: 'deleted', relPath: '子 文件夹' }]);
  });

  it('ignores node_modules, dotfiles and atomic-save temporaries; an atomic replace is a change', async () => {
    await mkdir(p('node_modules', 'x'), { recursive: true });
    await writeFile(p('node_modules', 'x', 'a.js'), '');
    await writeFile(p('.DS_Store'), '');
    const tmpFile = p('.index.html.123.noobide-tmp');
    await writeFile(tmpFile, '<p>新</p>\n');
    await rename(tmpFile, p('index.html'));
    await expectEvents([{ type: 'changed', relPath: 'index.html' }]);
  });

  it('ignores replays of changes made before the snapshot (FSEvents), but not real changes right after attaching', async () => {
    watcher.close();
    let raw: (filename: string | null) => void = () => undefined;
    const watch: WatchFn = (_root, onChange) => {
      raw = onChange;
      return { on: () => undefined, close: () => undefined };
    };
    // Files written just before the watcher starts, as when a project is opened right after it was created.
    // (S07.5: on Windows the file's ctime can read ~1 ms later than a Date.now() taken after the write, which made
    // this flaky; ProjectWatcher.predatesSnapshot tolerates that clock skew.)
    await writeFile(p('index.html'), '<p>旧</p>\n');
    events = [];
    watcher = new ProjectWatcher(root, (batch) => events.push(...batch), { debounceMs: 20, watch });
    await watcher.start();
    raw('index.html');
    raw(path.join('子 文件夹', '页面 二.html'));
    await new Promise((r) => setTimeout(r, 100));
    await watcher.idle();
    expect(events).toEqual([]);
    // A real change inside the replay window is still reported.
    await new Promise((r) => setTimeout(r, 5));
    await appendFile(p('index.html'), '<p>新</p>\n');
    raw('index.html');
    await expect.poll(() => events).toEqual([{ type: 'changed', relPath: 'index.html' }]);
  });

  it('stops reporting after close', async () => {
    watcher.close();
    await writeFile(p('late.html'), '');
    await new Promise((r) => setTimeout(r, 400));
    expect(events).toEqual([]);
  });
});

describe('bounded cost and recovery (review findings 5, 7, 11)', () => {
  it('a mass delete becomes one rescan and never blocks the main process for long', async () => {
    watcher.close();
    await mkdir(p('many'));
    await Promise.all(Array.from({ length: 3000 }, (_, i) => writeFile(p('many', `f${i}.txt`), '')));
    events = [];
    watcher = new ProjectWatcher(root, (batch) => events.push(...batch), { debounceMs: 80 });
    await watcher.start();
    expect(watcher.snapshotSize).toBeGreaterThan(3000);
    // FSEvents (macOS) replays the 3000 creations made just before the watch started; that batch is itself a mass
    // change (one rescan). Let it settle so the rescan checked below is the one caused by the deletes.
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
    expect(maxLag).toBeLessThan(500);
    expect(watcher.snapshotSize).toBeLessThan(10);
  }, 20000);

  it('releases its snapshot on close', async () => {
    expect(watcher.snapshotSize).toBeGreaterThan(0);
    watcher.close();
    expect(watcher.snapshotSize).toBe(0);
  });

  it('restarts with a growing delay after the OS watch fails or dies, and reports a rescan', async () => {
    watcher.close();
    let calls = 0;
    let failNext = true;
    const handlers: ((e: unknown) => void)[] = [];
    const watch: WatchFn = () => {
      calls += 1;
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' });
      }
      return {
        on: (_event: 'error', listener: (e: unknown) => void) => handlers.push(listener),
        close: () => undefined,
      };
    };
    events = [];
    watcher = new ProjectWatcher(root, (batch) => events.push(...batch), { watch, restartDelaysMs: [20, 40] });
    await watcher.start(); // the first attach throws: a restart is scheduled, start() still resolves
    await expect.poll(() => calls).toBe(2);
    await expect.poll(() => events).toContainEqual({ type: 'rescan' });
    events = [];
    handlers[0]?.(new Error('watch died'));
    expect(events).toEqual([{ type: 'rescan' }]);
    await expect.poll(() => calls).toBe(3);
  });
});
