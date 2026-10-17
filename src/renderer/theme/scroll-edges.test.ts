import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EDGE_FADE_PX,
  EDGE_LADDER,
  EDGE_RAMP_PX,
  EDGE_SNAP_PX,
  SCROLL_EDGE_SELECTORS,
  edgeFade,
  installScrollEdgeFallback,
  nativeScrollEdges,
} from './scroll-edges';

const MOTION = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'motion.css'), 'utf8');

describe('S47.3 scroll-edge model (the fallback sensor)', () => {
  const list = { scrollHeight: 1000, clientHeight: 200 };

  it('has no fade on a list that does not scroll', () => {
    expect(edgeFade({ scrollTop: 0, scrollHeight: 200, clientHeight: 200 })).toEqual({ top: 0, bottom: 0 });
    expect(edgeFade({ scrollTop: 0, scrollHeight: 201, clientHeight: 200 })).toEqual({ top: 0, bottom: 0 });
  });

  it('sets the fade to 0 within 2 px of either end', () => {
    expect(edgeFade({ ...list, scrollTop: 0 })).toEqual({ top: 0, bottom: EDGE_FADE_PX });
    expect(edgeFade({ ...list, scrollTop: EDGE_SNAP_PX }).top).toBe(0);
    expect(edgeFade({ ...list, scrollTop: 800 })).toEqual({ top: EDGE_FADE_PX, bottom: 0 });
    expect(edgeFade({ ...list, scrollTop: 798 }).bottom).toBe(0);
    // Fractional scroll positions (zoomed / scaled displays) still snap.
    expect(edgeFade({ ...list, scrollTop: 799.4 }).bottom).toBe(0);
    expect(edgeFade({ ...list, scrollTop: 1.6 }).top).toBe(0);
  });

  it('ramps each end in over 32 px of scrolling to the full 28 px', () => {
    expect(edgeFade({ ...list, scrollTop: 3 }).top).toBeGreaterThan(0);
    expect(edgeFade({ ...list, scrollTop: EDGE_RAMP_PX / 2 }).top).toBe(EDGE_FADE_PX / 2);
    expect(edgeFade({ ...list, scrollTop: EDGE_RAMP_PX }).top).toBe(EDGE_FADE_PX);
    expect(edgeFade({ ...list, scrollTop: 400 })).toEqual({ top: EDGE_FADE_PX, bottom: EDGE_FADE_PX });
    expect(edgeFade({ ...list, scrollTop: 800 - EDGE_RAMP_PX / 2 }).bottom).toBe(EDGE_FADE_PX / 2);
  });

  it('defers to the engine when it has scroll-driven animations', () => {
    expect(nativeScrollEdges({ supports: (c) => c === 'animation-timeline: scroll()' })).toBe(true);
    expect(nativeScrollEdges({ supports: () => false })).toBe(false);
    expect(nativeScrollEdges(undefined)).toBe(false);
    // The installer is a no-op there (and outside a browser).
    const doc = { defaultView: { CSS: { supports: () => true } } } as unknown as Document;
    expect(installScrollEdgeFallback(doc)()).toBeUndefined();
  });
});

describe('S47.3 seven-stop mask in motion.css', () => {
  it('is the 5/15/30/50/70/85/100 % ladder at 15/30/45/60/75/87/100 % of the fade', () => {
    expect(EDGE_LADDER.map(([a]) => a)).toEqual([5, 15, 30, 50, 70, 85, 100]);
    expect(EDGE_LADDER.map(([, at]) => at)).toEqual([15, 30, 45, 60, 75, 87, 100]);
    expect(EDGE_FADE_PX).toBe(28);
    const stops = (edge: string) =>
      EDGE_LADDER.map(([a, at]) => {
        const colour = a === 100 ? '#000' : `rgb\\(0 0 0 / ${a}%\\)`;
        const pos = at === 100 ? `var\\(${edge}\\)` : `var\\(${edge}\\) \\* ${at / 100}`;
        return new RegExp(`${colour} [^,]*${pos}`);
      });
    for (const edge of ['--edge-top', '--edge-bottom', '--edge-start', '--edge-end'])
      for (const stop of stops(edge)) expect(MOTION).toMatch(stop);
    expect(MOTION).toMatch(/to \{\s+--edge-top: 28px;/);
    expect(MOTION).toMatch(/from \{\s+--edge-bottom: 28px;/);
  });

  it('runs on a scroll timeline under @supports, for every masked scroller and the tab strip', () => {
    const supports = MOTION.slice(MOTION.indexOf('@supports (animation-timeline: scroll())'));
    expect(supports).toMatch(/animation-timeline: scroll\(self\), scroll\(self\);/);
    expect(supports).toMatch(/animation-range:\s+0 32px,\s+calc\(100% - 32px\) 100%;/);
    for (const selector of SCROLL_EDGE_SELECTORS) {
      expect(supports.slice(0, supports.indexOf('{', supports.indexOf('{') + 1))).toContain(selector);
      expect(MOTION).toContain(`${selector},`);
    }
    expect(MOTION).toMatch(/\.tabs-strip\[data-overflow-start\] \.tabs \{\s+--edge-start: 28px;/);
    expect(MOTION).toMatch(/\.tabs-strip\[data-overflow-end\] \.tabs \{\s+--edge-end: 28px;/);
    // Each fade length is a registered length starting at 0: no mask until something is scrolled past.
    for (const name of ['--edge-top', '--edge-bottom', '--edge-start', '--edge-end'])
      expect(MOTION).toMatch(
        new RegExp(`@property ${name} \\{\\s+syntax: '<length>';\\s+inherits: false;\\s+initial-value: 0px;`),
      );
  });
});
