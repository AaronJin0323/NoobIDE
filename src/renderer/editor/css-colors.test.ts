import { describe, expect, it } from 'vitest';
import { colorAt, findColors, formatColor, hslToRgb, parseColor, rgbToHsl } from './css-colors';

describe('parseColor (S53.3)', () => {
  it('reads hex, rgb(), hsl() and named colours', () => {
    expect(parseColor('#f00')).toEqual({ format: 'hex', rgba: { r: 255, g: 0, b: 0, a: 1 } });
    expect(parseColor('#00800080')).toEqual({ format: 'hex', rgba: { r: 0, g: 128, b: 0, a: 0.502 } });
    expect(parseColor('rgb(0, 128, 255)')).toEqual({ format: 'rgb', rgba: { r: 0, g: 128, b: 255, a: 1 } });
    expect(parseColor('rgba(0 128 255 / 50%)')).toEqual({ format: 'rgb', rgba: { r: 0, g: 128, b: 255, a: 0.5 } });
    expect(parseColor('hsl(120, 100%, 25%)')).toEqual({ format: 'hsl', rgba: { r: 0, g: 128, b: 0, a: 1 } });
    expect(parseColor('RebeccaPurple')).toEqual({ format: 'named', rgba: { r: 102, g: 51, b: 153, a: 1 } });
  });

  it('rejects what is not a colour', () => {
    for (const text of ['#ggg', '#12345', 'rgb(1, 2)', 'hsl(a, b, c)', 'bold', 'rgb(1, 2, 3, 4, 5)']) {
      expect(parseColor(text), text).toBeNull();
    }
  });

  it('converts between rgb and hsl', () => {
    expect(rgbToHsl({ r: 255, g: 0, b: 0, a: 1 })).toEqual({ h: 0, s: 100, l: 50, a: 1 });
    expect(hslToRgb({ h: 240, s: 100, l: 50, a: 1 })).toEqual({ r: 0, g: 0, b: 255, a: 1 });
  });
});

describe('formatColor (S53.3)', () => {
  const teal = { r: 0, g: 128, b: 128, a: 1 };
  it('writes the colour in the format it was found in; a name becomes hex', () => {
    expect(formatColor(teal, 'hex')).toBe('#008080');
    expect(formatColor(teal, 'rgb')).toBe('rgb(0, 128, 128)');
    expect(formatColor(teal, 'hsl')).toBe('hsl(180, 100%, 25%)');
    expect(formatColor(teal, 'named')).toBe('#008080');
  });

  it('keeps transparency', () => {
    const half = { ...teal, a: 0.5 };
    expect(formatColor(half, 'hex')).toBe('#00808080');
    expect(formatColor(half, 'rgb')).toBe('rgba(0, 128, 128, 0.5)');
    expect(formatColor(half, 'hsl')).toBe('hsla(180, 100%, 25%, 0.5)');
  });
});

describe('findColors / colorAt (S53.3)', () => {
  const css = 'a { color: #f00; background: rgb(0, 0, 255); }\n/* red */\n.red { border: 1px solid tomato; }';

  it('finds colour values in declarations only (not in selectors or comments)', () => {
    expect(findColors(css).map((c) => c.text)).toEqual(['#f00', 'rgb(0, 0, 255)', 'tomato']);
  });

  it('finds the colour at the cursor', () => {
    expect(colorAt(css, css.indexOf('#f00') + 2)?.text).toBe('#f00');
    expect(colorAt(css, css.indexOf('rgb(') + 'rgb(0, 0, 255)'.length)?.text).toBe('rgb(0, 0, 255)');
    expect(colorAt(css, css.indexOf('tomato'))?.format).toBe('named');
    expect(colorAt(css, css.indexOf('color'))).toBeNull();
    expect(colorAt(css, css.indexOf('red */'))).toBeNull();
    expect(colorAt(css, css.indexOf('.red') + 2)).toBeNull();
  });
});
