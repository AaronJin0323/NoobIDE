import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectService } from '../../src/workspace/project-service';

/**
 * S08.2–S08.5 integration: create, rename/move, trash and reveal on the real file system, in a project path with
 * Chinese characters and spaces. Nothing may ever be overwritten (S08.4).
 */
let tmp: string;
let root: string;
let service: ProjectService;
let projectId: string;

const p = (...segments: string[]) => path.join(root, ...segments);

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-ops-')));
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  await mkdir(p('子 文件夹'), { recursive: true });
  await writeFile(p('index.html'), '<p>首页</p>\n');
  await writeFile(p('style.css'), 'h1 {}\n');
  await writeFile(p('子 文件夹', '页面 二.html'), '<p>二</p>\n');
  service = new ProjectService();
  const opened = await service.open(root);
  if (!opened.ok) throw new Error(opened.message);
  projectId = opened.value.projectId;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const create = (relPath: string, kind: 'file' | 'directory' = 'file') =>
  service.createEntry({ projectId, relPath, kind });
const move = (from: string, to: string) => service.renameEntry({ projectId, from, to });

describe('create (S08.2)', () => {
  it('creates an empty file and a folder with Chinese names and spaces', async () => {
    expect(await create('子 文件夹/新 页面.html')).toEqual({ ok: true, value: { relPath: '子 文件夹/新 页面.html' } });
    expect(await readFile(p('子 文件夹', '新 页面.html'), 'utf8')).toBe('');
    expect(await create('图片 素材', 'directory')).toMatchObject({ ok: true });
    expect((await stat(p('图片 素材'))).isDirectory()).toBe(true);
  });

  it.each([
    ['CON.html', 'reserved-windows'],
    ['aux', 'reserved-windows'],
    ['page.', 'trailing-dot-or-space'],
    ['what?.html', 'invalid-char'],
    ['a:b.css', 'invalid-char'],
    ['.env', 'starts-with-dot'],
  ])('explains the invalid name %j (Windows and macOS rules on every platform)', async (name, problem) => {
    const result = await create(name);
    expect(result).toMatchObject({ ok: false, code: 'invalid-name' });
    expect(!result.ok && result.message).toContain(problem);
    expect(await readdir(root)).toEqual(expect.not.arrayContaining([name]));
  });

  it('refuses to create inside a missing folder or outside the project', async () => {
    expect(await create('missing/a.html')).toMatchObject({ ok: false, code: 'not-found' });
    expect(await create('../outside.html')).toMatchObject({ ok: false, code: 'outside-project' });
  });
});

describe('never silently overwrite (S08.4)', () => {
  it('creating onto an existing file or folder is refused and changes nothing', async () => {
    expect(await create('index.html')).toMatchObject({ ok: false, code: 'exists', message: 'index.html' });
    expect(await readFile(p('index.html'), 'utf8')).toBe('<p>首页</p>\n');
    expect(await create('子 文件夹', 'directory')).toMatchObject({ ok: false, code: 'exists' });
    expect(await create('子 文件夹')).toMatchObject({ ok: false, code: 'exists' });
    expect(await readdir(p('子 文件夹'))).toEqual(['页面 二.html']);
  });

  it('a name that differs only in case is a conflict, explained with the existing name', async () => {
    expect(await create('Index.html')).toMatchObject({ ok: false, code: 'case-conflict', message: 'index.html' });
    expect(await create('STYLE.CSS', 'directory')).toMatchObject({ ok: false, code: 'case-conflict' });
    expect(await readFile(p('index.html'), 'utf8')).toBe('<p>首页</p>\n');
  });

  it('renaming onto an existing file is refused and both files stay unchanged', async () => {
    expect(await move('style.css', 'index.html')).toMatchObject({ ok: false, code: 'exists' });
    expect(await readFile(p('index.html'), 'utf8')).toBe('<p>首页</p>\n');
    expect(await readFile(p('style.css'), 'utf8')).toBe('h1 {}\n');
  });

  it('moving onto an existing file in another folder is refused', async () => {
    await writeFile(p('页面 二.html'), '<p>另一个</p>\n');
    expect(await move('页面 二.html', '子 文件夹/页面 二.html')).toMatchObject({ ok: false, code: 'exists' });
    expect(await readFile(p('子 文件夹', '页面 二.html'), 'utf8')).toBe('<p>二</p>\n');
    expect(await readFile(p('页面 二.html'), 'utf8')).toBe('<p>另一个</p>\n');
  });

  it('renaming onto a name that differs only in case from another file is refused', async () => {
    expect(await move('style.css', 'INDEX.html')).toMatchObject({ ok: false, code: 'case-conflict' });
    expect(await readFile(p('index.html'), 'utf8')).toBe('<p>首页</p>\n');
  });

  it('moving a folder onto an existing folder is refused (never merged)', async () => {
    await mkdir(p('other'));
    await mkdir(p('子 文件夹', 'other'));
    await writeFile(p('子 文件夹', 'other', 'keep.txt'), 'keep');
    expect(await move('other', '子 文件夹/other')).toMatchObject({ ok: false, code: 'exists' });
    expect(await readdir(p('子 文件夹', 'other'))).toEqual(['keep.txt']);
  });
});

