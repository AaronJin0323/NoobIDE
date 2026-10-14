import { describe, expect, it } from 'vitest';
import { platformId, quitsWhenLastWindowCloses, recreatesWindowOnActivate } from './index';

describe('platform adapter', () => {
  it('maps Node platform ids to the two supported platforms', () => {
    expect(platformId('darwin')).toBe('mac');
    expect(platformId('win32')).toBe('windows');
    expect(platformId('linux')).toBe('other');
  });

  it('follows each platform window-lifecycle convention (PLAN §3)', () => {
    expect(quitsWhenLastWindowCloses('win32')).toBe(true);
    expect(quitsWhenLastWindowCloses('darwin')).toBe(false);
    expect(recreatesWindowOnActivate('darwin')).toBe(true);
    expect(recreatesWindowOnActivate('win32')).toBe(false);
  });
});
