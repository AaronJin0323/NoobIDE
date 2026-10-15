import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore, decideRestore } from '../../src/main/session-store';

/** S13.4: session state in app data (path with Chinese characters and spaces); crash recovery takes precedence. */
let tmp: string;
let file: string;
let project: string;
const layout = { filesOpen: false, problemsOpen: true, filesWidth: 320, editorShare: 0.65 };

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-session-'));
  file = path.join(tmp, '应用 数据', 'session.json');
  project = path.join(tmp, '网页 练习', '中文 路径 项目');
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('session store (S13.4)', () => {
  it('remembers the last project, its tabs and the layout across runs', async () => {
    const store = new SessionStore({ file });
    await store.projectOpened(project);
    await store.saveTabs(project, { tabs: ['index.html', '子 文件夹/页面 二.html'], active: '子 文件夹/页面 二.html' });
    await store.saveLayout(layout);
    const again = new SessionStore({ file });
    expect(await again.lastProject()).toBe(project);
    expect(await again.tabsOf(project)).toEqual({
      tabs: ['index.html', '子 文件夹/页面 二.html'],
      active: '子 文件夹/页面 二.html',
    });
    expect(await again.layout()).toEqual(layout);
    // Nothing is written into the project folder.
    expect(await readdir(project)).toEqual([]);
  });

  it('closing the project clears the last project but keeps its tabs for next time', async () => {
    const store = new SessionStore({ file });
    await store.projectOpened(project);
    await store.saveTabs(project, { tabs: ['index.html'], active: 'index.html' });
    await store.projectClosed(project);
    expect(await store.lastProject()).toBeNull();
    expect(await store.tabsOf(project)).toEqual({ tabs: ['index.html'], active: 'index.html' });
  });

  it('a corrupt file is backed up; invalid parts are dropped', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'not json');
    expect(await new SessionStore({ file }).lastProject()).toBeNull();
    expect((await readdir(path.dirname(file))).some((n) => n.startsWith('session.corrupt-'))).toBe(true);
    await writeFile(
      file,
      JSON.stringify({ version: 1, lastProject: 'relative', layout: { ...layout, filesWidth: 9999 }, projects: {} }),
    );
    const store = new SessionStore({ file });
    expect(await store.lastProject()).toBeNull();
    expect(await store.layout()).toBeNull();
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1);
  });
});

describe('restore decision (S13.4)', () => {
  const exists = async () => true;
  it('reopens the last project on a normal start', async () => {
    expect(
      await decideRestore({ enabled: true, pendingRecovery: 0, lastProject: project, isDirectory: exists }),
    ).toEqual({ kind: 'open', rootPath: project });
  });
  it('crash recovery takes precedence over session restore', async () => {
    expect(
      await decideRestore({ enabled: true, pendingRecovery: 1, lastProject: project, isDirectory: exists }),
    ).toEqual({ kind: 'skip', reason: 'recovery-pending' });
  });
  it('respects the setting, an empty session and a folder that is gone', async () => {
    expect(await decideRestore({ enabled: false, pendingRecovery: 0, lastProject: project })).toEqual({
      kind: 'skip',
      reason: 'disabled',
    });
    expect(await decideRestore({ enabled: true, pendingRecovery: 0, lastProject: null })).toEqual({
      kind: 'skip',
      reason: 'none',
    });
    expect(await decideRestore({ enabled: true, pendingRecovery: 0, lastProject: path.join(tmp, 'gone') })).toEqual({
      kind: 'skip',
      reason: 'missing',
    });
  });

  it('flush resolves only once writes that were not awaited are on disk (quit drains the session)', async () => {
    const store = new SessionStore({ file });
    void store.projectOpened(project);
    void store.saveTabs(project, { tabs: ['index.html'], active: 'index.html' });
    await store.flush();
    expect(await new SessionStore({ file }).tabsOf(project)).toEqual({ tabs: ['index.html'], active: 'index.html' });
  });
});