describe('rename and move (S08.2)', () => {
  it('renames a file and keeps its content', async () => {
    expect(await move('index.html', '首页.html')).toEqual({ ok: true, value: { from: 'index.html', to: '首页.html' } });
    expect(await readFile(p('首页.html'), 'utf8')).toBe('<p>首页</p>\n');
    expect((await readdir(root)).includes('index.html')).toBe(false);
  });

  it('moves a folder with its contents', async () => {
    await mkdir(p('pages'));
    expect(await move('子 文件夹', 'pages/子 文件夹')).toMatchObject({ ok: true });
    expect(await readFile(p('pages', '子 文件夹', '页面 二.html'), 'utf8')).toBe('<p>二</p>\n');
  });

  it('a case-only rename works (also on case-insensitive volumes) and keeps the content', async () => {
    expect(await move('index.html', 'Index.html')).toMatchObject({ ok: true });
    const names = await readdir(root);
    expect(names).toContain('Index.html');
    expect(names).not.toContain('index.html');
    expect(names.filter((n) => n.includes('noobide-rename'))).toEqual([]);
    expect(await readFile(p('Index.html'), 'utf8')).toBe('<p>首页</p>\n');
  });

  it('a case-only rename of a folder works', async () => {
    await mkdir(p('css'));
    await writeFile(p('css', 'a.css'), 'a');
    expect(await move('css', 'CSS')).toMatchObject({ ok: true });
    expect(await readdir(root)).toContain('CSS');
    expect(await readFile(p('CSS', 'a.css'), 'utf8')).toBe('a');
  });

  it('explains invalid new names, folders moved into themselves and missing sources', async () => {
    expect(await move('index.html', 'index.html ')).toMatchObject({ ok: false, code: 'invalid-name' });
    expect(await move('index.html', 'nul.html')).toMatchObject({ ok: false, code: 'invalid-name' });
    expect(await move('子 文件夹', '子 文件夹/inner')).toMatchObject({ ok: false, code: 'into-itself' });
    expect(await move('gone.html', 'x.html')).toMatchObject({ ok: false, code: 'not-found' });
    expect(await readFile(p('index.html'), 'utf8')).toBe('<p>首页</p>\n');
  });

  it('renames a link itself, never its target', async () => {
    const outside = path.join(tmp, 'outside');
    await mkdir(outside);
    await symlink(outside, p('jump'), 'junction');
    expect(await move('jump', 'jump2')).toMatchObject({ ok: true });
    expect((await stat(outside)).isDirectory()).toBe(true);
    expect(await readdir(tmp)).toContain('outside');
  });
});

