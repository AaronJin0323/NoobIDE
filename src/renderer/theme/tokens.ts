/**
 * Colour tokens for the workbench shell and the Monaco theme (S30.1). Single source of truth: the stylesheet only
 * reads these as CSS custom properties (`--bg`, `--panel`, …), and monaco-theme.ts builds the editor themes from them.
 * Warm neutral palette of the calm design language (docs/product/calm-design-spec.md, decision 0034), with the
 * monochrome accent of the NoobIDE logo (resources/brand/): filled controls are black in both schemes (with a grey
 * rim on the dark panels), lines and indicators are near-black in the light scheme and near-white in the dark one;
 * contrast is checked by tokens.test.ts. Solid colours only, so the contrast check never depends on what a
 * translucent colour is drawn over.
 */
export type ColorScheme = 'dark' | 'light';

export interface ThemeTokens {
  /** Window background; chrome (rail, top bar, status strip) sits directly on it. */
  bg: string;
  /** Panels: files, editor, preview, problems. Also the Monaco background. */
  panel: string;
  /** Raised surfaces inside a panel: active tab, active row, segmented control track. */
  raised: string;
  hover: string;
  line: string;
  text: string;
  muted: string;
  /** Line numbers and other quiet text drawn on `panel`. */
  faint: string;
  /** Accent as a line or indicator: active-row bars, focus outlines, dashed callouts. */
  accent: string;
  /** Accent as a filled surface: primary buttons, selected segment and menu row, the app mark. Black in both schemes. */
  accentFill: string;
  /** Edge drawn around `accentFill`, so a black fill stays visible on the dark scheme's panels (WCAG 1.4.11). */
  accentRim: string;
  /** Text and icons drawn on `accentFill`. */
  onAccent: string;
  accentText: string;
  accentSoft: string;
  ok: string;
  okSoft: string;
  warn: string;
  warnSoft: string;
  danger: string;
  dangerSoft: string;
  focus: string;
  /** Monaco current-line and selection backgrounds. */
  lineHighlight: string;
  selection: string;
  syntaxTag: string;
  syntaxAttribute: string;
  syntaxString: string;
  syntaxComment: string;
  syntaxKeyword: string;
  syntaxNumber: string;
}

export const THEMES: Record<ColorScheme, ThemeTokens> = {
  dark: {
    bg: '#1B1A18',
    panel: '#232220',
    raised: '#2B2A27',
    hover: '#33312E',
    line: '#363431',
    text: '#ECEAE4',
    muted: '#A9A59D',
    faint: '#959189',
    accent: '#ECEAE4',
    accentFill: '#0F0E0D',
    accentRim: '#8F8B83',
    onAccent: '#FFFFFF',
    accentText: '#ECEAE4',
    accentSoft: '#34322F',
    ok: '#86C29C',
    okSoft: '#22302A',
    warn: '#E2B467',
    warnSoft: '#342C1F',
    danger: '#EC8F84',
    dangerSoft: '#3A2624',
    focus: '#ECEAE4',
    lineHighlight: '#282725',
    selection: '#3E3B37',
    syntaxTag: '#8DB4F0',
    syntaxAttribute: '#E3AE78',
    syntaxString: '#9BCF9F',
    syntaxComment: '#99958D',
    syntaxKeyword: '#C4A9F0',
    syntaxNumber: '#EAA3C2',
  },
  light: {
    bg: '#F4F3EF',
    panel: '#FFFFFF',
    raised: '#F1F0EC',
    hover: '#E9E7E2',
    line: '#E3E1DB',
    text: '#1F1E1C',
    muted: '#5F5C56',
    faint: '#6E6B64',
    accent: '#1F1E1C',
    accentFill: '#1F1E1C',
    accentRim: '#1F1E1C',
    onAccent: '#FFFFFF',
    accentText: '#1F1E1C',
    accentSoft: '#ECEAE5',
    ok: '#2E6B47',
    okSoft: '#EAF2EC',
    warn: '#7F5300',
    warnSoft: '#F8F0DF',
    danger: '#A8352C',
    dangerSoft: '#F9ECEA',
    focus: '#1F1E1C',
    lineHighlight: '#F7F6F3',
    selection: '#E2DFD8',
    syntaxTag: '#2F5BB5',
    syntaxAttribute: '#93531A',
    syntaxString: '#2E6B47',
    syntaxComment: '#6E6B64',
    syntaxKeyword: '#7346B8',
    syntaxNumber: '#A23C6B',
  },
};

/**
 * Overlay materials (docs/decisions/0034-calm-design-language.md). Decision 0034 superseded the persistent chrome
 * glass of 0029: rail, top bar and status strip sit flat on `bg`. Only transient layers (menus, command palette,
 * dialogs, popovers) keep a translucent fill, over content, with a backdrop blur. Content (code, preview, file
 * names) always sits on the solid tokens above. The overlay fill has a solid twin used when the system asks for
 * reduced transparency or higher contrast, and tokens.test.ts checks text on the fill composited over every
 * surface an overlay can open above.
 */
