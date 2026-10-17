import { describe, expect, it } from 'vitest';
import {
  buildQueryRegex,
  expandReplacement,
  lineMatches,
  matchKey,
  replaceInText,
  replacementForMatch,
  splitLines,
  textFingerprint,
  type SearchQuery,
} from './search';

const q = (text: string, options: Partial<SearchQuery> = {}): SearchQuery => ({
  text,
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  ...options,
});

const columns = (line: string, query: SearchQuery) => {
  const built = buildQueryRegex(query);
  if (!built.ok) throw new Error(built.message);
  return [...lineMatches(line, built.regex)].map((m) => [m.index + 1, m.length]);
};

describe('search queries (S51.2)', () => {
  it('escapes literal text, including regex syntax', () => {
    expect(columns('a.b axb (x)', q('a.b'))).toEqual([[1, 3]]);
    expect(columns('price: $5 (x+1)', q('(x+1)'))).toEqual([[11, 5]]);
    expect(columns('a-b a\\b', q('a\\b'))).toEqual([[5, 3]]);
  });

  it('matches case-insensitively unless asked, also in Chinese text', () => {
    expect(columns('Card card CARD', q('card'))).toEqual([
      [1, 4],
      [6, 4],
      [11, 4],
    ]);
    expect(columns('Card card CARD', q('card', { caseSensitive: true }))).toEqual([[6, 4]]);
    expect(columns('你好，我是林小雨', q('小雨'))).toEqual([[7, 2]]);
  });

  it('whole word skips matches inside longer words of any script', () => {
    expect(columns('card cards .card-title my_card', q('card', { wholeWord: true }))).toEqual([
      [1, 4],
      [13, 4],
    ]);
    expect(columns('小雨 林小雨', q('小雨', { wholeWord: true }))).toEqual([[1, 2]]);
  });

  it('compiles regular expressions and reports invalid ones as a message, never a throw', () => {
    expect(columns('id="a1" id="b22"', q('id="(\\w+)"', { regex: true }))).toEqual([
      [1, 7],
      [9, 8],
    ]);
    expect(columns('颜色 color', q('\\p{Script=Han}+', { regex: true }))).toEqual([[1, 2]]);
    // A pattern written for engines without the u flag still works (identity escape).
    expect(columns('a-b', q('a\\-b', { regex: true }))).toEqual([[1, 3]]);
    const invalid = buildQueryRegex(q('(unclosed', { regex: true }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.message).toMatch(/Invalid regular expression/);
    expect(buildQueryRegex(q('[z-a]', { regex: true })).ok).toBe(false);
    expect(buildQueryRegex(q('')).ok).toBe(false);
  });

  it('skips empty matches without looping', () => {
    expect(columns('baaab', q('a*', { regex: true }))).toEqual([[2, 3]]);
    expect(columns('😀😀', q('x*', { regex: true }))).toEqual([]);
    expect(columns('', q('^', { regex: true }))).toEqual([]);
  });

  it('splits lines keeping every kind of line break', () => {
    expect(splitLines('a\r\nb\nc\rd')).toEqual({ lines: ['a', 'b', 'c', 'd'], separators: ['\r\n', '\n', '\r', ''] });
    expect(splitLines('x\n')).toEqual({ lines: ['x', ''], separators: ['\n', ''] });
  });
});

describe('replacing (S51.4)', () => {
  it('replaces every match or only the chosen ones, keeping line endings', () => {
    const text = '.card {}\r\n.card-title {}\r\n';
    expect(replaceInText(text, q('card'), 'panel', null)).toEqual({
      text: '.panel {}\r\n.panel-title {}\r\n',
      replaced: 2,
    });
    expect(replaceInText(text, q('card'), 'panel', new Set([matchKey(2, 2)]))).toEqual({
      text: '.card {}\r\n.panel-title {}\r\n',
      replaced: 1,
    });
  });

  it('expands $1, $&, $<name> and $$ in regex mode only', () => {
    const regex = q('id="(?<name>\\w+)"', { regex: true });
    expect(replaceInText('<p id="intro">', regex, 'class="$1"', null)?.text).toBe('<p class="intro">');
    expect(replaceInText('<p id="intro">', regex, '[$<name>] $& $$', null)?.text).toBe('<p [intro] id="intro" $>');
    expect(replaceInText('cost', q('cost'), '$1 $&', null)?.text).toBe('$1 $&');
    const match = /(a)(b)/.exec('ab') as RegExpExecArray;
    expect(expandReplacement('$10|$2|$3', match, true)).toBe('a0|b|$3');
  });

  it('previews what one listed match becomes, with captured groups', () => {
    const regex = q('class="(\\w+)"', { regex: true });
    expect(replacementForMatch(regex, 'id="$1"', '<p class="intro">', 3)).toBe('id="intro"');
    expect(replacementForMatch(q('card'), 'panel', 'a card', 2)).toBe('panel');
    expect(replacementForMatch(q('card'), 'panel', 'a card', 0)).toBeNull();
    expect(replacementForMatch(q('(', { regex: true }), 'x', '(', 0)).toBeNull();
  });

  it('returns null for an invalid query', () => {
    expect(replaceInText('x', q('(', { regex: true }), 'y', null)).toBeNull();
  });
});

describe('text fingerprint', () => {
  it('ignores line endings and changes with the content', () => {
    expect(textFingerprint('a\r\nb')).toBe(textFingerprint('a\nb'));
    expect(textFingerprint('a\nb')).not.toBe(textFingerprint('a\nc'));
    expect(textFingerprint('')).not.toBe(textFingerprint(' '));
  });
});
