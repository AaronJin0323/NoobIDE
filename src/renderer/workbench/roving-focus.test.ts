import { describe, expect, it } from 'vitest';
import { ROVING_ITEMS, rovingStop, rovingTarget } from './roving-focus';

describe('rovingTarget (S49.2)', () => {
  it('moves with the arrows of a horizontal group and ignores the others', () => {
    expect(rovingTarget('ArrowRight', 0, 3)).toBe(1);
    expect(rovingTarget('ArrowLeft', 2, 3)).toBe(1);
    expect(rovingTarget('ArrowDown', 0, 3)).toBeNull();
    expect(rovingTarget('ArrowUp', 1, 3)).toBeNull();
  });

  it('moves with up/down in a vertical group and all four arrows in "both"', () => {
    const vertical = { orientation: 'vertical' } as const;
    expect(rovingTarget('ArrowDown', 0, 3, vertical)).toBe(1);
    expect(rovingTarget('ArrowUp', 1, 3, vertical)).toBe(0);
    expect(rovingTarget('ArrowRight', 0, 3, vertical)).toBeNull();
    const both = { orientation: 'both' } as const;
    expect(rovingTarget('ArrowRight', 0, 3, both)).toBe(1);
    expect(rovingTarget('ArrowDown', 1, 3, both)).toBe(2);
  });

  it('Home/PageUp jump to the first item, End/PageDown to the last', () => {
    expect(rovingTarget('Home', 2, 4)).toBe(0);
    expect(rovingTarget('PageUp', 2, 4)).toBe(0);
    expect(rovingTarget('End', 0, 4)).toBe(3);
    expect(rovingTarget('PageDown', 0, 4)).toBe(3);
  });

  it('wraps by default and stops at the ends without loop', () => {
    expect(rovingTarget('ArrowRight', 2, 3)).toBe(0);
    expect(rovingTarget('ArrowLeft', 0, 3)).toBe(2);
    expect(rovingTarget('ArrowRight', 2, 3, { loop: false })).toBe(2);
    expect(rovingTarget('ArrowLeft', 0, 3, { loop: false })).toBe(0);
  });

  it('swaps the horizontal arrows in a right-to-left layout, not the vertical ones', () => {
    expect(rovingTarget('ArrowRight', 1, 3, { rtl: true })).toBe(0);
    expect(rovingTarget('ArrowLeft', 1, 3, { rtl: true })).toBe(2);
    expect(rovingTarget('ArrowDown', 1, 3, { orientation: 'both', rtl: true })).toBe(2);
  });

  it('leaves Tab, Enter, Space and letters to the page; an empty group handles nothing', () => {
    for (const key of ['Tab', 'Enter', ' ', 'a', 'Escape']) expect(rovingTarget(key, 0, 3)).toBeNull();
    expect(rovingTarget('ArrowRight', 0, 0)).toBeNull();
    expect(rovingTarget('Home', 0, 0)).toBeNull();
  });

  it('clamps a stale index (an item vanished) before moving', () => {
    expect(rovingTarget('ArrowLeft', 7, 3)).toBe(1);
    expect(rovingTarget('ArrowRight', -1, 3)).toBe(1);
  });
});

describe('rovingStop (S49.2)', () => {
  const items = (pressed: number) => [0, 1, 2].map((i) => ({ pressed: i === pressed }));

  it('keeps the last focused item as the only tab stop', () => {
    expect(rovingStop(items(0), 2)).toBe(2);
  });

  it('falls back to the pressed item, then the first', () => {
    expect(rovingStop(items(1), -1)).toBe(1);
    expect(rovingStop(items(1), 5)).toBe(1); // the focused item is gone
    expect(rovingStop(items(-1), -1)).toBe(0);
    expect(rovingStop([], 0)).toBe(-1);
  });

  it('takes only the container’s own enabled, shown buttons by default', () => {
    expect(ROVING_ITEMS).toBe(':scope > button:not(:disabled):not([hidden])');
  });
});
