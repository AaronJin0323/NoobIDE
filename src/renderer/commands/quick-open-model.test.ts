import { describe, expect, it } from 'vitest';
import { pushRecent, rankFiles } from './quick-open-model';

const FILES = [
  'index.html',
  'about.html',
  'css/style.css',
  'css/index.css',
  'js/main.js',
  'js/index-helper.js',
  '子 文件夹/页面 二.html',
  '子 文件夹/页面 一.html',
  '图片/照片 墙.png',
  'node_modules/lib/index.js',
  '.noobide/project.json',
  '.hidden.html',
  'Thumbs.db',
  'style.css.noobide-tmp',
];

const paths = (query: string, recent: string[] = []) => rankFiles(FILES, query, recent).map((m) => m.relPath);

describe('quick open matcher (S51.5)', () => {
  it('puts the exact file name first, then the name without extension, then prefixes', () => {
    expect(paths('index.html')[0]).toBe('index.html');
    expect(paths('index')).toEqual(['index.html', 'css/index.css', 'js/index-helper.js']);
    expect(paths('style.css')).toEqual(['css/style.css']);
  });

  it('matches names and folders with Chinese characters and spaces', () => {
    expect(paths('页面 二')).toEqual(['子 文件夹/页面 二.html']);
    expect(paths('页面')).toEqual(['子 文件夹/页面 一.html', '子 文件夹/页面 二.html']);
    expect(paths('子 文件夹/')).toEqual(['子 文件夹/页面 一.html', '子 文件夹/页面 二.html']);
    // Fuzzy: characters in order, spaces optional.
    expect(paths('页二')).toEqual(['子 文件夹/页面 二.html']);
    expect(paths('照片墙')).toEqual(['图片/照片 墙.png']);
    expect(paths('图片照')).toEqual(['图片/照片 墙.png']);
  });

  it('is case-insensitive and fuzzy over the name before the path', () => {
    expect(paths('INDEX.HTML')[0]).toBe('index.html');
    expect(paths('mjs')).toEqual(['js/main.js']);
    expect(paths('cssst')).toEqual(['css/style.css']);
  });

  it('never offers ignored or hidden files', () => {
    const all = rankFiles(FILES, '').map((m) => m.relPath);
    expect(all).not.toContain('node_modules/lib/index.js');
    expect(all).not.toContain('.noobide/project.json');
    expect(all).not.toContain('.hidden.html');
    expect(all).not.toContain('Thumbs.db');
    expect(all).not.toContain('style.css.noobide-tmp');
    expect(paths('project')).toEqual([]);
  });

  it('lists recently opened files first while the query is empty', () => {
    const recent = pushRecent(pushRecent(pushRecent([], 'css/style.css'), 'gone.html'), '子 文件夹/页面 二.html');
    expect(recent).toEqual(['子 文件夹/页面 二.html', 'gone.html', 'css/style.css']);
    const listed = rankFiles(FILES, '', recent);
    expect(listed.slice(0, 2).map((m) => m.relPath)).toEqual(['子 文件夹/页面 二.html', 'css/style.css']);
    expect(listed[0]).toMatchObject({ name: '页面 二.html', folder: '子 文件夹/', recent: true });
    expect(listed[2]?.recent).toBe(false);
    expect(listed.map((m) => m.relPath)).not.toContain('gone.html'); // deleted since: not offered
    expect(pushRecent(recent, 'css/style.css')[0]).toBe('css/style.css');
  });

  // The "< 50 ms per keystroke" budget is in tests/perf/quick-open.perf.test.ts (S58.8, ADR 0038): it failed hosted
  // macOS runners twice (75.7 ms, 59.7 ms) while measuring nothing about the change under test.
  it('filters 2 000 indexed files keystroke by keystroke', () => {
    const files: string[] = [];
    for (let i = 0; i < 2000; i += 1) files.push(`栏目 ${i % 20}/子 目录 ${i % 7}/页面 ${i}.html`);
    files.push('css/样式 表.css');
    const typed = '子 目录 3/页面 19';
    for (let n = 1; n <= typed.length; n += 1) {
      expect(rankFiles(files, typed.slice(0, n), ['css/样式 表.css']).length).toBeGreaterThan(0);
    }
    expect(rankFiles(files, 'zzzz不存在')).toEqual([]);
    expect(rankFiles(files, '页面 1999.html')[0]?.relPath).toBe('栏目 19/子 目录 4/页面 1999.html');
  });
});
