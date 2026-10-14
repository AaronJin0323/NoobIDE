import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformId } from '../platform/index';
import {
  absoluteFromRel,
  fromFileUri,
  isCaseSensitive,
  isInside,
  normalizeRelPath,
  relativeToRoot,
  resolveExisting,
  resolveNew,
  toFileUri,
  type StatFs,
} from './paths';

const { win32, posix } = path;

describe('normalizeRelPath (S07.1)', () => {
  it('turns Windows separators into the portable form and drops empty and . segments', () => {
    expect(normalizeRelPath('css\\style.css', win32)).toBe('css/style.css');
    expect(normalizeRelPath('.\\子 文件夹\\\\页面 二.html', win32)).toBe('子 文件夹/页面 二.html');
    expect(normalizeRelPath('a/./b/', posix)).toBe('a/b');
    expect(normalizeRelPath('.', posix)).toBe('');
  });

  it('keeps a backslash on POSIX, where it is an ordinary file-name character', () => {
    expect(normalizeRelPath('a\\b.txt', posix)).toBe('a\\b.txt');
  });

  it.each([
    ['a parent segment', '../x', posix],
    ['a nested parent segment', 'a/../../x', posix],
    ['a POSIX absolute path', '/etc/passwd', posix],
    ['a drive letter', 'C:\\Windows\\win.ini', win32],
    ['a drive-relative path', 'C:foo', win32],
    ['a UNC path', '\\\\server\\share\\x', win32],
    ['a rooted Windows path', '\\Windows', win32],
    ['a URL', 'file:///etc/passwd', posix],
    ['a NUL byte', 'a\0b', posix],
  ])('rejects %s', (_name, input, api) => {
    expect(normalizeRelPath(input, api)).toBeNull();
  });

  it('does not change Unicode normalisation or case', () => {
    const nfd = 'cafe\u0301.html';
    expect(normalizeRelPath(nfd, posix)).toBe(nfd);
    expect(normalizeRelPath('Index.HTML', posix)).toBe('Index.HTML');
  });
});

describe('relative to root and inside root (S07.1)', () => {
  it('handles drive letters case-insensitively, as Windows does', () => {
    expect(relativeToRoot('C:\\Users\\林\\网页 练习', 'c:\\Users\\林\\网页 练习\\css\\a.css', win32)).toBe('css/a.css');
    expect(relativeToRoot('C:\\proj', 'C:\\proj', win32)).toBe('');
    expect(relativeToRoot('C:\\proj', 'D:\\proj\\a.html', win32)).toBeNull();
    expect(relativeToRoot('C:\\proj', 'C:\\proj-evil\\a.html', win32)).toBeNull();
  });

  it('handles UNC shares', () => {
    const root = '\\\\nas\\班级\\项目 一';
    expect(relativeToRoot(root, '\\\\nas\\班级\\项目 一\\img\\a.png', win32)).toBe('img/a.png');
    expect(relativeToRoot(root, '\\\\nas\\other\\项目 一\\a.png', win32)).toBeNull();
    expect(absoluteFromRel(root, 'img/a.png', win32)).toBe('\\\\nas\\班级\\项目 一\\img\\a.png');
    expect(isInside(root, '\\\\nas\\班级\\项目 一\\a', win32)).toBe(true);
  });

  it('isInside uses path semantics, not string prefixes', () => {
    expect(isInside('/p/proj', '/p/proj/a', posix)).toBe(true);
    expect(isInside('/p/proj', '/p/proj-evil/a', posix)).toBe(false);
    expect(isInside('/p/proj', '/p/proj', posix)).toBe(false);
    expect(isInside('/p/proj', '/p/proj/..a/x', posix)).toBe(true);
    expect(isInside('C:\\proj', 'c:\\PROJ\\x', win32)).toBe(true);
  });

  it('absoluteFromRel only accepts portable relative paths that stay inside', () => {
    expect(absoluteFromRel('/p/proj', '子 文件夹/页面 二.html', posix)).toBe('/p/proj/子 文件夹/页面 二.html');
    expect(absoluteFromRel('/p/proj', '', posix)).toBe('/p/proj');
    expect(absoluteFromRel('/p/proj', '../x', posix)).toBeNull();
    expect(absoluteFromRel('C:\\proj', 'a\\..\\..\\x', win32)).toBeNull();
    expect(absoluteFromRel('C:\\proj', 'a//b', win32)).toBeNull();
  });

  it('keeps case and trailing characters exactly (never lowercased)', () => {
    expect(absoluteFromRel('C:\\Proj', 'Index.HTML', win32)).toBe('C:\\Proj\\Index.HTML');
    expect(relativeToRoot('/Users/Lin/Proj', '/Users/Lin/Proj/README.md', posix)).toBe('README.md');
  });
});

