import { describe, expect, it } from 'vitest';
import { isListedEntry } from './listing-filter';

describe('listing filter', () => {
  it('hides dotfiles, dot-folders and node_modules; keeps ordinary names', () => {
    expect(isListedEntry('.env', false)).toBe(false);
    expect(isListedEntry('.git', true)).toBe(false);
    expect(isListedEntry('node_modules', true)).toBe(false);
    expect(isListedEntry('node_modules', false)).toBe(true);
    expect(isListedEntry('页面 二.html', false)).toBe(true);
    expect(isListedEntry('子 文件夹', true)).toBe(true);
  });
});
