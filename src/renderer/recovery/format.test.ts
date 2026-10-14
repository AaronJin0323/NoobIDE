import { describe, expect, it } from 'vitest';
import { fill, formatBytes } from './format';

describe('recovery formatting', () => {
  it('fills placeholders and leaves unknown ones', () => {
    expect(fill('{n} 个文件 {x}', { n: 3 })).toBe('3 个文件 {x}');
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(256 * 1024 * 1024)).toBe('256.0 MB');
  });
});
