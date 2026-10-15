import { describe, expect, it } from 'vitest';
import {
  INLINE_MAX_FILE_CHARS,
  INLINE_MAX_PREFIX_CHARS,
  INLINE_MAX_SUFFIX_CHARS,
  boundedContext,
  editorBlockReason,
  statusBlockReason,
  type EditorFacts,
} from './inline-context';
import { STATUS } from './fake-ai-bridge.test-util';

const FACTS: EditorFacts = {
  target: { projectId: 'p1', relPath: 'index.html', readOnly: false },
  languageId: 'html',
  fileLength: 100,
  cursorCount: 1,
  hasSelection: false,
  charAfterCursor: '',
};

describe('S32.1 status gate: no request without AI, inline, key or consent', () => {
  it('allows a configured, consented project', () => {
    expect(statusBlockReason(STATUS)).toBeNull();
  });
  it('blocks without a bridge / status', () => {
    expect(statusBlockReason(null)).toBe('no-bridge');
  });
  it('blocks when AI is off', () => {
    expect(statusBlockReason({ ...STATUS, config: { ...STATUS.config, enabled: false } })).toBe('ai-off');
  });
  it('blocks when inline suggestions are off', () => {
    expect(statusBlockReason({ ...STATUS, config: { ...STATUS.config, inlineCompletions: false } })).toBe('inline-off');
  });
  it('blocks without a key for the chosen provider, or without a provider', () => {
    expect(statusBlockReason({ ...STATUS, keyStored: { anthropic: false, openai: true } })).toBe('no-key');
    expect(statusBlockReason({ ...STATUS, config: { ...STATUS.config, provider: null } })).toBe('no-key');
  });
  it('blocks without consent for the project', () => {
    expect(statusBlockReason({ ...STATUS, projectConsent: false })).toBe('no-consent');
  });
});

describe('S32.1 editor gate', () => {
  it('allows one empty cursor in an editable HTML, CSS or JS file', () => {
    for (const languageId of ['html', 'css', 'javascript']) {
      expect(editorBlockReason({ ...FACTS, languageId })).toBeNull();
    }
  });
  it('blocks the welcome sample (no project file)', () => {
    expect(editorBlockReason({ ...FACTS, target: null })).toBe('no-project');
  });
  it('blocks read-only and non-UTF-8 files', () => {
    expect(editorBlockReason({ ...FACTS, target: { ...FACTS.target!, readOnly: true } })).toBe('read-only');
    expect(editorBlockReason({ ...FACTS, target: { ...FACTS.target!, readOnly: true, encoding: 'gb18030' } })).toBe(
      'encoding',
    );
  });
  it('blocks other languages', () => {
    expect(editorBlockReason({ ...FACTS, languageId: 'json' })).toBe('language');
    expect(editorBlockReason({ ...FACTS, languageId: 'plaintext' })).toBe('language');
  });
  it('blocks files over the size limit', () => {
    expect(editorBlockReason({ ...FACTS, fileLength: INLINE_MAX_FILE_CHARS })).toBeNull();
    expect(editorBlockReason({ ...FACTS, fileLength: INLINE_MAX_FILE_CHARS + 1 })).toBe('too-large');
  });
  it('blocks multiple cursors and selections', () => {
    expect(editorBlockReason({ ...FACTS, cursorCount: 2 })).toBe('multiple-cursors');
    expect(editorBlockReason({ ...FACTS, hasSelection: true })).toBe('selection');
  });
  it('blocks in the middle of a word, including Chinese text, but not before punctuation or space', () => {
    expect(editorBlockReason({ ...FACTS, charAfterCursor: 'a' })).toBe('mid-word');
    expect(editorBlockReason({ ...FACTS, charAfterCursor: '中' })).toBe('mid-word');
    for (const next of ['', ' ', '<', ')', ';', '"', '}']) {
      expect(editorBlockReason({ ...FACTS, charAfterCursor: next })).toBeNull();
    }
  });
});

describe('S32.1 bounded prefix / suffix', () => {
  it('sends the whole text when it is within the limits', () => {
    const text = '<p>\n  Hello\n</p>\n';
    expect(boundedContext(text, 8)).toEqual({ prefix: '<p>\n  He', suffix: 'llo\n</p>\n' });
  });
  it('never sends more than the limits', () => {
    const text = 'x'.repeat(50_000);
    const { prefix, suffix } = boundedContext(text, 25_000);
    expect(prefix.length).toBe(INLINE_MAX_PREFIX_CHARS);
    expect(suffix.length).toBe(INLINE_MAX_SUFFIX_CHARS);
  });
  it('starts the prefix at a line start and ends the suffix at a line end when it cuts', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i).padStart(3, '0')} ${'.'.repeat(40)}`);
    const text = lines.join('\n');
    const at = text.indexOf('line 050') + 4;
    const { prefix, suffix } = boundedContext(text, at, { prefix: 200, suffix: 100 });
    expect(prefix.length).toBeLessThanOrEqual(200);
    expect(suffix.length).toBeLessThanOrEqual(100);
    expect(prefix.startsWith('line ')).toBe(true);
    expect(prefix.endsWith('line')).toBe(true);
    expect(suffix.endsWith('\n')).toBe(true);
    expect(text.slice(at - prefix.length, at + suffix.length)).toBe(prefix + suffix);
  });
  it('cuts by characters inside one very long line', () => {
    const text = 'a'.repeat(10) + 'b'.repeat(10);
    expect(boundedContext(text, 10, { prefix: 4, suffix: 3 })).toEqual({ prefix: 'aaaa', suffix: 'bbb' });
  });
  it('never splits a surrogate pair', () => {
    const emoji = '😀'; // two UTF-16 code units
    const text = emoji.repeat(10);
    const { prefix, suffix } = boundedContext(text, 10, { prefix: 5, suffix: 5 });
    expect(prefix).toBe(emoji.repeat(2));
    expect(suffix).toBe(emoji.repeat(2));
  });
  it('clamps an offset outside the text', () => {
    expect(boundedContext('abc', 99)).toEqual({ prefix: 'abc', suffix: '' });
    expect(boundedContext('abc', -1)).toEqual({ prefix: '', suffix: 'abc' });
  });
  it('keeps Chinese text and spaces intact', () => {
    const text = '<h1>你好 世界</h1>\n<p>欢迎</p>';
    const at = text.indexOf('世界');
    expect(boundedContext(text, at)).toEqual({ prefix: '<h1>你好 ', suffix: '世界</h1>\n<p>欢迎</p>' });
  });
});
