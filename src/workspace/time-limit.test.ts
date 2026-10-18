import { describe, expect, it } from 'vitest';
import { runWithTimeLimit } from './time-limit';

describe('runWithTimeLimit (S51.6)', () => {
  it('returns the value of code that finishes in time', () => {
    expect(runWithTimeLimit(() => 'card'.toUpperCase(), 100)).toEqual({ ok: true, value: 'CARD' });
    expect(runWithTimeLimit(() => /c(a)rd/.exec('a card')?.[1], 100)).toEqual({ ok: true, value: 'a' });
  });

  it('stops a catastrophically backtracking regular expression after the limit', () => {
    const started = performance.now();
    const result = runWithTimeLimit(() => /(a+)+$/u.test(`${'a'.repeat(40)}!`), 50);
    const elapsed = performance.now() - started;
    expect(result).toEqual({ ok: false });
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(1000);
  });

  it('lets other errors through and keeps working after a timeout', () => {
    expect(() =>
      runWithTimeLimit(() => {
        throw new RangeError('boom');
      }, 100),
    ).toThrow('boom');
    expect(runWithTimeLimit(() => /(a+)+$/.test(`${'a'.repeat(40)}!`), 20)).toEqual({ ok: false });
    expect(runWithTimeLimit(() => 1 + 1, 100)).toEqual({ ok: true, value: 2 });
  });
});
