import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectService, isInside } from '../../src/workspace/project-service';

/**
 * S03.3 / S03.4 integration: real filesystem, a project path with Chinese characters and spaces, and the
 * containment, encoding and atomic-save rules of the project service.
 */
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', '中文 路径 项目');

let tmp: string;
let root: string;
let service: ProjectService;
let projectId: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-it-'));
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  await mkdir(path.dirname(root), { recursive: true });
  await cp(FIXTURE, root, { recursive: true });
  service = new ProjectService();
  const opened = await service.open(root);
  if (!opened.ok) throw new Error(opened.message);
  projectId = opened.value.projectId;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const request = (relPath: string) => ({ projectId, relPath });

describe('opening a project (S03.3)', () => {
  it('lists files with portable relative paths and stable file URIs', async () => {
    const opened = await service.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.name).toBe('中文 路径 项目');
    expect(opened.value.files.map((f) => f.relPath)).toEqual([
      'README.md',
      'index.html',
      'script.js',
      'style.css',
      '子 文件夹/页面 二.html',
    ]);
    const nested = opened.value.files.find((f) => f.relPath.startsWith('子'));
    expect(nested?.uri).toBe(pathToFileURL(path.join(opened.value.rootPath, '子 文件夹', '页面 二.html')).href);
    expect(fileURLToPath(nested?.uri ?? '')).toBe(path.join(opened.value.rootPath, '子 文件夹', '页面 二.html'));
    expect(opened.value.truncated).toBe(false);
  });

  it('keeps the chosen path exactly: no lowercasing, Chinese and spaces intact', async () => {
    const opened = await service.open(root);
    if (!opened.ok) throw new Error(opened.message);
    expect(opened.value.rootPath.endsWith(path.join('网页 练习', '中文 路径 项目'))).toBe(true);
  });

  it('skips dotfiles, node_modules and editor temp files', async () => {
    await mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'x', 'a.js'), '');
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.index.html.abc.noobide-tmp'), '');
    const opened = await service.open(root);
    if (!opened.ok) throw new Error(opened.message);
    expect(opened.value.files.map((f) => f.relPath)).not.toContain('node_modules/x/a.js');
    expect(opened.value.files.some((f) => f.relPath.startsWith('.'))).toBe(false);
  });

  it('reports a folder that cannot be listed', async () => {
    expect((await service.open(path.join(tmp, 'missing'))).ok).toBe(false);
  });
});

