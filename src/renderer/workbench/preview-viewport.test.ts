import { describe, expect, it } from 'vitest';
import { MOBILE_WIDTH, coveredBy, overlaps, viewRect } from './preview-viewport';

const stage = { x: 600, y: 80, width: 600, height: 500 };

describe('viewRect (S15.3 viewport width)', () => {
  it('desktop fills the whole stage', () => {
    expect(viewRect(stage, 'desktop')).toEqual(stage);
  });

  it('mobile changes only the width: 375 px, centred, full height', () => {
    expect(MOBILE_WIDTH).toBe(375);
    const r = viewRect(stage, 'mobile');
    expect(r).toEqual({ x: 600 + 112, y: 80, width: 375, height: 500 });
  });

  it('a stage narrower than the mobile width is used as it is', () => {
    const small = { x: 0, y: 0, width: 300, height: 200 };
    expect(viewRect(small, 'mobile')).toEqual(small);
  });
});

describe('overlays above the preview (S15.5/S15.6)', () => {
  it('overlap needs shared area, touching edges do not count', () => {
    expect(overlaps(stage, { x: 1100, y: 500, width: 200, height: 200 })).toBe(true);
    expect(overlaps(stage, { x: 1200, y: 80, width: 100, height: 100 })).toBe(false);
    expect(overlaps(stage, { x: 0, y: 0, width: 600, height: 80 })).toBe(false);
  });

  it('a full-window backdrop covers; a menu elsewhere or an empty rect does not', () => {
    expect(coveredBy(stage, [{ x: 0, y: 0, width: 1280, height: 800 }])).toBe(true);
    expect(coveredBy(stage, [{ x: 20, y: 100, width: 260, height: 200 }])).toBe(false);
    expect(coveredBy(stage, [{ x: 700, y: 100, width: 0, height: 0 }])).toBe(false);
    expect(coveredBy(stage, [])).toBe(false);
  });
});
