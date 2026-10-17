import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INDENT,
  convertIndentation,
  detectIndentation,
  projectConvention,
  reindentPasted,
  resolveIndentation,
  type IndentGuess,
} from './indent-detect';

const FIXTURES = join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'indentation');

interface Expected {
  readonly language: string;
  readonly insertSpaces: boolean;
  readonly tabSize: number;
  readonly confidence: IndentGuess['confidence'];
  readonly mixed?: boolean;
}

const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as Record<string, Expected>;

const guess = (over: Partial<IndentGuess> = {}): IndentGuess => ({
  insertSpaces: true,
  tabSize: 4,
  confidence: 'high',
  mixed: false,
  evidence: 20,
  ...over,
});

describe('detectIndentation fixtures (S43.1)', () => {
  it('has at least 16 fixtures', () => {
    expect(Object.keys(expected).length).toBeGreaterThanOrEqual(16);
  });

  it('keeps the CRLF fixture bytes', () => {
    expect(readFileSync(join(FIXTURES, 'crlf-js-4-spaces.js'), 'utf8')).toContain('\r\n');
  });

  it.each(Object.entries(expected))('%s', (name, want) => {
    const text = readFileSync(join(FIXTURES, name), 'utf8');
    const got = detectIndentation(text, want.language);
    expect({ insertSpaces: got.insertSpaces, tabSize: got.tabSize, confidence: got.confidence }).toEqual({
      insertSpaces: want.insertSpaces,
      tabSize: want.tabSize,
      confidence: want.confidence,
    });
    expect(got.mixed).toBe(want.mixed ?? false);
  });
});

describe('detectIndentation rules', () => {
  it('returns the default with confidence none for empty and nearly empty text', () => {
    expect(detectIndentation('', 'javascript')).toEqual({
      ...DEFAULT_INDENT,
      confidence: 'none',
      mixed: false,
      evidence: 0,
    });
    expect(detectIndentation('a {\n    b: 1;\n}\n', 'css')).toMatchObject({
      ...DEFAULT_INDENT,
      confidence: 'none',
      evidence: 1,
    });
  });

  it('is not fooled by JSDoc continuation lines', () => {
    const doc = ['/**', ' * a', ' * b', ' * c', ' * d', ' * e', ' * f', ' */', 'x();'].join('\n');
    expect(detectIndentation(doc, 'javascript').confidence).toBe('none');
  });

  it('counts a tab-led line with alignment spaces as a tab line', () => {
    const text = ['f(', '\t  a,', '\t  b,', '\t  c,', '\t  d,', '\t  e,', '\t  f', ')'].join('\n');
    expect(detectIndentation(text, 'javascript')).toMatchObject({ insertSpaces: false, mixed: false, evidence: 6 });
  });

  it('prefers 4 when deltas are 4, and 2 when nesting jumps by 4 only occasionally', () => {
    const four = ['a {', '    b {', '        c;', '        d;', '    }', '    e;', '    f;', '}'].join('\n');
    expect(detectIndentation(four, 'css').tabSize).toBe(4);
    const twoWithJump = ['a {', '  b {', '    c;', '      d;', '        e;', '  }', '  f;', '      g;', '}'].join('\n');
    expect(detectIndentation(twoWithJump, 'javascript').tabSize).toBe(2);
  });

  it('chooses 8 only when nothing smaller fits', () => {
    const eight = [
      'a {',
      '        b {',
      '                c;',
      '        }',
      '        d;',
      '        e;',
      '        f;',
      '}',
    ].join('\n');
    expect(detectIndentation(eight, 'javascript').tabSize).toBe(8);
  });

  it('treats other language ids like JavaScript', () => {
    const text = [
      '{',
      '    "a": 1,',
      '    "b": {',
      '        "c": 2,',
      '        "e": 5',
      '    },',
      '    "d": 3',
      '}',
    ].join('\n');
    expect(detectIndentation(text, 'json')).toMatchObject({ insertSpaces: true, tabSize: 4, confidence: 'high' });
  });
});

