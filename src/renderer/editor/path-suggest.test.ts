import { describe, expect, it } from 'vitest';
import { MAX_PATH_SUGGESTIONS, acceptsPath, suggestPaths } from './path-suggest';

const files = [
  'index.html',
  'about.html',
  'style.css',
  'js/main.js',
  'js/util.mjs',
  'js/lib/helper.js',
  'images/猫 照片.png',
  'images/logo.svg',
  'images/notes.txt',
  'images/icons/star.ico',
  'fonts/字体.woff2',
  'pages/联系 我们.html',
  'pages/sub/deep.html',
  '.noobide/project.json',
  '.git/HEAD',
  'images/.hidden.png',
  '.env',
];

const run = (fromRelPath: string, prefix: string, accept: Parameters<typeof suggestPaths>[0]['accept'], js = false) =>
  suggestPaths({ files, fromRelPath, prefix, accept, js });
const inserts = (xs: { insertText: string }[]) => xs.map((x) => x.insertText);

describe('acceptsPath (S43.5)', () => {
  it.each([
    ['a/b.PNG', 'media', true],
    ['f.woff2', 'media', true],
    ['clip.mp4', 'media', true],
    ['notes.txt', 'media', false],
    ['s.css', 'css', true],
    ['m.mjs', 'js', true],
    ['m.ts', 'js', false],
    ['p.htm', 'html', true],
    ['README', 'any', true],
    ['.png', 'media', false],
    ['noext', 'media', false],
  ] as const)('%s as %s → %s', (rel, accept, expected) => {
    expect(acceptsPath(rel, accept)).toBe(expected);
  });
});

describe('suggestPaths (S43.5)', () => {
  it('lists files of the current folder, then folders, never the current file, dotfiles or dot folders', () => {
    const got = run('index.html', '', 'any');
    expect(got.filter((s) => !s.isDirectory).map((s) => s.label)).toEqual(['about.html', 'style.css']);
    expect(got.filter((s) => s.isDirectory).map((s) => s.label)).toEqual(['fonts/', 'images/', 'js/', 'pages/']);
    expect(got.findIndex((s) => s.isDirectory)).toBe(2); // files first
    expect(inserts(got).some((t) => t.includes('.noobide') || t.includes('.git') || t.includes('.env'))).toBe(false);
  });

  it('filters by accept, and only offers folders that contain an accepted file', () => {
    expect(inserts(run('index.html', '', 'media'))).toEqual(['fonts/', 'images/']);
    // zh-CN collation (ICU) sorts Han names before Latin ones
    expect(inserts(run('index.html', 'images/', 'media'))).toEqual([
      'images/猫 照片.png',
      'images/logo.svg',
      'images/icons/',
    ]);
    expect(inserts(run('index.html', '', 'css'))).toEqual(['style.css']);
  });

  it('keeps Chinese names and spaces as written on disk, and matches the partial name', () => {
    const got = run('index.html', 'images/猫', 'media');
    expect(got).toEqual([{ insertText: 'images/猫 照片.png', label: '猫 照片.png', isDirectory: false }]);
    expect(inserts(run('index.html', 'pages/联系 ', 'html'))).toEqual(['pages/联系 我们.html']);
    expect(inserts(run('index.html', 'IMAGES/L', 'media'))).toEqual([]); // folder names are not case-folded
    expect(inserts(run('index.html', 'images/L', 'media'))).toEqual(['images/logo.svg']);
  });

  it('follows ../ and ./ from the current file folder', () => {
    expect(inserts(run('pages/联系 我们.html', '../', 'css'))).toEqual(['../style.css']);
    expect(inserts(run('pages/sub/deep.html', '../../images/lo', 'media'))).toEqual(['../../images/logo.svg']);
    expect(inserts(run('pages/联系 我们.html', './', 'html'))).toEqual(['./sub/']);
    expect(run('index.html', '../', 'any')).toEqual([]); // never outside the project
  });

  it('JS imports start with ./ or ../', () => {
    expect(inserts(run('js/main.js', '', 'js', true))).toEqual(['./util.mjs', './lib/']);
    expect(inserts(run('js/main.js', './', 'js', true))).toEqual(['./util.mjs', './lib/']);
    expect(inserts(run('js/main.js', 'lib/', 'js', true))).toEqual(['./lib/helper.js']);
    expect(inserts(run('js/lib/helper.js', '../', 'js', true))).toEqual(['../main.js', '../util.mjs']);
  });

  it('never suggests absolute paths or URLs', () => {
    expect(run('index.html', '/', 'any')).toEqual([]);
    expect(run('index.html', 'C:\\', 'any')).toEqual([]);
    expect(run('index.html', 'https://', 'any')).toEqual([]);
    expect(inserts(run('index.html', '', 'any')).some((t) => t.startsWith('/'))).toBe(false);
  });

  it('encodes only when the typed text is already encoded', () => {
    expect(inserts(run('index.html', 'images/%E7%8C%AB', 'media'))).toEqual([
      `images/${encodeURIComponent('猫 照片.png')}`,
    ]);
    expect(run('index.html', 'images/%E7%8C', 'media')).toEqual([]); // malformed escape
  });

  it('caps the result count', () => {
    const many = Array.from({ length: 500 }, (_, i) => `img/p${i}.png`);
    const got = suggestPaths({ files: many, fromRelPath: 'index.html', prefix: 'img/', accept: 'media', js: false });
    expect(got).toHaveLength(MAX_PATH_SUGGESTIONS);
  });
});
