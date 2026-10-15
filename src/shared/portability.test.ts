import { describe, expect, it } from 'vitest';
import { folderNameIssues, sortIssues, type PortabilityIssue } from './portability';

// Listings no single volume can hold (a default Mac volume is case- and normalisation-insensitive; Windows refuses
// `:`): the detector is tested with injected names.
const NFC = 'café.html';
const NFD = 'café.html';

describe('folderNameIssues (S13.5)', () => {
  it('reports nothing for an ordinary folder with Chinese names and spaces', () => {
    expect(folderNameIssues('', ['index.html', '关于 我们.html', 'style.css', '图片'])).toEqual([]);
  });

  it('reports names that differ only by letter case, as they are', () => {
    expect(folderNameIssues('img', ['Logo.png', 'logo.png', 'LOGO.PNG', 'other.png'])).toEqual([
      { kind: 'case-conflict', folder: 'img', names: ['Logo.png', 'logo.png', 'LOGO.PNG'] },
    ]);
    // Folders and files clash too.
    expect(folderNameIssues('', ['Pages', 'pages'])).toEqual([
      { kind: 'case-conflict', folder: '', names: ['Pages', 'pages'] },
    ]);
  });

  it('reports NFC/NFD twins as a Unicode conflict and the decomposed name on its own', () => {
    expect(folderNameIssues('页面', [NFC, NFD])).toEqual([
      { kind: 'unicode-conflict', folder: '页面', names: [NFC, NFD] },
      { kind: 'decomposed-name', relPath: `页面/${NFD}` },
    ]);
    expect(folderNameIssues('', [NFD])).toEqual([{ kind: 'decomposed-name', relPath: NFD }]);
    // A case difference on top of a normalisation difference is a case conflict.
    expect(folderNameIssues('', ['Café.html', NFD])[0]).toMatchObject({ kind: 'case-conflict' });
  });

  it('reports names Windows or macOS cannot represent', () => {
    const issues = folderNameIssues('a', ['what?.html', 'CON.txt', 'notes.', 'ok.html', `${'长'.repeat(90)}.html`]);
    expect(issues).toEqual([
      { kind: 'unportable-name', relPath: 'a/what?.html', problems: ['invalid-char'], invalidChars: ['?'] },
      { kind: 'unportable-name', relPath: 'a/CON.txt', problems: ['reserved-windows'], invalidChars: [] },
      { kind: 'unportable-name', relPath: 'a/notes.', problems: ['trailing-dot-or-space'], invalidChars: [] },
      { kind: 'unportable-name', relPath: `a/${'长'.repeat(90)}.html`, problems: ['too-long'], invalidChars: [] },
    ]);
  });

  it('never changes the names it was given', () => {
    const names = [NFD, 'A.html', 'a.html', 'b:c'];
    const copy = [...names];
    const issues = folderNameIssues('', names);
    expect(names).toEqual(copy);
    const reported = issues.flatMap((i) => ('names' in i ? i.names : [i.relPath]));
    for (const name of reported) expect(names).toContain(name);
  });
});

describe('sortIssues', () => {
  it('puts name problems first and line endings last, then by path', () => {
    const issues: PortabilityIssue[] = [
      { kind: 'mixed-eol', relPath: 'b.js' },
      { kind: 'case-conflict', folder: '', names: ['A', 'a'] },
      { kind: 'mixed-eol', relPath: 'a.js' },
      { kind: 'unportable-name', relPath: 'x?', problems: ['invalid-char'], invalidChars: ['?'] },
    ];
    expect(sortIssues(issues).map((i) => i.kind)).toEqual([
      'unportable-name',
      'case-conflict',
      'mixed-eol',
      'mixed-eol',
    ]);
    expect(sortIssues(issues).slice(2)).toEqual([
      { kind: 'mixed-eol', relPath: 'a.js' },
      { kind: 'mixed-eol', relPath: 'b.js' },
    ]);
  });
});