describe('projectConvention', () => {
  it('needs at least two agreeing high guesses', () => {
    expect(projectConvention([])).toBeNull();
    expect(projectConvention([guess()])).toBeNull();
    expect(projectConvention([guess(), guess()])).toEqual({ insertSpaces: true, tabSize: 4 });
  });

  it('ignores low and none guesses', () => {
    expect(projectConvention([guess(), guess({ confidence: 'low' }), guess({ confidence: 'none' })])).toBeNull();
  });

  it('takes the majority and requires both insertSpaces and tabSize to agree', () => {
    const spaces2 = guess({ tabSize: 2 });
    const tabs4 = guess({ insertSpaces: false });
    expect(projectConvention([spaces2, spaces2, spaces2, guess(), tabs4])).toEqual({ insertSpaces: true, tabSize: 2 });
    expect(projectConvention([guess(), tabs4])).toBeNull();
  });

  it('returns null on a tie', () => {
    const spaces2 = guess({ tabSize: 2 });
    expect(projectConvention([spaces2, spaces2, guess(), guess()])).toBeNull();
  });
});

describe('resolveIndentation', () => {
  const project = { insertSpaces: false, tabSize: 4 };
  const override = { insertSpaces: true, tabSize: 8 };

  it('an override wins over everything', () => {
    expect(resolveIndentation({ guess: guess({ mixed: true }), override, project })).toEqual({
      insertSpaces: true,
      tabSize: 8,
      source: 'override',
      mixed: true,
    });
  });

  it('a high guess wins over the project', () => {
    expect(resolveIndentation({ guess: guess({ tabSize: 2 }), override: null, project })).toEqual({
      insertSpaces: true,
      tabSize: 2,
      source: 'detected',
      mixed: false,
    });
  });

  it('the project wins over a low or missing guess', () => {
    expect(resolveIndentation({ guess: guess({ confidence: 'low' }), project })).toMatchObject({
      ...project,
      source: 'project',
    });
    expect(resolveIndentation({ guess: guess({ confidence: 'none' }), project })).toMatchObject({ source: 'project' });
  });

  it('a low guess is used without a project convention', () => {
    expect(resolveIndentation({ guess: guess({ confidence: 'low', tabSize: 4 }), project: null })).toMatchObject({
      insertSpaces: true,
      tabSize: 4,
      source: 'detected',
    });
  });

  it('falls back to the template default', () => {
    expect(resolveIndentation({ guess: guess({ confidence: 'none', tabSize: 8 }) })).toEqual({
      ...DEFAULT_INDENT,
      source: 'default',
      mixed: false,
    });
  });
});

describe('reindentPasted', () => {
  const spaces2 = { insertSpaces: true, tabSize: 2 };
  const spaces4 = { insertSpaces: true, tabSize: 4 };
  const tabs = { insertSpaces: false, tabSize: 4 };

  it('tabs to 2 spaces', () => {
    expect(reindentPasted('if (a) {\n\tb();\n\tif (c) {\n\t\td();\n\t}\n}', spaces2)).toBe(
      'if (a) {\n  b();\n  if (c) {\n    d();\n  }\n}',
    );
  });

  it('4 spaces to tabs', () => {
    expect(reindentPasted('if (a) {\n    b();\n        c();\n}', tabs)).toBe('if (a) {\n\tb();\n\t\tc();\n}');
  });

  it('4 spaces to 2 spaces, keeping alignment remainders', () => {
    const pasted =
      'f({\n    a: [\n        1,\n    ],\n    b: {\n        c: [\n            3,\n              4,\n        ],\n    },\n});';
    expect(reindentPasted(pasted, spaces2)).toBe(
      'f({\n  a: [\n    1,\n  ],\n  b: {\n    c: [\n      3,\n        4,\n    ],\n  },\n});',
    );
  });

  it('leaves the first line alone and keeps CRLF line breaks', () => {
    expect(reindentPasted('    a {\r\n        b;\r\n    }\r\n', spaces2)).toBe('    a {\r\n    b;\r\n  }\r\n');
  });

  it('never changes non-whitespace characters, including Chinese text', () => {
    const pasted = '<ul>\n\t<li>苹果 \t 香蕉</li>\n\t<li>  中文  </li>\n</ul>';
    const out = reindentPasted(pasted, spaces4);
    expect(out).toBe('<ul>\n    <li>苹果 \t 香蕉</li>\n    <li>  中文  </li>\n</ul>');
    expect(out?.replace(/^[ \t]+/gm, '')).toBe(pasted.replace(/^[ \t]+/gm, ''));
  });

  it('uses the leading whitespace of a single indented line as the unit', () => {
    expect(reindentPasted('x\n    y', spaces2)).toBe('x\n  y');
  });

  it('returns null when nothing would change', () => {
    expect(reindentPasted('a {\n  b;\n    c;\n}', spaces2)).toBeNull();
    expect(reindentPasted('a {\n\tb;\n}', tabs)).toBeNull();
    expect(reindentPasted('a\nb\n\nc', spaces2)).toBeNull();
    expect(reindentPasted('    one line', spaces2)).toBeNull();
  });
});

