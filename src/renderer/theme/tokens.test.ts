import { describe, expect, it } from 'vitest';
import {
  NON_TEXT_PAIRS,
  TEXT_PAIRS,
  THEMES,
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
    expect(Object.keys(cssVariables('light'))).toHaveLength(Object.keys(THEMES.light).length);
  });
});
