import { describe, expect, it } from 'vitest';
import { MAX_VISIBLE_LOG_ENTRIES, appendLogBatch, EMPTY_LOG } from './preview-model';
import {
  foldForSearch,
  lineMatches,
  lineToText,
  linesToText,
  searchLines,
  type ConsoleLineWords,
} from './console-model';

const row = (text: string, extra: Partial<ConsoleLineWords> = {}): ConsoleLineWords => ({
  level: '信息',
  text,
  ...extra,
});

describe('console search (S49.4)', () => {
  it('ignores upper and lower case', () => {
    expect(lineMatches(row('Uncaught TypeError: x is undefined'), 'typeerror')).toBe(true);
    expect(lineMatches(row('hello'), 'HELLO')).toBe(true);
    expect(lineMatches(row('hello'), 'bye')).toBe(false);
  });

  it('finds Chinese text and folds full-width letters', () => {
    expect(lineMatches(row('按钮被点击了'), '点击')).toBe(true);
    expect(lineMatches(row('按钮被点击了'), '双击')).toBe(false);
    expect(lineMatches(row('ＡＢＣ 测试'), 'abc')).toBe(true);
    expect(foldForSearch('Ｈｅｌｌｏ')).toBe('hello');
  });

  it('matches the detail and the place, not the level word', () => {
    expect(lineMatches(row('x', { where: 'app.js:3' }), 'APP.JS')).toBe(true);
    expect(lineMatches(row('x', { detail: 'net::ERR_FILE_NOT_FOUND' }), 'err_file')).toBe(true);
    expect(lineMatches(row('x'), '信息')).toBe(false);
  });

  it('an empty or blank query keeps every row, in order', () => {
    const rows = [row('a'), row('b')];
    expect(searchLines(rows, '', (r) => r)).toEqual(rows);
    expect(searchLines(rows, '   ', (r) => r)).toEqual(rows);
    expect(searchLines(rows, ' B ', (r) => r)).toEqual([rows[1]]);
  });

  it('works on the 200-line window without changing it', () => {
    let log = EMPTY_LOG;
    for (let i = 0; i < 250; i += 1)
      log = appendLogBatch(log, [{ source: 'console', level: 'info', message: `line ${i}`, at: i }], 0);
    expect(log.entries).toHaveLength(MAX_VISIBLE_LOG_ENTRIES);
    const found = searchLines(log.entries, 'LINE 24', (e) => row(e.message));
    expect(found.map((e) => e.message)).toEqual([
      'line 240',
      'line 241',
      'line 242',
      'line 243',
      'line 244',
      'line 245',
      'line 246',
      'line 247',
      'line 248',
      'line 249',
    ]);
    expect(log.entries).toHaveLength(MAX_VISIBLE_LOG_ENTRIES);
  });
});

describe('console copy (S49.4)', () => {
  it('copies a line as the words shown: level, older tag, text, detail, place', () => {
    expect(lineToText(row('hi'))).toBe('信息  hi');
    expect(lineToText({ level: 'Error', text: 'boom', where: 'app.js:3' })).toBe('Error  boom  (app.js:3)');
    expect(lineToText({ level: 'Error', older: 'Before refresh', text: 'boom', detail: '(404)' })).toBe(
      'Error Before refresh  boom (404)',
    );
  });

  it('copies all visible rows one per line, oldest first', () => {
    expect(linesToText([row('a'), row('b', { where: 'x.js' })])).toBe('信息  a\n信息  b  (x.js)');
    expect(linesToText([])).toBe('');
  });
});
