import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultTemplate,
  existsWithExactCase,
  isSafeRelativePath,
  listTemplates,
  parseTemplateManifest,
  resolveTemplatesDir,
} from './templates';

const manifest = (over: Record<string, unknown> = {}) => ({
  id: 'demo',
  order: 1,
  default: false,
  name: { 'zh-CN': '示例', en: 'Demo' },
  description: { 'zh-CN': '说明', en: 'About' },
  entry: 'index.html',
  files: ['index.html', 'style.css', 'images/a.svg'],
  thumbnail: 'thumbnail.svg',
  ...over,
});

describe('parseTemplateManifest', () => {
  it('accepts a valid manifest', () => {
    const r = parseTemplateManifest(manifest(), 'demo');
    expect(r.ok && r.value.name.en).toBe('Demo');
  });

  it.each([
    ['not an object', null],
    ['id mismatch', manifest({ id: 'other' })],
    ['bad id', manifest({ id: 'Demo' })],
    ['missing en name', manifest({ name: { 'zh-CN': '示例' } })],
    ['empty description', manifest({ description: { 'zh-CN': ' ', en: 'x' } })],
    ['non-integer order', manifest({ order: 1.5 })],
    ['entry not in files', manifest({ entry: 'other.html' })],
    ['entry not html', manifest({ entry: 'style.css' })],
    ['empty files', manifest({ files: [] })],
    ['parent path', manifest({ files: ['index.html', '../x.js'] })],
    ['absolute path', manifest({ files: ['index.html', '/x.js'] })],
    ['backslash', manifest({ files: ['index.html', 'images\\a.svg'] })],
    ['drive letter', manifest({ files: ['index.html', 'C:/x.js'] })],
    ['dot-file', manifest({ files: ['index.html', '.noobide/project.json'] })],
    ['manifest copied', manifest({ files: ['index.html', 'template.json'] })],
    ['case-duplicate', manifest({ files: ['index.html', 'A.css', 'a.css'] })],
    ['thumbnail copied', manifest({ thumbnail: 'index.html' })],
  ])('rejects %s', (_why, raw) => {
    const r = parseTemplateManifest(raw, 'demo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-manifest');
  });
});

describe('isSafeRelativePath', () => {
  it('allows nested relative paths with Chinese characters and spaces', () => {
    expect(isSafeRelativePath('图片/我的 头像.png')).toBe(true);
  });
  it.each(['', '.', 'a//b', './a', 'a/../b', '.git/config', 'a\0b'])('refuses %j', (p) => {
    expect(isSafeRelativePath(p)).toBe(false);
  });
});

describe('listTemplates (temporary folders)', () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'noobide-templates-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function writeTemplate(
    id: string,
    over: Record<string, unknown> = {},
    files = ['index.html', 'style.css', 'images/a.svg', 'thumbnail.svg'],
  ) {
    const dir = path.join(base, id);
    await mkdir(path.join(dir, 'images'), { recursive: true });
    await writeFile(path.join(dir, 'template.json'), JSON.stringify(manifest({ id, ...over })));
    for (const f of files) await writeFile(path.join(dir, ...f.split('/')), 'x');
  }

  it('lists valid templates in order and reports invalid ones without throwing', async () => {
    await writeTemplate('second', { order: 2 });
    await writeTemplate('first', { order: 1, default: true });
    await writeTemplate('missing-file', { order: 3 }, ['index.html', 'thumbnail.svg']);
    await mkdir(path.join(base, 'no-manifest'));
    await mkdir(path.join(base, '.hidden'));
    await writeFile(path.join(base, 'README.md'), 'x');

    const r = await listTemplates(base);
    if (!r.ok) throw new Error(r.message);
    expect(r.value.templates.map((t) => t.id)).toEqual(['first', 'second']);
    expect(r.value.templates[0]!.dir).toBe(path.join(base, 'first'));
    expect(r.value.problems.map((p) => p.folder).sort()).toEqual(['missing-file', 'no-manifest']);
    expect(defaultTemplate(r.value.templates)?.id).toBe('first');
  });

  it('rejects a listed file whose case differs on disk', async () => {
    await writeTemplate('demo', {}, ['index.html', 'style.css', 'images/A.svg', 'thumbnail.svg']);
    expect(await existsWithExactCase(path.join(base, 'demo'), 'images/a.svg')).toBe(false);
    expect(await existsWithExactCase(path.join(base, 'demo'), 'images/A.svg')).toBe(true);
    const r = await listTemplates(base);
    expect(r.ok && r.value.problems[0]?.reason).toMatch(/images\/a\.svg is missing/);
  });

  it('works under a base folder with Chinese characters and spaces', async () => {
    const nested = path.join(base, '模板 目录');
    await mkdir(nested);
    const old = base;
    base = nested;
    await writeTemplate('demo');
    base = old;
    const r = await listTemplates(nested);
    expect(r.ok && r.value.templates.map((t) => t.id)).toEqual(['demo']);
  });

  it('fails cleanly when the base folder is missing', async () => {
    const r = await listTemplates(path.join(base, 'nope'));
    expect(r.ok ? 'ok' : r.code).toBe('unreadable-base-dir');
  });
});

describe('resolveTemplatesDir', () => {
  it('uses <resources>/templates when packaged and <app>/resources/templates in development', () => {
    const resourcesPath = path.join('C:', 'Program Files', 'NoobIDE', 'resources');
    const appPath = path.join('D:', 'NoobIDE');
    expect(resolveTemplatesDir({ isPackaged: true, resourcesPath, appPath })).toBe(
      path.join(resourcesPath, 'templates'),
    );
    expect(resolveTemplatesDir({ isPackaged: false, resourcesPath, appPath })).toBe(
      path.join(appPath, 'resources', 'templates'),
    );
  });
});