// The 5 000-line timing budget of detectIndentation lives in tests/perf/indent-detect.perf.test.ts (S50.3).

describe('reindentPasted safety (S43.2 review)', () => {
  const spaces2 = { insertSpaces: true, tabSize: 2 };
  const spaces4 = { insertSpaces: true, tabSize: 4 };

  it.each([
    ['<pre> content', '<pre>\n\tdef f():\n\t\treturn 1\n</pre>'],
    ['<textarea> content', '<textarea>\n\tline\n</textarea>'],
    ['a template literal', 'const html = `\n\t<p>hi</p>\n`;'],
    ['a block comment', 'f();\n/*\n\tnote\n*/'],
    ['JSDoc lines', '/**\n * Adds.\n */\nfunction add() {\n\treturn 1;\n}'],
    ['an HTML comment', '<!--\n\tnote\n-->\n<p>\n\tx\n</p>'],
  ])('leaves %s alone (whitespace can matter there)', (_name, pasted) => {
    expect(reindentPasted(pasted, spaces2)).toBeNull();
  });

  it('does not guess levels of 3-space code', () => {
    expect(reindentPasted('a {\n   b;\n      c;\n   }\n}', spaces4)).toBeNull();
  });

  it('converts the first line too when the paste started at column 1', () => {
    const pasted = '    if (x) {\n        y();\n    }';
    expect(reindentPasted(pasted, spaces2)).toBe('    if (x) {\n    y();\n  }');
    expect(reindentPasted(pasted, spaces2, { includeFirstLine: true })).toBe('  if (x) {\n    y();\n  }');
  });
});

describe('convertIndentation (S43.2 convert the file)', () => {
  const apply = (text: string, edits: ReturnType<typeof convertIndentation>) => {
    const lines = text.split('\n');
    for (const e of edits) lines[e.line - 1] = e.text + (lines[e.line - 1] ?? '').slice(e.oldLength);
    return lines.join('\n');
  };
  const four = 'a {\n    b {\n        c;\n    }\n\n      d; // aligned\n}';

  it('4 spaces → 2 spaces, level by level, alignment kept', () => {
    const edits = convertIndentation(four, { insertSpaces: true, tabSize: 4 }, { insertSpaces: true, tabSize: 2 });
    expect(apply(four, edits)).toBe('a {\n  b {\n    c;\n  }\n\n    d; // aligned\n}');
  });

  it('spaces → tabs and tabs → spaces', () => {
    const toTabs = convertIndentation(four, { insertSpaces: true, tabSize: 4 }, { insertSpaces: false, tabSize: 4 });
    expect(apply(four, toTabs)).toBe('a {\n\tb {\n\t\tc;\n\t}\n\n\t  d; // aligned\n}');
    const tabbed = 'x {\n\ty;\n\t\tz;\n}';
    const back = convertIndentation(tabbed, { insertSpaces: false, tabSize: 4 }, { insertSpaces: true, tabSize: 2 });
    expect(apply(tabbed, back)).toBe('x {\n  y;\n    z;\n}');
  });

  it('returns only changed lines; blank and unindented lines are untouched', () => {
    const edits = convertIndentation(four, { insertSpaces: true, tabSize: 4 }, { insertSpaces: true, tabSize: 4 });
    expect(edits).toEqual([]);
    const lines = convertIndentation(
      'a\n\n   \nb',
      { insertSpaces: true, tabSize: 4 },
      { insertSpaces: false, tabSize: 4 },
    );
    expect(lines).toEqual([]);
  });
});
