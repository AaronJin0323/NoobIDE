import { describe, expect, it } from 'vitest';
import {
  INLINE_MAX_SUGGESTION_CHARS,
  INLINE_MAX_SUGGESTION_LINES,
  capSuggestion,
  fitToLine,
  postProcessSuggestion,
  stripMarkdownFences,
  trimSuffixOverlap,
} from './inline-postprocess';

describe('S32.1 suggestion clean-up', () => {
  it('strips Markdown fences the model added', () => {
    expect(stripMarkdownFences('```html\n<p>Hi</p>\n```')).toBe('<p>Hi</p>');
    expect(stripMarkdownFences('```\ncolor: red;\n```\n')).toBe('color: red;');
    expect(stripMarkdownFences('~~~js\nlet a = 1;\n~~~')).toBe('let a = 1;');
    expect(stripMarkdownFences('let a = 1;\n```')).toBe('let a = 1;');
    expect(stripMarkdownFences('let a = 1;')).toBe('let a = 1;');
  });

  it('keeps backticks that are code (template literals)', () => {
    expect(stripMarkdownFences('`hello ${name}`;')).toBe('`hello ${name}`;');
  });

  it('removes the overlap with the text after the cursor', () => {
    expect(trimSuffixOverlap('color: red;\n}', '\n}\n')).toBe('color: red;');
    expect(trimSuffixOverlap('Hello</p>', '</p>\n<p>next</p>')).toBe('Hello');
    expect(trimSuffixOverlap('a = 1;', ';')).toBe('a = 1');
    // The model wrote the closing tag again on its own line.
    expect(trimSuffixOverlap('\n  <li>Two</li>\n</ul>', '\n\n</ul>\n')).toBe('\n  <li>Two</li>');
    // Whitespace-only overlap is not a repetition.
    expect(trimSuffixOverlap('let a = 1;\n', '\n')).toBe('let a = 1;\n');
    expect(trimSuffixOverlap('Hello', '')).toBe('Hello');
  });

  it('caps lines and characters, cutting at a line end', () => {
    const many = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    expect(capSuggestion(many).split('\n')).toHaveLength(INLINE_MAX_SUGGESTION_LINES);
    const wide = Array.from({ length: 10 }, () => 'x'.repeat(500)).join('\n');
    const capped = capSuggestion(wide);
    expect(capped.length).toBeLessThanOrEqual(INLINE_MAX_SUGGESTION_CHARS);
    expect(capped.endsWith('x')).toBe(true);
    expect(capSuggestion('y'.repeat(5000)).length).toBe(INLINE_MAX_SUGGESTION_CHARS);
  });

  it('cleans a typical answer end to end', () => {
    const raw = '```html\n<h1>你好</h1>\r\n<p>欢迎</p>   \n</body>\n```';
    expect(postProcessSuggestion(raw, { prefix: '<body>\n', suffix: '\n</body>\n' })).toBe(
      '<h1>你好</h1>\n<p>欢迎</p>',
    );
  });

  it('drops a repeated start of the current line', () => {
    expect(postProcessSuggestion('  color: red;', { prefix: 'p {\n  color', suffix: '' })).toBe(': red;');
    expect(postProcessSuggestion('  color: red;', { prefix: 'p {\n  ', suffix: '' })).toBe('  color: red;');
    expect(postProcessSuggestion('let total = 0;', { prefix: 'let total', suffix: '' })).toBe(' = 0;');
  });

  it('returns null for an empty or whitespace answer', () => {
    expect(postProcessSuggestion('', { prefix: 'a', suffix: '' })).toBeNull();
    expect(postProcessSuggestion('  \n\n', { prefix: 'a', suffix: '' })).toBeNull();
    expect(postProcessSuggestion('```\n```', { prefix: 'a', suffix: '' })).toBeNull();
    expect(postProcessSuggestion('</p>', { prefix: '<p>Hi', suffix: '</p>' })).toBeNull();
  });

  it('keeps a multi-line suggestion only when nothing follows the cursor on its line', () => {
    expect(fitToLine('a\nb', '')).toBe('a\nb');
    expect(fitToLine('Hello\n<p>more</p>', '</p>')).toBe('Hello');
    expect(fitToLine('\n<p>more</p>', '</p>')).toBeNull();
    expect(fitToLine('one line', '</p>')).toBe('one line');
  });
});