describe('delete to the OS trash (S08.3)', () => {
  it('hands the exact path to the trash and nothing else', async () => {
    const trashItem = vi.fn(async (_full: string) => undefined);
    expect(await service.trashEntry({ projectId, relPath: '子 文件夹/页面 二.html' }, trashItem)).toEqual({
      ok: true,
      value: null,
    });
    expect(trashItem).toHaveBeenCalledWith(p('子 文件夹', '页面 二.html'));
  });

  it('explains a trash failure and leaves the file in place', async () => {
    const trashItem = vi.fn(async () => {
      throw new Error('The process cannot access the file because it is being used by another process.');
    });
    expect(await service.trashEntry({ projectId, relPath: 'index.html' }, trashItem)).toMatchObject({
      ok: false,
      code: 'trash-failed',
      message: expect.stringContaining('another process'),
    });
    expect(await readFile(p('index.html'), 'utf8')).toBe('<p>首页</p>\n');
  });

  it('trashes a link itself, not the folder it points to', async () => {
    const outside = path.join(tmp, 'outside');
    await mkdir(outside);
    await symlink(outside, p('jump'), 'junction');
    const trashItem = vi.fn(async (_full: string) => undefined);
    expect(await service.trashEntry({ projectId, relPath: 'jump' }, trashItem)).toMatchObject({ ok: true });
    expect(trashItem).toHaveBeenCalledWith(p('jump'));
  });

  it('snapshots into local history (S21) before trashing, but never through a link', async () => {
    const beforeDelete = vi.fn(async (_root: string, _rel: string, _abs: string) => undefined);
    const withHistory = new ProjectService({
      history: { captureBeforeSave: async () => null, recordSave: () => undefined, beforeDelete },
    });
    const opened = await withHistory.open(root);
    if (!opened.ok) throw new Error(opened.message);
    const order: string[] = [];
    beforeDelete.mockImplementation(async () => void order.push('history'));
    const trashItem = vi.fn(async (_full: string) => void order.push('trash'));
    const id = opened.value.projectId;
    expect(await withHistory.trashEntry({ projectId: id, relPath: '子 文件夹' }, trashItem)).toMatchObject({
      ok: true,
    });
    expect(beforeDelete).toHaveBeenCalledWith(root, '子 文件夹', p('子 文件夹'));
    expect(order).toEqual(['history', 'trash']);

    const outside = path.join(tmp, 'outside');
    await mkdir(outside);
    await symlink(outside, p('jump'), 'junction');
    beforeDelete.mockClear();
    expect(await withHistory.trashEntry({ projectId: id, relPath: 'jump' }, trashItem)).toMatchObject({ ok: true });
    expect(beforeDelete).not.toHaveBeenCalled();
  });

  it('a failing history snapshot never blocks the move to the trash', async () => {
    const withHistory = new ProjectService({
      history: {
        captureBeforeSave: async () => null,
        recordSave: () => undefined,
        beforeDelete: async () => {
          throw new Error('disk full');
        },
      },
    });
    const opened = await withHistory.open(root);
    if (!opened.ok) throw new Error(opened.message);
    const trashItem = vi.fn(async (_full: string) => undefined);
    expect(
      await withHistory.trashEntry({ projectId: opened.value.projectId, relPath: 'index.html' }, trashItem),
    ).toMatchObject({ ok: true });
    expect(trashItem).toHaveBeenCalledWith(p('index.html'));
  });

  it('refuses missing entries and anything outside the project', async () => {
    const trashItem = vi.fn(async () => undefined);
    expect(await service.trashEntry({ projectId, relPath: 'gone.html' }, trashItem)).toMatchObject({
      ok: false,
      code: 'not-found',
    });
    expect(await service.trashEntry({ projectId, relPath: '../网页 练习' }, trashItem)).toMatchObject({
      ok: false,
      code: 'outside-project',
    });
    expect(trashItem).not.toHaveBeenCalled();
  });
});

describe('reveal (S08.5)', () => {
  it('resolves the root, files and folders inside the project only', async () => {
    expect(await service.revealPath({ projectId, relPath: '' })).toEqual({ ok: true, value: root });
    expect(await service.revealPath({ projectId, relPath: '子 文件夹/页面 二.html' })).toEqual({
      ok: true,
      value: p('子 文件夹', '页面 二.html'),
    });
    expect(await service.revealPath({ projectId, relPath: 'gone' })).toMatchObject({ ok: false, code: 'not-found' });
    expect(await service.revealPath({ projectId, relPath: '..' })).toMatchObject({
      ok: false,
      code: 'outside-project',
    });
  });
});
