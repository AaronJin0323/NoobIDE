/**
 * S48.5: syntax colours for chat code blocks. The bundled Monaco tokenizer (code-highlight-monaco.ts, loaded lazily
 * with the editor chunk) turns the code into token types such as `keyword.js` or `attribute.name.html`; this module
 * colours them with the editor's own theme rules (theme/monaco-theme.ts) for the current colour scheme, the way Monaco
 * matches theme rules (the most specific dotted prefix wins). Pure TypeScript, no Monaco and no DOM, so the chat can
 * render cached tokens synchronously and tests can render them with renderToStaticMarkup. Offline: nothing is fetched.
 */
import { buildMonacoTheme } from '../theme/monaco-theme';
import type { ColorScheme } from '../theme/tokens';

/** One token of a line: its text and Monaco's token type ('' for plain text). */
export interface CodeToken {
  readonly text: string;
  readonly type: string;
}

/** A Monaco token as `monaco.editor.tokenize` reports it: where it starts in its line and its type. */
export interface RawToken {
  readonly offset: number;
  readonly type: string;
}

/** Fence languages → the Monaco language that colours them (only the languages NoobIDE bundles). */
const LANGUAGES: Readonly<Record<string, string>> = {
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  svg: 'html',
  xml: 'html',
  css: 'css',
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  json: 'json',
  ts: 'typescript',
  typescript: 'typescript',
};

/** The Monaco language for a fence language (lowercase), or null when the code stays uncoloured. */
export function languageIdOf(lang: string): string | null {
  return LANGUAGES[lang.toLowerCase()] ?? null;
}

/** Code longer than this is shown uncoloured (tokenizing it would hold up the chat). */
export const MAX_HIGHLIGHT_CHARS = 20_000;

/** Splits each line's text at Monaco's token offsets. `lines` has one entry per line of `text`. */
export function toTokenLines(text: string, lines: readonly (readonly RawToken[])[]): CodeToken[][] {
  return text.split('\n').map((line, i) => {
    const raw = lines[i] ?? [];
    if (raw.length === 0) return line ? [{ text: line, type: '' }] : [];
    const tokens: CodeToken[] = [];
    if ((raw[0]?.offset ?? 0) > 0) tokens.push({ text: line.slice(0, raw[0]?.offset ?? 0), type: '' });
    raw.forEach((token, j) => {
      const end = raw[j + 1]?.offset ?? line.length;
      const slice = line.slice(token.offset, end);
      if (slice) tokens.push({ text: slice, type: token.type });
    });
    return tokens;
  });
}

export interface TokenStyle {
  /** `#RRGGBB` of the editor theme. */
  readonly color: string;
  readonly italic: boolean;
}

interface ResolvedRule {
  readonly foreground: string | undefined;
  readonly fontStyle: string | undefined;
}

const ruleTables = new Map<ColorScheme, Map<string, ResolvedRule>>();

function rulesOf(scheme: ColorScheme): Map<string, ResolvedRule> {
  let table = ruleTables.get(scheme);
  if (!table) {
    table = new Map();
    // A later rule for the same token wins, as in Monaco.
    for (const rule of buildMonacoTheme(scheme).rules) {
      table.set(rule.token, { foreground: rule.foreground, fontStyle: rule.fontStyle });
    }
    ruleTables.set(scheme, table);
  }
  return table;
}

/** The colour of a token type in the editor theme of `scheme`: the most specific matching rule, else the default. */
export function tokenStyle(scheme: ColorScheme, type: string): TokenStyle {
  const rules = rulesOf(scheme);
  const parts = type ? type.split('.') : [];
  const fallback = rules.get('');
  let foreground: string | undefined;
  let fontStyle: string | undefined;
  for (let k = parts.length; k > 0 && (foreground === undefined || fontStyle === undefined); k -= 1) {
    const rule = rules.get(parts.slice(0, k).join('.'));
    if (!rule) continue;
    foreground ??= rule.foreground;
    fontStyle ??= rule.fontStyle;
  }
  return {
    color: `#${foreground ?? fallback?.foreground ?? ''}`,
    italic: (fontStyle ?? fallback?.fontStyle ?? '').includes('italic'),
  };
}

// Tokenized blocks by language and text, so a re-render (or the same block in a reopened chat) is coloured at once.
const cache = new Map<string, CodeToken[][]>();
const CACHE_LIMIT = 200;
const keyOf = (languageId: string, text: string) => `${languageId}\u0000${text}`;

export function cachedTokens(languageId: string, text: string): CodeToken[][] | null {
  return cache.get(keyOf(languageId, text)) ?? null;
}

export function rememberTokens(languageId: string, text: string, lines: CodeToken[][]): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(keyOf(languageId, text), lines);
}
