import { describe, expect, it } from 'vitest';
import { checkFileName, differsOnlyByCase, sameName } from './file-names';

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
