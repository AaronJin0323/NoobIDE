import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectService } from '../../src/workspace/project-service';
import { COPY_LIMITS, copyEntry, copyFileExclusive, realCopyFs, type CopyFs } from '../../src/workspace/file-ops';
import { parseCopyEntriesRequest } from '../../src/shared/ipc/file-ops-contract';

/**
 * S52.2 integration + fault tests: copy/paste and Duplicate on the real file system, in a project path with Chinese
 * characters and spaces. Copies are byte-identical and recursive, nothing is ever overwritten, and a copy that fails
 * half-way removes only what it created and reports the cause.
 */
let tmp: string;
let root: string;
let service: ProjectService;
let projectId: string;

const p = (...segments: string[]) => path.join(root, ...segments);
const fsError = (code: string) => Object.assign(new Error(code), { code });
/** Bytes that a text round-trip would change: a BOM, CRLF, a lone CR, invalid UTF-8 and NUL. */
const BINARY = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x0d, 0xff, 0xfe, 0x00, 0x89, 0x50, 0x4e, 0x47]);

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-copy-')));
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  await mkdir(p('图片 素材', '小 图'), { recursive: true });
  await mkdir(p('目标 文件夹'));
  await writeFile(p('页面 二.html'), '<p>二</p>\r\n');
  await writeFile(p('图片 素材', '标志 图.png'), BINARY);
  await writeFile(p('图片 素材', '小 图', '一.txt'), '一\n');
  await writeFile(p('图片 素材', '小 图', '二.txt'), '二\n');
  service = new ProjectService();
  const opened = await service.open(root);
  if (!opened.ok) throw new Error(opened.message);
  projectId = opened.value.projectId;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const paste = (from: string[], toFolder: string) => service.copyEntries({ projectId, from, toFolder, mode: 'paste' });
const duplicate = (from: string[]) => service.copyEntries({ projectId, from, toFolder: '', mode: 'duplicate' });

describe('duplicate (S52.2)', () => {
  it('duplicates a file next to itself as "name copy.ext", then "name copy 2.ext"', async () => {
    expect(await duplicate(['页面 二.html'])).toEqual({
      ok: true,
      value: { copied: [{ from: '页面 二.html', to: '页面 二 copy.html', skippedLinks: 0 }], failed: [] },
    });
    expect(await duplicate(['页面 二.html'])).toMatchObject({ value: { copied: [{ to: '页面 二 copy 2.html' }] } });
    expect(await readFile(p('页面 二 copy 2.html'))).toEqual(await readFile(p('页面 二.html')));
    expect(await readFile(p('页面 二.html'), 'utf8')).toBe('<p>二</p>\r\n');
  });

  it('duplicates a folder recursively with byte-identical files', async () => {
    expect(await duplicate(['图片 素材'])).toMatchObject({ value: { copied: [{ to: '图片 素材 copy' }] } });
    expect(await readFile(p('图片 素材 copy', '标志 图.png'))).toEqual(BINARY);
    expect((await readdir(p('图片 素材 copy', '小 图'))).sort()).toEqual(['一.txt', '二.txt']);
    expect(await readFile(p('图片 素材 copy', '小 图', '二.txt'), 'utf8')).toBe('二\n');
  });

  it('never takes a name that exists, also one that differs only in case', async () => {
    await writeFile(p('页面 二 COPY.html'), 'keep');
    expect(await duplicate(['页面 二.html'])).toMatchObject({ value: { copied: [{ to: '页面 二 copy 2.html' }] } });
    expect(await readFile(p('页面 二 COPY.html'), 'utf8')).toBe('keep');
  });
});

describe('copy and paste (S52.2)', () => {
  it('pastes into another folder under the same name', async () => {
    expect(await paste(['页面 二.html', '图片 素材'], '目标 文件夹')).toMatchObject({
      ok: true,
      value: {
        copied: [
          { from: '页面 二.html', to: '目标 文件夹/页面 二.html' },
          { from: '图片 素材', to: '目标 文件夹/图片 素材' },
        ],
        failed: [],
      },
    });
    expect(await readFile(p('目标 文件夹', '图片 素材', '标志 图.png'))).toEqual(BINARY);
    expect(await readFile(p('页面 二.html'), 'utf8')).toBe('<p>二</p>\r\n'); // the original stays
  });

  it('a paste where the name is taken gets a copy name; the existing file is untouched', async () => {
    await writeFile(p('目标 文件夹', '页面 二.html'), 'existing');
    expect(await paste(['页面 二.html'], '目标 文件夹')).toMatchObject({
      value: { copied: [{ to: '目标 文件夹/页面 二 copy.html' }] },
    });
    expect(await readFile(p('目标 文件夹', '页面 二.html'), 'utf8')).toBe('existing');
    expect(await readFile(p('目标 文件夹', '页面 二 copy.html'), 'utf8')).toBe('<p>二</p>\r\n');
  });

  it('pasting into the same folder makes a copy, like Duplicate', async () => {
    expect(await paste(['页面 二.html'], '')).toMatchObject({ value: { copied: [{ to: '页面 二 copy.html' }] } });
  });

  it('a folder cannot be pasted into itself or a folder below it', async () => {
    expect(await paste(['图片 素材'], '图片 素材/小 图')).toMatchObject({
      value: { copied: [], failed: [{ relPath: '图片 素材', code: 'into-itself' }] },
    });
    expect(await readdir(p('图片 素材', '小 图'))).toHaveLength(2);
  });

  it('the destination must be a folder inside the project (realpath-checked)', async () => {
    const outside = path.join(tmp, '外面');
    await mkdir(outside);
    await symlink(outside, p('外链'), 'junction');
    expect(await paste(['页面 二.html'], '外链')).toMatchObject({ value: { failed: [{ code: 'outside-project' }] } });
    expect(await readdir(outside)).toEqual([]);
    expect(await paste(['页面 二.html'], '页面 二.html')).toMatchObject({
      value: { failed: [{ code: 'not-a-folder' }] },
    });
  });

  it('links are never followed: a link is not copied, links inside a folder are left out and counted', async () => {
    const outside = path.join(tmp, '外面 秘密');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(outside, p('图片 素材', '外链'), 'junction');
    expect(await paste(['图片 素材/外链'], '目标 文件夹')).toMatchObject({
      value: { failed: [{ code: 'op-failed' }] },
    });
    expect(await duplicate(['图片 素材'])).toMatchObject({ value: { copied: [{ skippedLinks: 1 }] } });
    expect(await readdir(p('图片 素材 copy'))).not.toContain('外链');
  });

  it('refuses malformed requests', () => {
    const ok = { projectId, from: ['页面 二.html'], toFolder: '', mode: 'paste' };
    expect(parseCopyEntriesRequest(ok)).toEqual(ok);
    expect(parseCopyEntriesRequest({ ...ok, mode: 'move' })).toBeNull();
    expect(parseCopyEntriesRequest({ ...ok, mode: 'duplicate', toFolder: 'x' })).toBeNull();
    expect(parseCopyEntriesRequest({ ...ok, toFolder: '../x' })).toBeNull();
    expect(parseCopyEntriesRequest({ ...ok, from: ['C:/Windows'] })).toBeNull();
  });
});

