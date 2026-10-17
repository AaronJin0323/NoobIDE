/**
 * CSS colour values (S53.3): find the colour at the cursor, read it, and write a new colour back in the same format
 * (hex stays hex, `rgb()` stays `rgb()`, `hsl()` stays `hsl()`; a colour name becomes hex, since most new colours
 * have no name). Pure and unit-tested; the picker (ColorPicker.tsx) and the editor glue use it.
 */

export type ColorFormat = 'hex' | 'rgb' | 'hsl' | 'named';

export interface Rgba {
  /** 0–255 */
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0–1 */
  readonly a: number;
}

export interface Hsla {
  /** 0–360 */
  readonly h: number;
  /** 0–100 */
  readonly s: number;
  readonly l: number;
  /** 0–1 */
  readonly a: number;
}

export interface FoundColor {
  /** Offsets of the colour text in the document. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly format: ColorFormat;
  readonly rgba: Rgba;
}

/** CSS Color Module Level 4 named colours (lower case → #rrggbb). */
const NAMED: Readonly<Record<string, string>> = {
  aliceblue: 'f0f8ff',
  antiquewhite: 'faebd7',
  aqua: '00ffff',
  aquamarine: '7fffd4',
  azure: 'f0ffff',
  beige: 'f5f5dc',
  bisque: 'ffe4c4',
  black: '000000',
  blanchedalmond: 'ffebcd',
  blue: '0000ff',
  blueviolet: '8a2be2',
  brown: 'a52a2a',
  burlywood: 'deb887',
  cadetblue: '5f9ea0',
  chartreuse: '7fff00',
  chocolate: 'd2691e',
  coral: 'ff7f50',
  cornflowerblue: '6495ed',
  cornsilk: 'fff8dc',
  crimson: 'dc143c',
  cyan: '00ffff',
  darkblue: '00008b',
  darkcyan: '008b8b',
  darkgoldenrod: 'b8860b',
  darkgray: 'a9a9a9',
  darkgreen: '006400',
  darkgrey: 'a9a9a9',
  darkkhaki: 'bdb76b',
  darkmagenta: '8b008b',
  darkolivegreen: '556b2f',
  darkorange: 'ff8c00',
  darkorchid: '9932cc',
  darkred: '8b0000',
  darksalmon: 'e9967a',
  darkseagreen: '8fbc8f',
  darkslateblue: '483d8b',
  darkslategray: '2f4f4f',
  darkslategrey: '2f4f4f',
  darkturquoise: '00ced1',
  darkviolet: '9400d3',
  deeppink: 'ff1493',
  deepskyblue: '00bfff',
  dimgray: '696969',
  dimgrey: '696969',
  dodgerblue: '1e90ff',
  firebrick: 'b22222',
  floralwhite: 'fffaf0',
  forestgreen: '228b22',
  fuchsia: 'ff00ff',
  gainsboro: 'dcdcdc',
  ghostwhite: 'f8f8ff',
  gold: 'ffd700',
  goldenrod: 'daa520',
  gray: '808080',
  green: '008000',
  greenyellow: 'adff2f',
  grey: '808080',
  honeydew: 'f0fff0',
  hotpink: 'ff69b4',
  indianred: 'cd5c5c',
  indigo: '4b0082',
  ivory: 'fffff0',
  khaki: 'f0e68c',
  lavender: 'e6e6fa',
  lavenderblush: 'fff0f5',
  lawngreen: '7cfc00',
  lemonchiffon: 'fffacd',
  lightblue: 'add8e6',
  lightcoral: 'f08080',
  lightcyan: 'e0ffff',
  lightgoldenrodyellow: 'fafad2',
  lightgray: 'd3d3d3',
  lightgreen: '90ee90',
  lightgrey: 'd3d3d3',
  lightpink: 'ffb6c1',
  lightsalmon: 'ffa07a',
  lightseagreen: '20b2aa',
  lightskyblue: '87cefa',
  lightslategray: '778899',
  lightslategrey: '778899',
  lightsteelblue: 'b0c4de',
  lightyellow: 'ffffe0',
  lime: '00ff00',
  limegreen: '32cd32',
  linen: 'faf0e6',
  magenta: 'ff00ff',
  maroon: '800000',
  mediumaquamarine: '66cdaa',
  mediumblue: '0000cd',
  mediumorchid: 'ba55d3',
  mediumpurple: '9370db',
  mediumseagreen: '3cb371',
  mediumslateblue: '7b68ee',
  mediumspringgreen: '00fa9a',
  mediumturquoise: '48d1cc',
  mediumvioletred: 'c71585',
  midnightblue: '191970',
  mintcream: 'f5fffa',
  mistyrose: 'ffe4e1',
  moccasin: 'ffe4b5',
  navajowhite: 'ffdead',
  navy: '000080',
  oldlace: 'fdf5e6',
  olive: '808000',
  olivedrab: '6b8e23',
  orange: 'ffa500',
  orangered: 'ff4500',
  orchid: 'da70d6',
  palegoldenrod: 'eee8aa',
  palegreen: '98fb98',
  paleturquoise: 'afeeee',
  palevioletred: 'db7093',
  papayawhip: 'ffefd5',
  peachpuff: 'ffdab9',
  peru: 'cd853f',
  pink: 'ffc0cb',
  plum: 'dda0dd',
  powderblue: 'b0e0e6',
  purple: '800080',
  rebeccapurple: '663399',
  red: 'ff0000',
  rosybrown: 'bc8f8f',
  royalblue: '4169e1',
  saddlebrown: '8b4513',
  salmon: 'fa8072',
  sandybrown: 'f4a460',
  seagreen: '2e8b57',
  seashell: 'fff5ee',
  sienna: 'a0522d',
  silver: 'c0c0c0',
  skyblue: '87ceeb',
  slateblue: '6a5acd',
  slategray: '708090',
  slategrey: '708090',
  snow: 'fffafa',
  springgreen: '00ff7f',
  steelblue: '4682b4',
  tan: 'd2b48c',
  teal: '008080',
  thistle: 'd8bfd8',
  tomato: 'ff6347',
  turquoise: '40e0d0',
  violet: 'ee82ee',
  wheat: 'f5deb3',
  white: 'ffffff',
  whitesmoke: 'f5f5f5',
  yellow: 'ffff00',
  yellowgreen: '9acd32',
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

function hexToRgba(hex: string): Rgba | null {
  const h = hex.replace(/^#/, '');
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) return null;
  const full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? round(n(6) / 255, 3) : 1 };
}

/** A number or percentage of `scale` (rgb channels: 255; alpha: 1). */
function channel(raw: string, scale: number): number | null {
  const m = /^(-?\d*\.?\d+)(%?)$/.exec(raw.trim());
  if (!m) return null;
  const value = Number(m[1]);
  return m[2] === '%' ? (value / 100) * scale : value;
}

/** Splits the inside of `rgb(…)` / `hsl(…)`: commas or spaces, an optional `/ alpha`. */
function argumentsOf(inner: string): string[] | null {
  const [main = '', alpha] = inner.split('/');
  const parts = main.includes(',') ? main.split(',') : main.trim().split(/\s+/);
  const list = parts.map((p) => p.trim()).filter((p) => p !== '');
  if (alpha !== undefined) list.push(alpha.trim());
  return list.length === 3 || list.length === 4 ? list : null;
}

export function hslToRgb({ h, s, l, a }: Hsla): Rgba {
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;
  const k = (n: number) => (n + (((h % 360) + 360) % 360) / 30) % 12;
  const f = (n: number) => light - sat * Math.min(light, 1 - light) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255), a };
}

