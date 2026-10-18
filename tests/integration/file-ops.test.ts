import { mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_IO, removeTempDir } from './real-io';
import { ProjectService } from '../../src/workspace/project-service';
import { RENAME_TEMP_PREFIX, renameEntry, resolveEntry, type FileOpsFs } from '../../src/workspace/file-ops';
import { link, lstat, readdir as fsReaddir, rename as fsRename, unlink } from 'node:fs/promises';
import { isIgnoredName } from '../../src/workspace/ignore';

/** The real file system with selected calls replaced (review: failures between the steps of an operation). */
function fsWith(overrides: Partial<FileOpsFs>): FileOpsFs {
  return {
    rename: fsRename,
    link,
    unlink,
    readdir: (dir) => fsReaddir(dir),
    lstat: (p) => lstat(p),
    ...overrides,
  };
}
const fsError = (code: string) => Object.assign(new Error(code), { code });

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
}, REAL_IO.timeout);

afterEach(async () => {
  await removeTempDir(tmp);
}, REAL_IO.timeout);

const create = (relPath: string, kind: 'file' | 'directory' = 'file') =>
  service.createEntry({ projectId, relPath, kind });
const move = (from: string, to: string) => service.renameEntry({ projectId, from, to });

describe('create (S08.2)', REAL_IO, () => {
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

describe('never silently overwrite (S08.4)', REAL_IO, () => {
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

describe('rename and move (S08.2)', REAL_IO, () => {
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

describe('delete to the OS trash (S08.3)', REAL_IO, () => {
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

describe('review findings (S08.2, S08.4)', REAL_IO, () => {
  it('a case-only rename that must hop and cannot finish is rolled back and explained (finding 2)', async () => {
    let renames = 0;
    const fs = fsWith({
      rename: async (from, to) => {
        renames += 1;
        if (renames === 1) return; // the volume "keeps the old spelling": forces the temporary hop
        if (renames === 3) throw fsError('EBUSY'); // e.g. antivirus holds the file between the two hops
        await fsRename(from, to);
      },
    });
    expect(await renameEntry(root, 'index.html', 'Index.html', fs)).toMatchObject({ ok: false, code: 'busy' });
    const names = await readdir(root);
    expect(names).toContain('index.html'); // back under its old name
    expect(names.some((n) => n.startsWith(RENAME_TEMP_PREFIX))).toBe(false);
    expect(await readFile(p('index.html'), 'utf8')).toBe('<p>首页</p>\n');
  });

  it('if the rollback fails too, the visible temporary name is reported (finding 2)', async () => {
    let renames = 0;
    const fs = fsWith({
      rename: async (from, to) => {
        renames += 1;
        if (renames === 1) return;
        if (renames >= 3) throw fsError('EPERM');
        await fsRename(from, to);
      },
    });
    const result = await renameEntry(root, 'index.html', 'Index.html', fs);
    expect(result).toMatchObject({ ok: false, code: 'interrupted' });
    const tempName = !result.ok ? result.message : '';
    expect(tempName.startsWith(RENAME_TEMP_PREFIX)).toBe(true);
    expect(isIgnoredName(tempName)).toBe(false); // shown in the tree, findable in Explorer/Finder
    expect(await readFile(p(tempName), 'utf8')).toBe('<p>首页</p>\n');
  });

  it('a case-only rename that hops succeeds and leaves no temporary name', async () => {
    let renames = 0;
    const fs = fsWith({
      rename: async (from, to) => {
        renames += 1;
        if (renames === 1) return;
        await fsRename(from, to);
      },
    });
    expect(await renameEntry(root, 'index.html', 'Index.html', fs)).toMatchObject({ ok: true });
    const names = await readdir(root);
    expect(names).toContain('Index.html');
    expect(names.some((n) => n.startsWith(RENAME_TEMP_PREFIX))).toBe(false);
  });

  it('an exact-name sibling is always a conflict, even if it reports the same inode (finding 3)', async () => {
    // A case-sensitive network share listing both spellings; inode numbers play no part any more.
    const rename = vi.fn(fsRename);
    const fs = fsWith({
      rename,
      readdir: async (dir) => {
        const names = await fsReaddir(dir);
        return dir === root ? [...names, 'Index.html'] : names;
      },
    });
    expect(await renameEntry(root, 'index.html', 'Index.html', fs)).toMatchObject({ ok: false, code: 'exists' });
    expect(rename).not.toHaveBeenCalled();
  });

  it('a file move refuses a target that appears after the check, atomically (finding 4)', async () => {
    await writeFile(p('子 文件夹', 'style.css'), 'keep me');
    // The existence check does not see the target (as if it was created a moment later).
    const fs = fsWith({
      readdir: async (dir) => (await fsReaddir(dir)).filter((n) => n !== 'style.css' || dir === root),
    });
    expect(await renameEntry(root, 'style.css', '子 文件夹/style.css', fs)).toMatchObject({
      ok: false,
      code: 'exists',
    });
    expect(await readFile(p('子 文件夹', 'style.css'), 'utf8')).toBe('keep me');
    expect(await readFile(p('style.css'), 'utf8')).toBe('h1 {}\n');
  });

  it('falls back to rename where hard links are not supported (finding 4)', async () => {
    const fs = fsWith({
      link: async () => {
        throw fsError('ENOTSUP');
      },
    });
    expect(await renameEntry(root, 'style.css', '子 文件夹/style.css', fs)).toMatchObject({ ok: true });
    expect(await readFile(p('子 文件夹', 'style.css'), 'utf8')).toBe('h1 {}\n');
    expect((await readdir(root)).includes('style.css')).toBe(false);
  });

  it('a file move keeps one name if removing the old one fails', async () => {
    const fs = fsWith({
      unlink: async (target) => {
        if (target === p('style.css')) throw fsError('EBUSY');
        await unlink(target);
      },
    });
    expect(await renameEntry(root, 'style.css', '子 文件夹/style.css', fs)).toMatchObject({
      ok: false,
      code: 'busy',
    });
    expect(await readdir(p('子 文件夹'))).toEqual(['页面 二.html']);
    expect(await readFile(p('style.css'), 'utf8')).toBe('h1 {}\n');
  });

  it('a folder cannot be moved into itself through another spelling or a junction (finding 8)', async () => {
    await mkdir(p('sub', 'inner'), { recursive: true });
    expect(await move('sub', 'SUB/inner/sub')).toMatchObject({ ok: false, code: 'into-itself' });
    await symlink(p('sub'), p('jump'), 'junction');
    expect(await move('sub', 'jump/inner/sub')).toMatchObject({ ok: false, code: 'into-itself' });
    expect((await stat(p('sub', 'inner'))).isDirectory()).toBe(true);
  });

  it('non-portable names are listed with a flag and can be renamed and trashed, nothing else (finding 9)', async () => {
    // Node on Windows uses namespaced paths, so these names (as from a zip or a Mac) can exist.
    await writeFile(p('page.'), 'trailing dot');
    await writeFile(p('CON'), 'device name');
    const listing = await service.listDir({ projectId, relPath: '' });
    const flagged = listing.ok ? listing.value.entries.filter((e) => e.unportable).map((e) => e.name) : [];
    expect(flagged.sort()).toEqual(['CON', 'page.']);
    expect(await service.read({ projectId, relPath: 'page.' })).toMatchObject({ ok: false });
    expect(await move('page.', 'page.html')).toMatchObject({ ok: true });
    expect(await readFile(p('page.html'), 'utf8')).toBe('trailing dot');
    const trashItem = vi.fn(async (_full: string) => undefined);
    expect(await service.trashEntry({ projectId, relPath: 'CON' }, trashItem)).toMatchObject({ ok: true });
    expect(trashItem).toHaveBeenCalledWith(p('CON'));
  });

  it('an entry is resolved only by a name its folder really lists (no NTFS streams or aliases)', async () => {
    expect(await resolveEntry(root, 'index.html:hid')).toMatchObject({ ok: false, code: 'not-found' });
    expect(await resolveEntry(root, 'INDEX.HTML')).toMatchObject({ ok: false, code: 'not-found' });
    expect(await resolveEntry(root, 'a\\..\\..\\x')).toMatchObject({ ok: false });
    expect(await resolveEntry(root, 'index.html')).toEqual({ ok: true, value: p('index.html') });
  });
});

describe('reveal (S08.5)', REAL_IO, () => {
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