describe('a copy that fails half-way (S52.2 fault tests)', () => {
  /** The real file system, failing the copy of the n-th file. */
  const failingAt = (n: number, code: string, partial = false): CopyFs => {
    let files = 0;
    return {
      ...realCopyFs,
      copyFile: async (from, to) => {
        files += 1;
        if (files === n) {
          // The real exclusive copy failing after it created the target (a read error mid-stream): the source is
          // a folder, so reading it fails once the target exists. That half-made target must not stay.
          if (partial) await copyFileExclusive(path.dirname(from), to);
          throw fsError(code);
        }
        await realCopyFs.copyFile(from, to);
      },
    };
  };

  it('removes exactly what it created and reports the cause (disk full on the third file)', async () => {
    const before = (await readdir(root)).sort();
    const result = await copyEntry(root, '图片 素材', '', 'duplicate', failingAt(3, 'ENOSPC', true));
    expect(result).toMatchObject({ ok: false, code: 'op-failed' });
    expect((await readdir(root)).sort()).toEqual(before);
    expect(await readFile(p('图片 素材', '标志 图.png'))).toEqual(BINARY); // the original is untouched
  });

  it('a target that appeared meanwhile is someone else’s: it is kept, the rest is removed', async () => {
    let calls = 0;
    const racing: CopyFs = {
      ...realCopyFs,
      copyFile: async (from, to) => {
        calls += 1;
        if (calls === 2) {
          await writeFile(to, 'not ours');
          throw fsError('EEXIST');
        }
        await realCopyFs.copyFile(from, to);
      },
    };
    const result = await copyEntry(root, '图片 素材', '目标 文件夹', 'paste', racing);
    expect(result).toMatchObject({ ok: false, code: 'exists' });
    // The folders we made could not be removed because "not ours" is inside: that file is never deleted.
    const left = await readdir(p('目标 文件夹', '图片 素材', '小 图'));
    expect(left).toEqual(['二.txt']); // 一.txt (ours, copied first) was removed
    expect(await readFile(p('目标 文件夹', '图片 素材', '小 图', '二.txt'), 'utf8')).toBe('not ours');
    expect(result.ok || result.message).toContain('left');
  });

  it('a permission error is explained as such', async () => {
    const result = await copyEntry(root, '页面 二.html', '目标 文件夹', 'paste', failingAt(1, 'EACCES'));
    expect(result).toMatchObject({ ok: false, code: 'permission-denied' });
    expect(await readdir(p('目标 文件夹'))).toEqual([]);
  });

  it('a selection reports each failure and still copies the rest', async () => {
    await writeFile(p('目标 文件夹', '图片 素材'), 'a file where the folder would go');
    // The folder name is taken by a file: the folder copy gets a copy name; the file copies normally.
    const result = await paste(['图片 素材', '页面 二.html'], '目标 文件夹');
    expect(result).toMatchObject({
      value: {
        copied: [{ to: '目标 文件夹/图片 素材 copy' }, { to: '目标 文件夹/页面 二.html' }],
        failed: [],
      },
    });
    expect(await readFile(p('目标 文件夹', '图片 素材'), 'utf8')).toBe('a file where the folder would go');
  });

  it('the exclusive file copy never touches a target that exists', async () => {
    await writeFile(p('目标 文件夹', 'x.html'), 'keep');
    await expect(copyFileExclusive(p('页面 二.html'), p('目标 文件夹', 'x.html'))).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(p('目标 文件夹', 'x.html'), 'utf8')).toBe('keep');
  });

  it('a copy over the size limits is refused before anything is written', async () => {
    const huge: CopyFs = {
      ...realCopyFs,
      lstat: async (q) => {
        const info = await realCopyFs.lstat(q);
        return info.isFile() ? Object.assign(Object.create(info), { size: COPY_LIMITS.maxBytes }) : info;
      },
    };
    const before = (await readdir(root)).sort();
    expect(await copyEntry(root, '图片 素材', '', 'duplicate', huge)).toMatchObject({ ok: false, code: 'too-large' });
    expect((await readdir(root)).sort()).toEqual(before);
  });
});