export function rgbToHsl({ r, g, b, a }: Rgba): Hsla {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
  }
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: round((h * 60 + 360) % 360), s: round(s * 100), l: round(l * 100), a };
}

/** Reads one colour value (`#f00`, `rgb(0 128 0 / 50%)`, `hsl(120, 50%, 40%)`, `rebeccapurple`), or null. */
export function parseColor(text: string): { format: ColorFormat; rgba: Rgba } | null {
  const value = text.trim().toLowerCase();
  if (value.startsWith('#')) {
    const rgba = hexToRgba(value);
    return rgba ? { format: 'hex', rgba } : null;
  }
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(value);
  if (fn) {
    const args = argumentsOf(fn[2] ?? '');
    if (!args) return null;
    const alpha = args[3] === undefined ? 1 : channel(args[3], 1);
    if (alpha === null) return null;
    if ((fn[1] ?? '').startsWith('rgb')) {
      const [r, g, b] = args.slice(0, 3).map((arg) => channel(arg, 255));
      if (r == null || g == null || b == null) return null;
      return {
        format: 'rgb',
        rgba: {
          r: clamp(Math.round(r), 0, 255),
          g: clamp(Math.round(g), 0, 255),
          b: clamp(Math.round(b), 0, 255),
          a: clamp(alpha, 0, 1),
        },
      };
    }
    const h = Number((args[0] ?? '').replace(/deg$/, ''));
    const s = channel(args[1] ?? '', 100);
    const l = channel(args[2] ?? '', 100);
    if (!Number.isFinite(h) || s === null || l === null) return null;
    return { format: 'hsl', rgba: hslToRgb({ h, s, l, a: clamp(alpha, 0, 1) }) };
  }
  const named = NAMED[value];
  return named ? { format: 'named', rgba: hexToRgba(named) as Rgba } : null;
}

