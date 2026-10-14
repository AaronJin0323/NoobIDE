import { describe, expect, it } from 'vitest';
import { safeOrigin } from './harden';
import { selfTestRequested, withSelfTestQuery } from './self-test';

describe('self-test switches', () => {
  it('only runs with NOOBIDE_SELF_TEST=1', () => {
    expect(selfTestRequested({ NOOBIDE_SELF_TEST: '1' })).toBe(true);
    expect(selfTestRequested({ NOOBIDE_SELF_TEST: 'true' })).toBe(false);
    expect(selfTestRequested({})).toBe(false);
  });

  it('adds the query flag to app and dev URLs', () => {
    expect(withSelfTestQuery('noobide://app/index.html')).toBe('noobide://app/index.html?selftest=1');
    expect(withSelfTestQuery('http://localhost:5173/')).toBe('http://localhost:5173/?selftest=1');
  });
});

describe('safeOrigin (navigation guard)', () => {
  it('compares scheme + host, including the custom app scheme', () => {
    expect(safeOrigin('noobide://app/index.html#x')).toBe('noobide://app');
    expect(safeOrigin('http://localhost:5173/src/main.tsx')).toBe('http://localhost:5173');
    expect(safeOrigin('https://example.com/')).not.toBe('noobide://app');
    expect(safeOrigin('not a url')).toBe('invalid');
  });
});
