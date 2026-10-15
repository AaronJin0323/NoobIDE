import { describe, expect, it } from 'vitest';
import {
  GLASS,
  GLASS_BACKDROPS,
  GLASS_TEXT,
  NON_TEXT_PAIRS,
  TEXT_PAIRS,
  THEMES,
  composite,
  contrastRatio,
  cssVariableName,
  cssVariables,
  relativeLuminance,
  type ColorScheme,
} from './tokens';

const SCHEMES: ColorScheme[] = ['dark', 'light'];

describe('contrast math', () => {
  it('matches the WCAG reference values', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 10);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 10);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#FFFFFF', '#767676')).toBe(contrastRatio('#767676', '#FFFFFF'));
  });

  it('rejects colours it cannot check', () => {
    expect(() => relativeLuminance('rgba(0,0,0,0.5)')).toThrow();
    expect(() => relativeLuminance('#FFF')).toThrow();
  });
});

describe('theme tokens (S30.1)', () => {
  it('dark and light define the same tokens, all solid #RRGGBB colours', () => {
    expect(Object.keys(THEMES.dark).sort()).toEqual(Object.keys(THEMES.light).sort());
    for (const scheme of SCHEMES) {
      for (const [key, value] of Object.entries(THEMES[scheme]))
        expect(value, `${scheme}.${key}`).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it.each(SCHEMES)('%s: every text pair reaches 4.5:1', (scheme) => {
    const t = THEMES[scheme];
    const failures = TEXT_PAIRS.map(([fg, bg]) => ({ pair: `${fg} on ${bg}`, ratio: contrastRatio(t[fg], t[bg]) }))
      .filter((r) => r.ratio < 4.5)
      .map((r) => `${r.pair}: ${r.ratio.toFixed(2)}`);
    expect(failures).toEqual([]);
  });

  it.each(SCHEMES)('%s: focus ring and accent reach 3:1 against their surfaces', (scheme) => {
    const t = THEMES[scheme];
    for (const [fg, bg] of NON_TEXT_PAIRS)
      expect(contrastRatio(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
  });

  it('exposes tokens as kebab-case custom properties', () => {
    expect(cssVariableName('syntaxTag')).toBe('--syntax-tag');
    expect(cssVariableName('bg')).toBe('--bg');
    expect(cssVariables('dark')['--panel']).toBe(THEMES.dark.panel);
    expect(cssVariables('dark')['--glass-overlay']).toBe(GLASS.dark.glassOverlay);
    expect(Object.keys(cssVariables('light'))).toHaveLength(
      Object.keys(THEMES.light).length + Object.keys(GLASS.light).length,
    );
  });
});

describe('glass materials (S40.2)', () => {
  it('composites a translucent colour over a solid one', () => {
    expect(composite('#FFFFFF80', '#000000')).toBe('#808080');
    expect(composite('#00000000', '#ABCDEF')).toBe('#ABCDEF');
    expect(() => composite('#FFFFFF', '#000000')).toThrow();
  });

  it('dark and light define the same glass tokens; fills are #RRGGBBAA, fallbacks solid', () => {
    expect(Object.keys(GLASS.dark).sort()).toEqual(Object.keys(GLASS.light).sort());
    for (const scheme of SCHEMES) {
      for (const [key, value] of Object.entries(GLASS[scheme])) {
        expect(value, `${scheme}.${key}`).toMatch(key.endsWith('Solid') ? /^#[0-9A-F]{6}$/ : /^#[0-9A-F]{8}$/);
      }
    }
  });

  it.each(SCHEMES)('%s: text on glass reaches 4.5:1 over every surface the glass can float over', (scheme) => {
    const t = THEMES[scheme];
    const g = GLASS[scheme];
    const failures: string[] = [];
    for (const [fill, surfaces] of Object.entries(GLASS_BACKDROPS) as [
      keyof typeof GLASS_BACKDROPS,
      readonly string[],
    ][]) {
      for (const surface of surfaces) {
        const solid = t[surface as keyof typeof t];
        // The ambient colour fields tint the window background under the chrome.
        for (const under of [solid, composite(g.ambientA, solid), composite(g.ambientB, solid)]) {
          const seen = composite(g[fill], under);
          for (const fg of GLASS_TEXT) {
            const ratio = contrastRatio(t[fg], seen);
            if (ratio < 4.5) failures.push(`${fg} on ${fill} over ${surface} (${under}): ${ratio.toFixed(2)}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it.each(SCHEMES)('%s: text on the solid fallbacks reaches 4.5:1', (scheme) => {
    const t = THEMES[scheme];
    for (const solid of [GLASS[scheme].glassChromeSolid, GLASS[scheme].glassOverlaySolid])
      for (const fg of GLASS_TEXT) expect(contrastRatio(t[fg], solid), `${fg} on ${solid}`).toBeGreaterThanOrEqual(4.5);
  });
});
