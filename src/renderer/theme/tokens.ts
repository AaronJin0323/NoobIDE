/**
 * Colour tokens for the workbench shell and the Monaco theme (S30.1). Single source of truth: the stylesheet only
 * reads these as CSS custom properties (`--bg`, `--panel`, …), and monaco-theme.ts builds the editor themes from them.
 * Values follow the 2026-10-14 UI prototype; contrast is checked by tokens.test.ts. Solid colours only, so the
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
    accent: '#6E5BFF',
    onAccent: '#FFFFFF',
    accentText: '#B3A8FF',
    accentSoft: '#22213F',
    ok: '#3DDC97',
    okSoft: '#13271F',
    warn: '#FFB547',
    warnSoft: '#2A2216',
    danger: '#FF7A7A',
    dangerSoft: '#2D1A1D',
    focus: '#B3A8FF',
    lineHighlight: '#1A1C2C',
    selection: '#2E2A5C',
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
    accent: '#6E5BFF',
    onAccent: '#FFFFFF',
    accentText: '#5240E0',
    accentSoft: '#EEEBFF',
    ok: '#0F7A4B',
    okSoft: '#E2F5EC',
    warn: '#8F5200',
    warnSoft: '#FFF2DC',
    danger: '#C02F2F',
    dangerSoft: '#FDEAEA',
    focus: '#5240E0',
    lineHighlight: '#F6F5FF',
    selection: '#DCD7FF',
    syntaxTag: '#2557C7',
    syntaxAttribute: '#A35200',
    syntaxString: '#0F7A4B',
    syntaxComment: '#636B7D',
    syntaxKeyword: '#6E3FD6',
    syntaxNumber: '#B0306A',
  },
};

/** `syntaxTag` → `--syntax-tag`. */
export function cssVariableName(token: keyof ThemeTokens): string {
  return `--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** The custom properties the stylesheet reads, for one scheme. */
export function cssVariables(scheme: ColorScheme): Record<string, string> {
  const tokens = THEMES[scheme];
  return Object.fromEntries(
    (Object.keys(tokens) as (keyof ThemeTokens)[]).map((key) => [cssVariableName(key), tokens[key]]),
  );
}

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