describe('reading files (S03.3)', () => {
  it('reads UTF-8 text with its line ending and URI', async () => {
    const result = await service.read(request('index.html'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toContain('你好，我是林小雨');
    expect(result.value.eol).toBe('\n');
    expect(result.value.bom).toBe(false);
    expect(fileURLToPath(result.value.uri).endsWith(path.join('中文 路径 项目', 'index.html'))).toBe(true);
  });

  it('reads nested files with Chinese names and spaces', async () => {
    const result = await service.read(request('子 文件夹/页面 二.html'));
    expect(result.ok && result.value.text).toBe('<p>第二页</p>\n');
  });

  it('refuses binary files instead of mangling them', async () => {
    await writeFile(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    expect(await service.read(request('logo.png'))).toMatchObject({ ok: false, code: 'unsupported-encoding' });
  });

  // S07.4 replaces "non-UTF-8 is refused" (S03): other encodings open read-only with a notice, never saved.
  it('opens non-UTF-8 text read-only and never overwrites it', async () => {
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // 你好 in GBK
    await writeFile(path.join(root, 'gbk.txt'), gbk);
    expect(await service.read(request('gbk.txt'))).toMatchObject({
      ok: true,
      value: { text: '你好', encoding: 'gb18030', readOnly: true, encodingGuessed: true },
    });
    expect(await service.write({ ...request('gbk.txt'), text: '你好', bom: false })).toMatchObject({
      ok: false,
      code: 'unsupported-encoding',
    });
    expect(await readFile(path.join(root, 'gbk.txt'))).toEqual(gbk);
    await writeFile(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    expect(await service.write({ ...request('logo.png'), text: 'x', bom: false })).toMatchObject({
      ok: false,
      code: 'unsupported-encoding',
    });
  });

  it('never overwrites a file on disk that is larger than the editor limit (review finding 1)', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 0xff);
    await writeFile(path.join(root, 'big.bin'), big);
    expect(await service.write({ ...request('big.bin'), text: 'oops', bom: false })).toMatchObject({
      ok: false,
      code: 'too-large',
    });
    const after = await readFile(path.join(root, 'big.bin'));
    expect(after.length).toBe(big.length);
    expect(after.equals(big)).toBe(true);
    // Also a big file that is valid UTF-8 text: it was never opened, so it is never replaced.
    await writeFile(path.join(root, 'big.txt'), 'a'.repeat(6 * 1024 * 1024));
    expect(await service.write({ ...request('big.txt'), text: 'oops', bom: false })).toMatchObject({
      ok: false,
      code: 'too-large',
    });
    expect((await readFile(path.join(root, 'big.txt'))).length).toBe(6 * 1024 * 1024);
  });

  it('UTF-8 files carry no encoding notice', async () => {
    const result = await service.read(request('index.html'));
    expect(result.ok && result.value.readOnly).toBeFalsy();
    expect(result.ok && result.value.encoding).toBeUndefined();
  });

  it('distinguishes missing files, folders and unknown projects', async () => {
    expect(await service.read(request('nope.html'))).toMatchObject({ ok: false, code: 'not-found' });
    expect(await service.read(request('子 文件夹'))).toMatchObject({ ok: false, code: 'not-a-file' });
    expect(
      await service.read({ projectId: '00000000-0000-4000-8000-000000000000', relPath: 'index.html' }),
    ).toMatchObject({ ok: false, code: 'unknown-project' });
  });
});

describe('saving files (S03.4)', () => {
  it('saves an edit in a path with Chinese characters and spaces', async () => {
    const before = await service.read(request('index.html'));
    if (!before.ok) throw new Error(before.message);
    const text = before.value.text.replace('点我', '点我一下');
    expect(await service.write({ ...request('index.html'), text, bom: false })).toMatchObject({ ok: true });
    expect(await readFile(path.join(root, 'index.html'), 'utf8')).toBe(text);
  });

  it('leaves no temporary file behind', async () => {
    await service.write({ ...request('style.css'), text: 'h1 { color: red; }\n', bom: false });
    expect((await readdir(root)).filter((n) => n.includes('noobide-tmp'))).toEqual([]);
  });

  it('keeps CRLF line endings and the UTF-8 BOM of existing files', async () => {
    const file = path.join(root, 'crlf.html');
    await writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>一</p>\r\n<p>二</p>\r\n')]));
    const read = await service.read(request('crlf.html'));
    if (!read.ok) throw new Error(read.message);
    expect(read.value).toMatchObject({ eol: '\r\n', bom: true, text: '<p>一</p>\r\n<p>二</p>\r\n' });
    await service.write({ ...request('crlf.html'), text: '<p>一</p>\r\n<p>三</p>\r\n', bom: read.value.bom });
    const bytes = await readFile(file);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString('utf8')).toBe('<p>一</p>\r\n<p>三</p>\r\n');
  });

  it('only overwrites existing files (creating files is S08)', async () => {
    expect(await service.write({ ...request('new.html'), text: 'x', bom: false })).toMatchObject({
      ok: false,
      code: 'not-found',
    });
    expect((await readdir(root)).includes('new.html')).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('refuses to replace a read-only file and keeps it unchanged', async () => {
    const file = path.join(root, 'style.css');
    const original = await readFile(file, 'utf8');
    await chmod(file, 0o444);
    try {
      const result = await service.write({ ...request('style.css'), text: 'changed', bom: false });
      expect(result).toMatchObject({ ok: false, code: 'permission-denied' });
    } finally {
      await chmod(file, 0o644);
    }
    expect(await readFile(file, 'utf8')).toBe(original);
    expect((await readdir(root)).filter((n) => n.includes('noobide-tmp'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a read-only folder and leaves the file untouched',
    async () => {
      const original = await readFile(path.join(root, 'style.css'), 'utf8');
      await chmod(root, 0o555);
      try {
        const result = await service.write({ ...request('style.css'), text: 'changed', bom: false });
        expect(result).toMatchObject({ ok: false, code: 'permission-denied' });
      } finally {
        await chmod(root, 0o755);
      }
      expect(await readFile(path.join(root, 'style.css'), 'utf8')).toBe(original);
    },
  );
});

describe('project containment', () => {
  it('rejects a link that leads outside the project', async (ctx) => {
    const outside = path.join(tmp, 'secret.txt');
    await writeFile(outside, 'secret');
    try {
      await symlink(outside, path.join(root, 'link.txt'), 'file');
    } catch {
      ctx.skip(); // Creating symlinks on Windows needs Developer Mode or admin rights.
    }
    expect(await service.read(request('link.txt'))).toMatchObject({ ok: false, code: 'outside-project' });
    expect(await service.write({ ...request('link.txt'), text: 'x', bom: false })).toMatchObject({
      ok: false,
      code: 'outside-project',
    });
    expect(await readFile(outside, 'utf8')).toBe('secret');
  });

  it('rejects a directory junction that leads outside the project', async (ctx) => {
    const outsideDir = path.join(tmp, 'outside');
    await mkdir(outsideDir);
    await writeFile(path.join(outsideDir, 'a.txt'), 'outside');
    try {
      await symlink(outsideDir, path.join(root, 'jump'), 'junction');
    } catch {
      ctx.skip();
    }
    expect(await service.read(request('jump/a.txt'))).toMatchObject({ ok: false, code: 'outside-project' });
  });

  it('refuses to write through a junction that leads outside, leaving the outside file unchanged', async () => {
    const outsideDir = path.join(tmp, 'outside-w');
    await mkdir(outsideDir);
    await writeFile(path.join(outsideDir, 'a.txt'), 'outside');
    await symlink(outsideDir, path.join(root, 'jump-w'), 'junction'); // no admin rights needed on Windows
    expect(await service.write({ ...request('jump-w/a.txt'), text: 'overwritten', bom: false })).toMatchObject({
      ok: false,
      code: 'outside-project',
    });
    expect(await readFile(path.join(outsideDir, 'a.txt'), 'utf8')).toBe('outside');
    expect(await readdir(outsideDir)).toEqual(['a.txt']);
  });

  it('refuses NTFS alternate data streams and names Windows rewrites, even past the IPC parser', async () => {
    for (const relPath of ['style.css:hid', 'style.css::$DATA', 'style.css.', 'style.css ', 'NUL']) {
      expect(await service.read(request(relPath))).toMatchObject({ ok: false, code: 'outside-project' });
      expect(await service.write({ ...request(relPath), text: 'x', bom: false })).toMatchObject({
        ok: false,
        code: 'outside-project',
      });
    }
    expect((await readdir(root)).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('opening another project revokes the previous projectId (one open project in v1)', async () => {
    const otherRoot = path.join(tmp, '另一个 项目');
    await mkdir(otherRoot);
    const reopened = await service.open(otherRoot);
    expect(reopened.ok).toBe(true);
    expect(await service.read(request('index.html'))).toMatchObject({ ok: false, code: 'unknown-project' });
    expect(service.rootOf(projectId)).toBeUndefined();
  });

  it('isInside uses path semantics, not string prefixes', () => {
    const base = path.join(tmp, 'proj');
    expect(isInside(base, path.join(base, 'a.html'))).toBe(true);
    expect(isInside(base, path.join(base, '..', 'proj-evil', 'a.html'))).toBe(false);
    expect(isInside(base, base)).toBe(false);
    // A folder whose name merely starts with '..' is still inside.
    expect(isInside(base, path.join(base, '..a', 'x'))).toBe(true);
  });
});
