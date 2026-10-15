import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listEntryPages, sortPages } from '../../src/preview/entry-pages';

/** S14.3: pages offered by the entry picker (Chinese names and spaces, ignored folders, links, limits). */
let tmp: string;
let root: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-pages-'));
  root = path.join(tmp, '网页 练习');
  await mkdir(path.join(root, '子 页面', '更深'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(path.join(root, '.noobide'), { recursive: true });
  await mkdir(path.join(tmp, 'outside'));
  for (const file of [
    'index.html',
    '关于 我们.html',
    'old.htm',
    'style.css',
    'README.md',
    '子 页面/联系.html',
    '子 页面/更深/a.html',
    'node_modules/pkg/index.html',
    '.noobide/x.html',
    '.hidden.html',
  ]) {
    await writeFile(path.join(root, ...file.split('/')), '<p>x</p>');
  }
  await writeFile(path.join(tmp, 'outside', 'secret.html'), 'secret');
  try {
    await symlink(path.join(tmp, 'outside'), path.join(root, 'link'), 'junction');
  } catch {
    // symlinks may be unavailable (Windows without developer mode); the rest still runs
  }
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('entry pages (S14.3)', () => {
  it('lists the html pages as portable relative paths, index.html first', async () => {
    const { pages, truncated } = await listEntryPages(root);
    expect(truncated).toBe(false);
    expect(pages[0]).toBe('index.html');
    expect([...pages].sort()).toEqual(
      ['index.html', '关于 我们.html', 'old.htm', '子 页面/联系.html', '子 页面/更深/a.html'].sort(),
    );
    expect(pages.indexOf('子 页面/联系.html')).toBeLessThan(pages.indexOf('子 页面/更深/a.html'));
  });

  it('skips dot folders, dotfiles, node_modules and does not follow links out of the project', async () => {
    const { pages } = await listEntryPages(root);
    expect(pages.some((p) => p.includes('node_modules') || p.startsWith('.') || p.includes('secret'))).toBe(false);
  });

  it('stops at the limits and says so', async () => {
    expect(await listEntryPages(root, { maxPages: 2 })).toMatchObject({ truncated: true });
    expect((await listEntryPages(root, { maxPages: 2 })).pages).toHaveLength(2);
    expect(await listEntryPages(root, { maxDepth: 1 })).toMatchObject({ truncated: true });
  });

  it('sorts index.html first, then by depth and name', () => {
    expect(sortPages(['b/c.html', 'z.html', 'index.html', 'a.html'])).toEqual([
      'index.html',
      'a.html',
      'z.html',
      'b/c.html',
    ]);
  });
});
