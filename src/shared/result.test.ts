import { describe, expect, it } from 'vitest';
import { attempt, err, ok } from './result';

describe('result', () => {
  it('wraps values', () => {
    expect(ok(3)).toEqual({ ok: true, value: 3 });
  });

  it('keeps the original cause on failure', () => {
    const cause = new Error('EACCES');
    expect(err('write-denied', 'Permission denied', cause)).toEqual({
      ok: false,
      code: 'write-denied',
      message: 'Permission denied',
      cause,
    });
  });

  it('omits cause when none is given', () => {
    expect('cause' in err('x', 'y')).toBe(false);
  });

  it('converts thrown errors from async operations', async () => {
    const r = await attempt('read-failed', async () => {
      throw new Error('ENOENT: no such file');
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('read-failed');
      expect(r.message).toContain('ENOENT');
    }
  });

  it('passes through successful async results', async () => {
    expect(await attempt('read-failed', async () => '内容')).toEqual({ ok: true, value: '内容' });
  });
});
