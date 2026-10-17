import { describe, expect, it } from 'vitest';
import { MAX_NAME_BYTES, checkFileName, copyName, differsOnlyByCase, sameName } from './file-names';

describe('checkFileName: cross-platform rules (S07.1, S08.2)', () => {
  it.each(['index.html', '页面 二.html', 'my page.css', 'a.b.c.js', 'CONSOLE.js', 'con-tact.html', 'COM10.txt'])(
    'accepts %s',
    (name) => {
      expect(checkFileName(name)).toMatchObject({ ok: true, problems: [] });
    },
  );

  it.each([
    ['CON', 'reserved-windows'],
    ['con.txt', 'reserved-windows'],
    ['Nul.tar.gz', 'reserved-windows'],
    ['aux .html', 'reserved-windows'],
    ['COM1', 'reserved-windows'],
    ['lpt9.js', 'reserved-windows'],
    ['COM¹.txt', 'reserved-windows'],
    ['CONIN$', 'reserved-windows'],
    ['page.', 'trailing-dot-or-space'],
    ['page ', 'trailing-dot-or-space'],
    ['page.html ', 'trailing-dot-or-space'],
    ['', 'empty'],
    ['.', 'dot-name'],
    ['..', 'dot-name'],
    ['.env', 'starts-with-dot'],
    ['a\tb', 'control-char'],
    ['a\nb', 'control-char'],
    ['x'.repeat(256), 'too-long'],
    ['中'.repeat(86), 'too-long'], // 258 UTF-8 bytes but only 86 UTF-16 units
  ])('explains %j as %s', (name, problem) => {
    const check = checkFileName(name);
    expect(check.ok).toBe(false);
    expect(check.problems).toContain(problem);
  });

  it('reports each invalid character once, including the ones macOS also forbids', () => {
    expect(checkFileName('a<b>:c"d|e?f*g/h\\i??.html')).toMatchObject({
      ok: false,
      problems: ['invalid-char'],
      invalidChars: ['<', '>', ':', '"', '|', '?', '*', '/', '\\'],
    });
  });

  it('applies the Windows rules on every platform (never silently changed)', () => {
    // Same answer regardless of where the test runs: there is no platform parameter.
    expect(checkFileName('aux.css').problems).toEqual(['reserved-windows']);
  });
});

describe('name comparison (S07.1)', () => {
  it('ignores Unicode normalisation (NFC vs NFD) on every volume', () => {
    expect(sameName('café.html', 'café.html', true)).toBe(true);
    expect(sameName('café.html', 'café.html', false)).toBe(true);
  });

  it('ignores case only on case-insensitive volumes', () => {
    expect(sameName('Index.html', 'index.html', false)).toBe(true);
    expect(sameName('Index.html', 'index.html', true)).toBe(false);
    expect(differsOnlyByCase('Index.html', 'index.html')).toBe(true);
    expect(differsOnlyByCase('index.html', 'index.html')).toBe(false);
    expect(differsOnlyByCase('a.html', 'b.html')).toBe(false);
  });
});

describe('names of copies (S52.2)', () => {
  const free = (taken: string[]) => (name: string) => !taken.some((t) => sameName(t, name, false));

  it('a copy is "name copy.ext", then "name copy 2.ext", and so on', () => {
    expect(copyName('page.html', free(['page.html']))).toBe('page copy.html');
    expect(copyName('page.html', free(['page.html', 'page copy.html']))).toBe('page copy 2.html');
    expect(copyName('page.html', free(['page.html', 'page copy.html', 'page copy 2.html']))).toBe('page copy 3.html');
  });

  it('copying a copy counts on instead of piling up "copy copy"', () => {
    expect(copyName('page copy.html', free(['page.html', 'page copy.html']))).toBe('page copy 2.html');
    expect(copyName('page copy 2.html', free(['page copy.html', 'page copy 2.html']))).toBe('page copy 3.html');
  });

  it('folders, names without an ending and names with several dots; Chinese names with spaces', () => {
    expect(copyName('图片 素材', free(['图片 素材']))).toBe('图片 素材 copy');
    expect(copyName('README', free(['README']))).toBe('README copy');
    expect(copyName('app.min.js', free(['app.min.js']))).toBe('app.min copy.js');
    expect(copyName('页面 二.html', free(['页面 二.html']))).toBe('页面 二 copy.html');
    expect(copyName('图片 素材', free(['图片 素材']), 'directory')).toBe('图片 素材 copy');
    expect(copyName('v1.2', free(['v1.2']), 'directory')).toBe('v1.2 copy');
  });

  it('only a short number counts as a copy number, so a huge one cannot stall the counter', () => {
    const big = 'page copy 9007199254740991.html';
    expect(copyName(big, free([big]))).toBe('page copy 9007199254740991 copy.html');
    expect(copyName('page copy 41.html', free(['page copy 41.html']))).toBe('page copy 42.html');
  });

  it('a taken name differing only in case counts as taken (Windows and macOS)', () => {
    expect(copyName('page.html', free(['page.html', 'PAGE COPY.html']))).toBe('page copy 2.html');
  });

  it('every copy name is valid on Windows and macOS, also for very long names', () => {
    const long = `${'长'.repeat(84)}.html`; // 252 + 5 bytes: right at the limit
    const copy = copyName(long, free([long]));
    expect(checkFileName(copy).ok).toBe(true);
    expect(copy.endsWith(' copy.html')).toBe(true);
    expect(new TextEncoder().encode(copy).length).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });
});
