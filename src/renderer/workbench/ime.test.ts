import { describe, expect, it } from 'vitest';
import { isImeKey } from './ime';

describe('IME keyboard ownership', () => {
  it('protects composition and its boundary key even when isComposing is false', () => {
    expect(isImeKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true);
  });
  it('leaves ordinary Enter, Escape and shortcuts available', () => {
    for (const keyCode of [13, 27, 73]) expect(isImeKey({ isComposing: false, keyCode })).toBe(false);
  });
});
