import { appendFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WatchEvent } from '../../src/shared/ipc/contract';
import { ProjectWatcher } from '../../src/workspace/watcher';

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

describe('file watcher (S07.3)', () => {
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

  it('stops reporting after close', async () => {
    watcher.close();
    await writeFile(p('late.html'), '');
    await new Promise((r) => setTimeout(r, 400));
    expect(events).toEqual([]);
  });
});