const hex2 = (n: number) =>
  Math.round(clamp(n, 0, 255))
    .toString(16)
    .padStart(2, '0');

export function toHex(rgba: Rgba): string {
  const alpha = rgba.a < 1 ? hex2(rgba.a * 255) : '';
  return `#${hex2(rgba.r)}${hex2(rgba.g)}${hex2(rgba.b)}${alpha}`;
}

/** Writes a colour in `format` (a colour name is written as hex). Alpha is kept only when it is not 1. */
export function formatColor(rgba: Rgba, format: ColorFormat): string {
  const alpha = round(rgba.a, 2);
  if (format === 'rgb') {
    return alpha < 1 ? `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${alpha})` : `rgb(${rgba.r}, ${rgba.g}, ${rgba.b})`;
  }
  if (format === 'hsl') {
    const { h, s, l } = rgbToHsl(rgba);
    return alpha < 1 ? `hsla(${h}, ${s}%, ${l}%, ${alpha})` : `hsl(${h}, ${s}%, ${l}%)`;
  }
  return toHex(rgba);
}

/** Candidate colour tokens of CSS text: hex, `rgb()` / `rgba()` / `hsl()` / `hsla()`, and words. */
const TOKEN = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^()]*\)|\b[a-zA-Z]+\b/g;

/** Comments, strings and selectors are not values: only text after a `:` inside a declaration counts. */
function inValue(text: string, offset: number): boolean {
  let i = offset - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === ':') return true;
    if (ch === ';' || ch === '{' || ch === '}') return false;
    i -= 1;
  }
  return false;
}

function inComment(text: string, offset: number): boolean {
  const open = text.lastIndexOf('/*', offset);
  if (open < 0) return false;
  const close = text.indexOf('*/', open + 2);
  return close < 0 || close >= offset;
}

/** Every colour value in CSS text, in document order. */
export function findColors(text: string): FoundColor[] {
  const found: FoundColor[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(text)) !== null) {
    const start = m.index;
    if (!inValue(text, start) || inComment(text, start)) continue;
    const parsed = parseColor(m[0]);
    if (!parsed) continue;
    found.push({ start, end: start + m[0].length, text: m[0], ...parsed });
  }
  return found;
}

/** The colour value the cursor is in or right after, or null. */
export function colorAt(text: string, offset: number): FoundColor | null {
  // Only the declaration around the cursor is scanned, so this stays cheap on large files.
  const from = Math.max(text.lastIndexOf('{', offset - 1), text.lastIndexOf(';', offset - 1)) + 1;
  const ends = [text.indexOf(';', offset), text.indexOf('}', offset)].filter((i) => i >= 0);
  const to = ends.length > 0 ? Math.min(...ends) : text.length;
  if (from === 0 || inComment(text, offset)) return null; // not inside a rule, or in a comment
  for (const color of findColors(text.slice(from - 1, to))) {
    const start = color.start + from - 1;
    const end = color.end + from - 1;
    if (offset >= start && offset <= end) return { ...color, start, end };
  }
  return null;
}