export interface GlassTokens {
  /** Transient layers (menus, command palette, sheets) over content, with a backdrop blur. */
  glassOverlay: string;
  /** Hover / pressed fill of a control drawn on an overlay. */
  glassHover: string;
  /** Rim: the thin edge that separates an overlay from what is behind it. */
  glassStroke: string;
  glassShadow: string;
  /** Solid fallback (reduced transparency, increased contrast, forced colours). */
  glassOverlaySolid: string;
  /** Dims the workbench behind a sheet. */
  scrim: string;
}

export const GLASS: Record<ColorScheme, GlassTokens> = {
  dark: {
    glassOverlay: '#262522E0',
    glassHover: '#ECEAE414',
    glassStroke: '#ECEAE41A',
    glassShadow: '#0B0A0999',
    glassOverlaySolid: '#2B2A27',
    scrim: '#0B0A0999',
  },
  light: {
    glassOverlay: '#FFFFFFD9',
    glassHover: '#1F1E1C0F',
    glassStroke: '#1F1E1C1A',
    glassShadow: '#1F1E1C29',
    glassOverlaySolid: '#FFFFFF',
    scrim: '#1F1E1C40',
  },
};

/** `syntaxTag` → `--syntax-tag`. */
export function cssVariableName(token: keyof ThemeTokens | keyof GlassTokens): string {
  return `--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** The custom properties the stylesheet reads, for one scheme: solid tokens and glass materials. */
export function cssVariables(scheme: ColorScheme): Record<string, string> {
  const tokens = THEMES[scheme];
  const glass = GLASS[scheme];
  return Object.fromEntries([
    ...(Object.keys(tokens) as (keyof ThemeTokens)[]).map((key) => [cssVariableName(key), tokens[key]]),
    ...(Object.keys(glass) as (keyof GlassTokens)[]).map((key) => [cssVariableName(key), glass[key]]),
  ]);
}

/** A `#RRGGBBAA` colour painted over a solid `#RRGGBB` one: the solid colour the eye sees. */
export function composite(over: string, under: string): string {
  const top = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(over);
  const bottom = /^#([0-9a-f]{6})$/i.exec(under);
  if (!top?.[1] || !top[2] || !bottom?.[1]) throw new Error(`cannot composite ${over} over ${under}`);
  const alpha = Number.parseInt(top[2], 16) / 255;
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const mixed = [0, 1, 2].map((i) =>
    Math.round(channel(top[1] as string, i) * alpha + channel(bottom[1] as string, i) * (1 - alpha)),
  );
  return `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/**
 * What the overlay fill can float over. Overlays can open above any surface of the workbench. The native preview
 * view is never under an overlay: it is hidden while one covers it (PreviewPane `covered`).
 */
export const GLASS_BACKDROPS = {
  glassOverlay: ['bg', 'panel', 'raised', 'hover', 'line', 'selection', 'accentSoft', 'lineHighlight'],
} as const satisfies Record<'glassOverlay', readonly (keyof ThemeTokens)[]>;

/** Text styles drawn on an overlay. */
export const GLASS_TEXT: readonly (keyof ThemeTokens)[] = ['text', 'muted', 'accentText'];

/** WCAG 2.x relative luminance of a `#RRGGBB` colour. */
export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) throw new Error(`not a #RRGGBB colour: ${hex}`);
  const value = Number.parseInt(match[1], 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every foreground/background pair the shell and editor draw text with. Adding a new text style means adding its
 * pair here so the contrast test covers it.
 */
export const TEXT_PAIRS: readonly (readonly [fg: keyof ThemeTokens, bg: keyof ThemeTokens])[] = [
  ['text', 'bg'],
  ['text', 'panel'],
  ['text', 'raised'],
  ['text', 'hover'],
  ['muted', 'bg'],
  ['muted', 'panel'],
  ['muted', 'raised'],
  ['faint', 'panel'],
  ['faint', 'lineHighlight'],
  ['onAccent', 'accentFill'],
  ['accentText', 'panel'],
  ['accentText', 'raised'],
  ['accentText', 'accentSoft'],
  ['ok', 'panel'],
  ['ok', 'okSoft'],
  ['warn', 'panel'],
  ['warn', 'warnSoft'],
  ['danger', 'panel'],
  ['danger', 'dangerSoft'],
  ['text', 'selection'],
  ['syntaxTag', 'panel'],
  ['syntaxAttribute', 'panel'],
  ['syntaxString', 'panel'],
  ['syntaxComment', 'panel'],
  ['syntaxKeyword', 'panel'],
  ['syntaxNumber', 'panel'],
  ['syntaxTag', 'lineHighlight'],
  ['syntaxComment', 'lineHighlight'],
];

/** Focus rings and other non-text indicators need 3:1 against what they sit on (WCAG 1.4.11). */
export const NON_TEXT_PAIRS: readonly (readonly [fg: keyof ThemeTokens, bg: keyof ThemeTokens])[] = [
  ['focus', 'bg'],
  ['focus', 'panel'],
  ['accent', 'panel'],
  ['accentRim', 'bg'],
  ['accentRim', 'panel'],
  ['accentRim', 'raised'],
];
