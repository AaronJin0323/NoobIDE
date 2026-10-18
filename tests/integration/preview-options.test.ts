import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_IO, removeTempDir } from './real-io';
import {
  readPreviewOptions,
  refreshModeOf,
  withRefreshMode,
  writeRefreshMode,
} from '../../src/preview/project-options';
import { EMPTY_PROJECT_CONFIG } from '../../src/workspace/project-config';

/**
 * S14.2 refresh mode and S14.3 entry page as the toolbar sees them, stored in `.noobide/project.json` through the
 * S13.2 module (nothing else is written into the project).
 */
let tmp: string;
let root: string;
const configFile = () => path.join(root, '.noobide', 'project.json');

beforeEach(async () => {
  // Project roots are real paths in the app (macOS: /var → /private/var).
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-popts-')));
  root = path.join(tmp, '网页 练习');
  await mkdir(path.join(root, '页面'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<p>i</p>');
  await writeFile(path.join(root, '页面', '关于 我们.html'), '<p>a</p>');
}, REAL_IO.timeout);
afterEach(async () => {
  await removeTempDir(tmp);
}, REAL_IO.timeout);

describe('preview project options (S14.2, S14.3)', REAL_IO, () => {
  it('defaults: automatic refresh, index.html, nothing written', async () => {
    expect(await readPreviewOptions(root)).toEqual({
      pages: ['index.html', '页面/关于 我们.html'],
      truncated: false,
      entry: null,
      refresh: 'auto',
      configLocked: false,
    });
    expect(await writeRefreshMode(root, 'auto')).toMatchObject({ ok: true, value: 'auto' });
    expect(await readdir(root)).not.toContain('.noobide');
  });

  it('manual mode is stored in .noobide/project.json and read back; auto removes it again', async () => {
    expect(await writeRefreshMode(root, 'manual')).toMatchObject({ ok: true, value: 'manual' });
    expect(JSON.parse(await readFile(configFile(), 'utf8'))).toEqual({ version: 1, preview: { autoRefresh: false } });
    expect((await readPreviewOptions(root)).refresh).toBe('manual');
    expect(await writeRefreshMode(root, 'auto')).toMatchObject({ ok: true, value: 'auto' });
    expect(JSON.parse(await readFile(configFile(), 'utf8'))).toEqual({ version: 1 });
  });

  it('keeps the entry page when the refresh mode changes', async () => {
    await mkdir(path.dirname(configFile()));
    await writeFile(configFile(), JSON.stringify({ version: 1, entry: '页面/关于 我们.html' }));
    expect((await readPreviewOptions(root)).entry).toBe('页面/关于 我们.html');
    await writeRefreshMode(root, 'manual');
    expect(JSON.parse(await readFile(configFile(), 'utf8'))).toEqual({
      version: 1,
      entry: '页面/关于 我们.html',
      preview: { autoRefresh: false },
    });
  });

  it('an entry whose file is gone shows as the default', async () => {
    await mkdir(path.dirname(configFile()));
    await writeFile(configFile(), JSON.stringify({ version: 1, entry: 'gone.html' }));
    expect((await readPreviewOptions(root)).entry).toBeNull();
  });

  it('an unreadable project file is never overwritten: the setting is locked', async () => {
    await mkdir(path.dirname(configFile()));
    const handWritten = '{ "version": 99, "mine": true }';
    await writeFile(configFile(), handWritten);
    expect((await readPreviewOptions(root)).configLocked).toBe(true);
    expect(await writeRefreshMode(root, 'manual')).toMatchObject({ ok: false, code: 'invalid-existing' });
    expect(await readFile(configFile(), 'utf8')).toBe(handWritten);
  });

  it('maps the stored flag both ways', () => {
    expect(refreshModeOf(EMPTY_PROJECT_CONFIG)).toBe('auto');
    expect(refreshModeOf({ version: 1, preview: { autoRefresh: false } })).toBe('manual');
    expect(refreshModeOf({ version: 1, preview: { autoRefresh: true } })).toBe('auto');
    expect(withRefreshMode({ version: 1, entry: 'a.html' }, 'manual')).toEqual({
      version: 1,
      entry: 'a.html',
      preview: { autoRefresh: false },
    });
    expect(withRefreshMode({ version: 1, preview: { autoRefresh: false } }, 'auto')).toEqual({ version: 1 });
  });
});

describe('a project with no page (pages saved without .html)', REAL_IO, () => {
  it('lists files that start like a page, with the name a rename would give them; nothing on disk changes', async () => {
    const site = path.join(tmp, 'DESN 6006');
    await mkdir(path.join(site, 'html'), { recursive: true });
    await mkdir(path.join(site, 'styles'));
    await writeFile(path.join(site, 'html', 'home'), '<!DOCTYPE html>\n<html lang="en"><head></head></html>');
    await writeFile(path.join(site, 'html', 'about'), ''); // empty: not offered
    await writeFile(path.join(site, 'html', '联系.hmtl'), '<html><body>联系</body></html>');
    await writeFile(path.join(site, 'styles', 'main'), 'body { color: red }'); // not a page
    await writeFile(path.join(site, 'html', 'taken'), '<!doctype html>');
    await writeFile(path.join(site, 'html', 'taken.HTML.txt'), 'x'); // not HTML; makes no difference
    const before = (await readdir(path.join(site, 'html'))).sort();

    const options = await readPreviewOptions(site);
    expect(options.pages).toEqual([]);
    expect([...(options.misnamed ?? [])].sort((a, b) => a.path.localeCompare(b.path))).toEqual(
      [
        { path: 'html/home', suggested: 'html/home.html' },
        { path: 'html/taken', suggested: 'html/taken.html' },
        { path: 'html/联系.hmtl', suggested: 'html/联系.html' },
      ].sort((a, b) => a.path.localeCompare(b.path)),
    );
    expect((await readdir(path.join(site, 'html'))).sort()).toEqual(before);
  });

  it('never suggests a name that is already taken, and says nothing when the project has pages', async () => {
    const site = path.join(tmp, 'taken');
    await mkdir(site);
    await writeFile(path.join(site, 'home'), '<!DOCTYPE html>');
    await writeFile(path.join(site, 'HOME.HTML.bak'), 'x');
    await writeFile(path.join(site, 'page'), '<html></html>');
    await writeFile(path.join(site, 'Page.html'), '<html></html>');
    const options = await readPreviewOptions(site);
    expect(options.pages).toEqual(['Page.html']);
    expect(options.misnamed).toBeUndefined();
    expect((await readPreviewOptions(root)).misnamed).toBeUndefined();
  });
});
