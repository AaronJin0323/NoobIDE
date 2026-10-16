/**
 * Colour tokens for the workbench shell and the Monaco theme (S30.1). Single source of truth: the stylesheet only
 * reads these as CSS custom properties (`--bg`, `--panel`, …), and monaco-theme.ts builds the editor themes from them.
 * Values follow the 2026-10-14 UI prototype, with the monochrome accent of the NoobIDE logo (resources/brand/) in
 * place of the prototype's purple: black #111318 in the light scheme, inverted to near-white in the dark scheme
 * (black cannot reach 3:1 on the dark panels); contrast is checked by tokens.test.ts. Solid colours only, so the
 * contrast check never depends on what a translucent colour is drawn over.
 */
export type ColorScheme = 'dark' | 'light';

export interface ThemeTokens {
  /** Window background behind the floating panels. */
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
  accent: string;
  /** Text and icons drawn on `accent`. */
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
    bg: '#0B0D12',
    panel: '#13161D',
    raised: '#1B1F29',
    hover: '#242937',
    line: '#262B38',
    text: '#ECEEF4',
    muted: '#9AA3B5',
    faint: '#7D8599',
    accent: '#F2F3F5',
    onAccent: '#0B0D12',
    accentText: '#FFFFFF',
    accentSoft: '#2A2E38',
    ok: '#3DDC97',
    okSoft: '#13271F',
    warn: '#FFB547',
    warnSoft: '#2A2216',
    danger: '#FF7A7A',
    dangerSoft: '#2D1A1D',
    focus: '#FFFFFF',
    lineHighlight: '#181B22',
    selection: '#2F3542',
    syntaxTag: '#7DB4FF',
    syntaxAttribute: '#FFB86B',
    syntaxString: '#8EE6B3',
    syntaxComment: '#8B93A6',
    syntaxKeyword: '#C3A6FF',
    syntaxNumber: '#F5A3C7',
  },
  light: {
    bg: '#ECEEF3',
    panel: '#FFFFFF',
    raised: '#F3F4F8',
    hover: '#E8EAF0',
    line: '#DCE0E8',
    text: '#151821',
    muted: '#555D70',
    faint: '#636B7D',
    accent: '#111318',
    onAccent: '#FFFFFF',
    accentText: '#111318',
    accentSoft: '#E6E8EC',
    ok: '#0F7A4B',
    okSoft: '#E2F5EC',
    warn: '#8F5200',
    warnSoft: '#FFF2DC',
    danger: '#C02F2F',
    dangerSoft: '#FDEAEA',
    focus: '#111318',
    lineHighlight: '#F5F6F8',
    selection: '#D9DCE3',
    syntaxTag: '#2557C7',
    syntaxAttribute: '#A35200',
    syntaxString: '#0F7A4B',
    syntaxComment: '#636B7D',
    syntaxKeyword: '#6E3FD6',
    syntaxNumber: '#B0306A',
  },
};

/**
 * S40.2 Liquid Glass materials (docs/decisions/0029-liquid-glass-design-language.md). Translucent `#RRGGBBAA`
 * colours for the floating control layer only — content (code, preview, file names) always sits on the solid
 * tokens above. Every translucent fill has a solid twin used when the system asks for reduced transparency or
 * higher contrast, and tokens.test.ts checks text on the fill composited over every surface it can float over.
 */
export interface GlassTokens {
  /** Persistent chrome (rail, top-bar groups, status strip) over the window background. No backdrop blur. */
  glassChrome: string;
  /** Transient layers (menus, command palette, sheets) over content, with a backdrop blur. */
  glassOverlay: string;
  /** Hover / pressed fill of a control drawn on glass. */
  glassHover: string;
  /** Rim: the thin edge that separates glass from what is behind it. */
  glassStroke: string;
  /** Specular highlight along the top edge. */
  glassHighlight: string;
  glassShadow: string;
  /** Soft colour fields in the window background that the chrome refracts. */
  ambientA: string;
  ambientB: string;
  /** Solid fallbacks (reduced transparency, increased contrast, forced colours). */
  glassChromeSolid: string;
  glassOverlaySolid: string;
  /** Dims the workbench behind a sheet. */
  scrim: string;
}

export const GLASS: Record<ColorScheme, GlassTokens> = {
  dark: {
    glassChrome: '#1E2230A6',
    glassOverlay: '#181B25D1',
    glassHover: '#FFFFFF14',
    glassStroke: '#FFFFFF1F',
    glassHighlight: '#FFFFFF24',
    glassShadow: '#00000073',
    ambientA: '#FFFFFF0F',
    ambientB: '#3DDC9714',
    glassChromeSolid: '#1B1F29',
    glassOverlaySolid: '#1B1F29',
    scrim: '#05060A99',
  },
  light: {
    glassChrome: '#FFFFFF94',
    glassOverlay: '#FFFFFFC7',
    glassHover: '#151A2B0F',
    glassStroke: '#FFFFFFB3',
    glassHighlight: '#FFFFFFE6',
    glassShadow: '#1E223C29',
    ambientA: '#11131814',
    ambientB: '#38BDF81F',
    glassChromeSolid: '#FFFFFF',
    glassOverlaySolid: '#FFFFFF',
    scrim: '#1E223C47',
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
 * What each glass fill can float over (S40.2). Chrome sits on the window background (tinted by the ambient fields);
 * overlays can open above any surface of the workbench. The native preview view is never under glass: it is
 * hidden while an overlay covers it (PreviewPane `covered`).
 */
export const GLASS_BACKDROPS = {
  glassChrome: ['bg'],
  glassOverlay: ['bg', 'panel', 'raised', 'hover', 'line', 'selection', 'accentSoft', 'lineHighlight'],
} as const satisfies Record<'glassChrome' | 'glassOverlay', readonly (keyof ThemeTokens)[]>;

/** Text styles drawn on glass. */
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
  ['onAccent', 'accent'],
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
];