describe('file URI round trip (S07.1)', () => {
  it.each([
    ['a Windows drive path with Chinese and spaces', 'C:\\Users\\林 小雨\\网页 练习\\index.html', win32],
    ['a Windows path with # and %', 'D:\\a #1\\100%.html', win32],
    ['a UNC path', '\\\\nas\\班级\\项目 一\\index.html', win32],
    ['a macOS path with Chinese and spaces', '/Users/lin/网页 练习/中文 路径 项目/index.html', posix],
    ['a macOS NFD name', '/Users/lin/cafe\u0301.html', posix],
    ['a POSIX name with a backslash and ?', '/tmp/a\\b?.html', posix],
  ])('%s', (_name, absolute, api) => {
    const uri = toFileUri(absolute, api);
    expect(uri.startsWith('file://')).toBe(true);
    expect(uri).not.toContain(' ');
    expect(fromFileUri(uri, api)).toBe(absolute);
  });

  it('uses the standard Windows forms', () => {
    expect(toFileUri('C:\\a b\\x.html', win32)).toBe('file:///C:/a%20b/x.html');
    expect(toFileUri('\\\\nas\\share\\x.html', win32)).toBe('file://nas/share/x.html');
  });
});

describe('case sensitivity per volume (S07.1)', () => {
  const stat = (map: Record<string, number>): StatFs => ({
    async lstat(p) {
      const ino = map[p];
      if (ino === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { dev: 1, ino };
    },
  });

  it('a flipped-case lookup that finds the same file means case-insensitive (NTFS, APFS default)', async () => {
    const fs = stat({ '/Volumes/X/Proj': 7, '/Volumes/X/proj': 7 });
    expect(await isCaseSensitive('/Volumes/X/Proj', fs, posix)).toBe(false);
  });

  it('a flipped-case lookup that finds nothing means case-sensitive (case-sensitive APFS, ext4)', async () => {
    const fs = stat({ '/Volumes/X/Proj': 7 });
    expect(await isCaseSensitive('/Volumes/X/Proj', fs, posix)).toBe(true);
  });

  it('a flipped-case lookup that finds a different file means case-sensitive', async () => {
    const fs = stat({ '/v/Proj': 7, '/v/proj': 8 });
    expect(await isCaseSensitive('/v/Proj', fs, posix)).toBe(true);
  });

  it('walks up past names without letters', async () => {
    const fs = stat({ 'D:\\Work\\网页': 3, 'D:\\Work': 2, 'D:\\work': 2 });
    expect(await isCaseSensitive('D:\\Work\\网页', fs, win32)).toBe(false);
  });

  it('probes the real temp volume without writing to it', async () => {
    const dir = await realpath(os.tmpdir());
    const result = await isCaseSensitive(dir);
    expect(typeof result).toBe('boolean');
    if (platformId() === 'windows') expect(result).toBe(false); // NTFS default
  });
});

describe('resolving on disk (S07.1)', () => {
  let tmp: string;
  let root: string;
  beforeAll(async () => {
    tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-paths-')));
    root = path.join(tmp, '中文 路径 项目');
    await mkdir(path.join(root, '子 文件夹'), { recursive: true });
    await writeFile(path.join(root, '子 文件夹', '页面 二.html'), 'x');
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('resolves existing entries and the root itself', async () => {
    expect(await resolveExisting(root, '子 文件夹/页面 二.html')).toEqual({
      ok: true,
      path: path.join(root, '子 文件夹', '页面 二.html'),
    });
    expect(await resolveExisting(root, '')).toEqual({ ok: true, path: root });
    expect(await resolveExisting(root, 'nope.html')).toMatchObject({ ok: false, code: 'not-found' });
    expect(await resolveExisting(root, '../x')).toMatchObject({ ok: false, code: 'outside-project' });
  });

  it('resolves a new name inside an existing folder only', async () => {
    expect(await resolveNew(root, '子 文件夹/新 文件.css')).toEqual({
      ok: true,
      path: path.join(root, '子 文件夹', '新 文件.css'),
      parent: path.join(root, '子 文件夹'),
    });
    expect(await resolveNew(root, 'missing/新.css')).toMatchObject({ ok: false, code: 'not-found' });
    expect(await resolveNew(root, '')).toMatchObject({ ok: false, code: 'outside-project' });
  });
});
