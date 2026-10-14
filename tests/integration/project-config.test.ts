import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreviewServer } from '../../src/preview/static-server';
import {
  EMPTY_PROJECT_CONFIG,
  looksAbsolute,
  parseProjectConfig,
  previewEntryPath,
  readProjectConfig,
  writeProjectConfig,
} from '../../src/workspace/project-config';

/**
 * S13.2: `.noobide/project.json` stores the entry page, preview preferences and its version only; absolute paths are
 * rejected; deleting it leaves an ordinary site that the preview server still serves. Real file system, project path
 * with Chinese characters and spaces.
 */
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', '中文 路径 项目');
let tmp: string;
let root: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-config-'));
  const chosen = path.join(tmp, '网页 练习', '中文 路径 项目');
  await mkdir(path.dirname(chosen), { recursive: true });
  await cp(FIXTURE, chosen, { recursive: true });
  root = await realpath(chosen);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const configFile = () => path.join(root, '.noobide', 'project.json');

describe('schema (S13.2)', () => {
  it('stores only the entry page, preview preferences and the version', () => {
    expect(parseProjectConfig({ version: 1 })).toEqual({ ok: true, config: { version: 1 } });
    expect(
      parseProjectConfig({ version: 1, entry: '子 文件夹/页面 二.html', preview: { autoRefresh: false } }),
    ).toEqual({
      ok: true,
      config: { version: 1, entry: '子 文件夹/页面 二.html', preview: { autoRefresh: false } },
    });
    expect(parseProjectConfig({ version: 1, recent: ['a'] })).toEqual({ ok: false, problems: ['unknown-key'] });
    expect(parseProjectConfig({ version: 1, token: 'secret' })).toEqual({ ok: false, problems: ['unknown-key'] });
    expect(parseProjectConfig({ version: 1, preview: { port: 8080 } })).toEqual({
      ok: false,
      problems: ['invalid-preview'],
    });
  });

  it.each([
    'C:\\Users\\林\\site\\index.html',
    'C:/Users/x/index.html',
    '/Users/lin/site/index.html',
    '\\\\server\\share\\index.html',
    'file:///C:/site/index.html',
    '~/site/index.html',
  ])('rejects the absolute path %s anywhere in the file', (absolute) => {
    expect(looksAbsolute(absolute)).toBe(true);
    expect(parseProjectConfig({ version: 1, entry: absolute })).toEqual({ ok: false, problems: ['absolute-path'] });
    expect(parseProjectConfig({ version: 1, preview: { note: absolute } })).toMatchObject({
      ok: false,
      problems: expect.arrayContaining(['absolute-path']),
    });
  });

  it('rejects entries that are not portable project pages, and unknown versions', () => {
    for (const entry of ['../x.html', 'style.css', 'a//b.html', '.hidden/x.html', 'CON.html', 'x.html.']) {
      expect(parseProjectConfig({ version: 1, entry })).toEqual({ ok: false, problems: ['invalid-entry'] });
    }
    expect(parseProjectConfig({ version: 2 })).toEqual({ ok: false, problems: ['newer-version'] });
    expect(parseProjectConfig({})).toEqual({ ok: false, problems: ['bad-version'] });
    expect(parseProjectConfig([1])).toEqual({ ok: false, problems: ['not-an-object'] });
  });
});

describe('reading and writing in a project (S13.2)', () => {
  it('a project without the file is ordinary: defaults, nothing written', async () => {
    expect(await readProjectConfig(root)).toEqual({ kind: 'missing' });
    expect(await previewEntryPath(root)).toBe('');
    expect((await readdir(root)).includes('.noobide')).toBe(false);
  });

  it('writes .noobide/project.json with relative paths only and reads it back', async () => {
    const written = await writeProjectConfig(root, { version: 1, entry: '子 文件夹/页面 二.html' });
    expect(written.ok).toBe(true);
    const raw = await readFile(configFile(), 'utf8');
    expect(JSON.parse(raw)).toEqual({ version: 1, entry: '子 文件夹/页面 二.html' });
    expect(raw).not.toContain(root);
    expect(raw).not.toContain(tmp);
    expect(await readProjectConfig(root)).toEqual({
      kind: 'ok',
      config: { version: 1, entry: '子 文件夹/页面 二.html' },
    });
    expect(await previewEntryPath(root)).toBe(
      `${encodeURIComponent('子 文件夹')}/${encodeURIComponent('页面 二.html')}`,
    );
    // Only this one file was added to the project.
    expect(await readdir(path.join(root, '.noobide'))).toEqual(['project.json']);
  });

  it('refuses to write an absolute path or unknown data', async () => {
    const absolute = await writeProjectConfig(root, { version: 1, entry: path.join(root, 'index.html') });
    expect(absolute.ok).toBe(false);
    if (!absolute.ok) expect(absolute.code).toBe('invalid');
    const extra = await writeProjectConfig(root, { version: 1, secret: 'x' } as never);
    expect(extra.ok).toBe(false);
    expect((await readdir(root)).includes('.noobide')).toBe(false);
  });

  it('a hand-written file with an absolute path is rejected and never overwritten', async () => {
    await mkdir(path.join(root, '.noobide'));
    const hand = JSON.stringify({ version: 1, entry: 'D:/网站/index.html' });
    await writeFile(configFile(), hand);
    expect(await readProjectConfig(root)).toEqual({ kind: 'invalid', problems: ['absolute-path'] });
    expect(await previewEntryPath(root)).toBe('');
    const write = await writeProjectConfig(root, { version: 1, entry: 'index.html' });
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.code).toBe('invalid-existing');
    expect(await readFile(configFile(), 'utf8')).toBe(hand);
  });

  it('an entry that no longer exists falls back to index.html', async () => {
    await writeProjectConfig(root, { version: 1, entry: 'gone.html' });
    expect(await previewEntryPath(root)).toBe('');
  });

  it('deleting .noobide leaves a working site: the preview server still serves the pages', async () => {
    await writeProjectConfig(root, { version: 1, entry: '子 文件夹/页面 二.html', preview: { autoRefresh: false } });
    await rm(path.join(root, '.noobide'), { recursive: true });
    expect(await readProjectConfig(root)).toEqual({ kind: 'missing' });
    expect(await previewEntryPath(root)).toBe('');
    const server = await PreviewServer.start(root, { requireToken: false });
    try {
      const index = await fetch(`${server.origin}/`);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain('<html');
      const page = await fetch(
        `${server.origin}/${encodeURIComponent('子 文件夹')}/${encodeURIComponent('页面 二.html')}`,
      );
      expect(page.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('the config file itself is never served to the page (dotfile)', async () => {
    await writeProjectConfig(root, { version: 1, entry: 'index.html' });
    const server = await PreviewServer.start(root, { requireToken: false });
    try {
      expect((await fetch(`${server.origin}/.noobide/project.json`)).status).not.toBe(200);
    } finally {
      await server.close();
    }
  });

  it('EMPTY_PROJECT_CONFIG is just the version', () => {
    expect(EMPTY_PROJECT_CONFIG).toEqual({ version: 1 });
  });
});
