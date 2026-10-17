import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectService } from '../../src/workspace/project-service';
import { MAX_DIR_ENTRIES } from '../../src/workspace/tree';

/** S07.2: one level of the lazy tree, on the real file system, in a path with Chinese characters and spaces. */
let tmp: string;
let root: string;
let service: ProjectService;
let projectId: string;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-tree-')));
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  await mkdir(root, { recursive: true });
  service = new ProjectService();
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function open() {
  const opened = await service.open(root);
  if (!opened.ok) throw new Error(opened.message);
  projectId = opened.value.projectId;
}

async function list(relPath: string) {
  const result = await service.listDir({ projectId, relPath });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.value;
}

describe('lazy directory listing (S07.2)', () => {
  it('lists one level, folders first, in natural order', async () => {
    for (const name of ['page10.html', 'page2.html', 'B.css', 'a.js', '页面.html']) {
      await writeFile(path.join(root, name), '');
    }
    for (const name of ['图片', 'css', 'Zeta']) await mkdir(path.join(root, name));
    await writeFile(path.join(root, 'css', 'deep.css'), '');
    await open();
    const listing = await list('');
    expect(listing.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'directory:css',
      'directory:Zeta',
      'directory:图片',
      'file:a.js',
      'file:B.css',
      'file:page2.html',
      'file:page10.html',
      'file:页面.html',
    ]);
    // Lazy: the nested file is not part of the root listing.
    expect(listing.entries.some((e) => e.name === 'deep.css')).toBe(false);
    expect(listing.truncated).toBe(false);
    expect((await list('css')).entries).toEqual([
      { name: 'deep.css', relPath: 'css/deep.css', kind: 'file', isLink: false },
    ]);
  });

  it('applies the ignore list', async () => {
    for (const name of ['node_modules', '.git', '.noobide']) await mkdir(path.join(root, name));
    for (const name of ['.DS_Store', 'Thumbs.db', 'desktop.ini', '.index.html.1234.noobide-tmp', 'index.html']) {
      await writeFile(path.join(root, name), '');
    }
    await open();
    expect((await list('')).entries.map((e) => e.name)).toEqual(['index.html']);
  });

  it('keeps names exactly as on disk (case, spaces, Chinese)', async () => {
    await mkdir(path.join(root, '子 文件夹'));
    await writeFile(path.join(root, '子 文件夹', 'Index.HTML'), '');
    await open();
    expect((await list('子 文件夹')).entries).toEqual([
      { name: 'Index.HTML', relPath: '子 文件夹/Index.HTML', kind: 'file', isLink: false },
    ]);
  });

  it('reports missing folders, files and unknown projects', async () => {
    await writeFile(path.join(root, 'a.html'), '');
    await open();
    expect(await service.listDir({ projectId, relPath: 'nope' })).toMatchObject({ ok: false, code: 'not-found' });
    expect(await service.listDir({ projectId, relPath: 'a.html' })).toMatchObject({
      ok: false,
      code: 'not-a-directory',
    });
    expect(await service.listDir({ projectId: '00000000-0000-4000-8000-000000000000', relPath: '' })).toMatchObject({
      ok: false,
      code: 'unknown-project',
    });
  });

  // Writes MAX_DIR_ENTRIES + 1 files on the real disk: well under a second here, but past vitest's 5 s default on a
  // hosted Windows runner with the CPU saturated (PR #14 CI). The timeout is only a hang guard; the assertions are unchanged.
  it('stops at the per-folder limit and says so', { timeout: 60_000 }, async () => {
    const big = path.join(root, 'big');
    await mkdir(big);
    await Promise.all(Array.from({ length: MAX_DIR_ENTRIES + 1 }, (_, i) => writeFile(path.join(big, `f${i}`), '')));
    await open();
    const listing = await list('big');
    expect(listing.entries).toHaveLength(MAX_DIR_ENTRIES);
    expect(listing.truncated).toBe(true);
  });
});

describe('symbolic links and junctions (S07.2)', () => {
  it('marks a junction that leads outside the project and never lists through it', async () => {
    const outside = path.join(tmp, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(outside, path.join(root, 'jump'), 'junction'); // works without admin rights on Windows
    await open();
    expect((await list('')).entries).toEqual([{ name: 'jump', relPath: 'jump', kind: 'link-outside', isLink: true }]);
    expect(await service.listDir({ projectId, relPath: 'jump' })).toMatchObject({
      ok: false,
      code: 'outside-project',
    });
  });

  it('treats a junction to a folder inside the project like that folder, marked as a link', async () => {
    await mkdir(path.join(root, 'real'));
    await writeFile(path.join(root, 'real', 'a.html'), '');
    await symlink(path.join(root, 'real'), path.join(root, 'alias'), 'junction');
    await open();
    expect((await list('')).entries).toEqual([
      { name: 'alias', relPath: 'alias', kind: 'directory', isLink: true },
      { name: 'real', relPath: 'real', kind: 'directory', isLink: false },
    ]);
    expect((await list('alias')).entries.map((e) => e.relPath)).toEqual(['alias/a.html']);
  });

  it('marks a broken link', async () => {
    await symlink(path.join(tmp, 'gone'), path.join(root, 'dangling'), 'junction');
    await open();
    expect((await list('')).entries).toEqual([
      { name: 'dangling', relPath: 'dangling', kind: 'link-broken', isLink: true },
    ]);
  });

  it('marks a file symlink that leads outside the project', async (ctx) => {
    await writeFile(path.join(tmp, 'secret.txt'), 'secret');
    try {
      await symlink(path.join(tmp, 'secret.txt'), path.join(root, 'link.txt'), 'file');
    } catch {
      ctx.skip(); // File symlinks on Windows need Developer Mode or admin rights.
    }
    await open();
    expect((await list('')).entries).toEqual([
      { name: 'link.txt', relPath: 'link.txt', kind: 'link-outside', isLink: true },
    ]);
  });
});
