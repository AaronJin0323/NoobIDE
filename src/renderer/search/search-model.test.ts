import { describe, expect, it } from 'vitest';
import { translate, type Locale } from '../i18n/index';
import type { SearchResults } from '../../shared/ipc/search-contract';
import {
  DEFAULT_QUERY,
  flattenHits,
  moveHit,
  panelMessage,
  previewParts,
  splitPath,
  type SearchState,
} from './search-model';

const tr = (locale: Locale) => (key: Parameters<typeof translate>[1], count?: number) => translate(locale, key, count);
const query = { ...DEFAULT_QUERY, text: 'card' };
const match = (line: number, column: number) => ({ line, column, length: 4, preview: 'a card', previewStart: 2 });
const results = (files: SearchResults['files'], truncated = false): SearchResults => ({
  searchId: 1,
  files,
  totalMatches: files.reduce((n, f) => n + f.matches.length, 0),
  truncated,
  filesSearched: 10,
  skippedBinary: 0,
  skippedLarge: 0,
  durationMs: 5,
});
const file = (relPath: string, n: number) => ({
  relPath,
  source: 'disk' as const,
  fingerprint: 'x',
  matches: Array.from({ length: n }, (_, i) => match(i + 1, 3)),
});
const done = (r: SearchResults): SearchState => ({
  kind: 'done',
  results: r,
  query,
  projectId: '0f8fad5b-d9cb-469f-a165-70867728950e',
});

describe('find in files panel states (S51.3)', () => {
  it('explains the no-project, idle, searching and empty states in both languages', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      const t = tr(locale);
      expect(panelMessage(t, { kind: 'idle' }, query, false)).toMatchObject({ kind: 'no-project' });
      expect(panelMessage(t, { kind: 'idle' }, DEFAULT_QUERY, true)).toMatchObject({ kind: 'idle' });
      expect(panelMessage(t, { kind: 'searching', searchId: 2 }, query, true).kind).toBe('searching');
      const empty = panelMessage(t, done(results([])), query, true);
      expect(empty.kind).toBe('empty');
      expect(empty.text).toContain('card');
    }
    expect(panelMessage(tr('zh-CN'), { kind: 'idle' }, query, false).text).toBe(
      '打开一个项目文件夹后，就能在它的所有文件里查找。',
    );
    expect(panelMessage(tr('en'), done(results([])), query, true).text).toMatch(/^No results for “card”/);
  });

  it('names an invalid regular expression with the engine’s explanation', () => {
    const state: SearchState = { kind: 'failed', code: 'invalid-regex', message: 'Unterminated group' };
    expect(panelMessage(tr('en'), state, query, true)).toEqual({
      kind: 'invalid-regex',
      text: 'This regular expression is not valid: Unterminated group. To search for plain text, turn off “Use regular expression”.',
    });
    expect(panelMessage(tr('zh-CN'), state, query, true).text).toContain('正则表达式写得不对：Unterminated group');
  });

  it('summarises results with counts (English singular for one) and says when they are truncated', () => {
    expect(panelMessage(tr('en'), done(results([file('a.html', 1)])), query, true).text).toBe('1 result in 1 file');
    expect(panelMessage(tr('en'), done(results([file('a.html', 2), file('b.css', 1)])), query, true).text).toBe(
      '3 results in 2 files',
    );
    const zh = panelMessage(tr('zh-CN'), done(results([file('a.html', 2), file('b.css', 1)], true)), query, true);
    expect(zh.text).toBe('3 个结果，在 2 个文件里');
    expect(zh.truncated).toBe('结果太多，只列出了前 3 个。把要查找的文字写得更具体一些，就能看到全部。');
  });

  it('flattens results file by file and moves through them with the keys', () => {
    const hits = flattenHits(results([file('a.html', 2), file('子 文件夹/页面 二.html', 1)]));
    expect(hits.map((h) => h.key)).toEqual(['a.html:1:3', 'a.html:2:3', '子 文件夹/页面 二.html:1:3']);
    expect(moveHit(0, 3, 'ArrowDown')).toBe(1);
    expect(moveHit(2, 3, 'ArrowDown')).toBe(2);
    expect(moveHit(1, 3, 'ArrowUp')).toBe(0);
    expect(moveHit(1, 3, 'End')).toBe(2);
    expect(moveHit(1, 3, 'x')).toBeNull();
    expect(flattenHits(null)).toEqual([]);
  });

  it('splits paths and previews for display', () => {
    expect(splitPath('子 文件夹/页面 二.html')).toEqual({ folder: '子 文件夹/', name: '页面 二.html' });
    expect(splitPath('index.html')).toEqual({ folder: '', name: 'index.html' });
    expect(previewParts(match(1, 3))).toEqual({ before: 'a ', hit: 'card', after: '' });
  });
});
