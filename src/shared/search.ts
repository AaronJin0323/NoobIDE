/**
 * Text search rules shared by the project search in main (S51.2) and replace in files in the renderer (S51.4). Both
 * sides build the same regular expression and walk the same per-line matches, so a match the panel shows (line and
 * column) is exactly the one a replace changes.
 *
 * Pure TypeScript: no Electron, Node or DOM imports.
 */

export interface SearchQuery {
  /** What to look for: literal text, or a JavaScript regular expression when `regex` is set. */
  readonly text: string;
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  /** Only matches that are not part of a longer word (letters, digits, `_`, any script). */
  readonly wholeWord: boolean;
}

/** Longest query accepted (characters). */
export const MAX_QUERY_LENGTH = 1000;

export type QueryRegex =
  { readonly ok: true; readonly regex: RegExp } | { readonly ok: false; readonly message: string };

/** Characters with a meaning in a regular expression that are valid escaped also with the `u` flag. */
const SYNTAX = /[.*+?^${}()|[\]\\]/g;

export function escapeRegex(text: string): string {
  return text.replace(SYNTAX, '\\$&');
}

/**
 * The global regular expression of a query, or why it is invalid. Literal text is escaped. A regular expression is
 * compiled with the `u` flag (Unicode: Chinese text, `\p{…}`) when it allows it, otherwise without, as beginners copy
 * patterns from tutorials written for either. Never throws.
 */
export function buildQueryRegex(query: SearchQuery): QueryRegex {
  if (query.text.length === 0) return { ok: false, message: 'empty query' };
  const source = query.regex ? query.text : escapeRegex(query.text);
  const flags = query.caseSensitive ? 'g' : 'gi';
  const attempt = (unicode: boolean): RegExp => {
    // Word characters of every script with `u`; without it, everything outside ASCII punctuation counts as a letter.
    const word = unicode ? '[\\p{L}\\p{N}\\p{M}_]' : '[A-Za-z0-9_\\u00C0-\\uFFFF]';
    const wrapped = query.wholeWord ? `(?<!${word})(?:${source})(?!${word})` : source;
    return new RegExp(wrapped, unicode ? `${flags}u` : flags);
  };
  try {
    return { ok: true, regex: attempt(true) };
  } catch {
    if (!query.regex) return { ok: false, message: 'invalid query' };
    try {
      return { ok: true, regex: attempt(false) };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}

export interface LineMatch {
  /** 0-based UTF-16 offset in the line. */
  readonly index: number;
  readonly length: number;
  /** The exec result, for `$1`-style replacement. */
  readonly groups: RegExpExecArray;
}

/**
 * Non-empty matches of `regex` (global) in one line, left to right. Empty matches (e.g. `a*` between letters) are
 * skipped: there is nothing to show or replace.
 */
export function* lineMatches(line: string, regex: RegExp): Generator<LineMatch> {
  regex.lastIndex = 0;
  for (let found = regex.exec(line); found !== null; found = regex.exec(line)) {
    if (found[0].length === 0) {
      // Step over the empty match (a whole code point with the `u` flag).
      const code = line.codePointAt(regex.lastIndex);
      regex.lastIndex += regex.unicode && code !== undefined && code > 0xffff ? 2 : 1;
      if (regex.lastIndex > line.length) break;
      continue;
    }
    yield { index: found.index, length: found[0].length, groups: found };
  }
}

/** Splits text into lines; `separators[i]` is the line break after `lines[i]` (`''` after the last line). */
export function splitLines(text: string): { lines: string[]; separators: string[] } {
  const parts = text.split(/(\r\n|\n|\r)/);
  const lines: string[] = [];
  const separators: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts[i] as string);
    separators.push(parts[i + 1] ?? '');
  }
  return { lines, separators };
}

/** The key that identifies one match in a file: 1-based line and column (UTF-16), as shown in the panel. */
export const matchKey = (line: number, column: number) => `${line}:${column}`;

/**
 * The replacement text of one match: literal text as typed, or for a regular expression with `$&`, `$1`…`$99`,
 * `$<name>` and `$$` expanded like String.prototype.replace.
 */
export function expandReplacement(template: string, match: RegExpExecArray, regexMode: boolean): string {
  if (!regexMode) return template;
  return template.replace(/\$(\$|&|\d{1,2}|<([^>]*)>)/g, (whole, token: string, name: string | undefined) => {
    if (token === '$') return '$';
    if (token === '&') return match[0];
    if (name !== undefined) {
      const named = match.groups?.[name];
      return match.groups ? (named ?? '') : whole;
    }
    // Two digits only when that group exists (`$10` with one group is `$1` followed by "0").
    const two = Number(token);
    if (token.length === 2 && two > 0 && two < match.length) return match[two] ?? '';
    const one = Number(token[0]);
    if (one > 0 && one < match.length) return (match[one] ?? '') + token.slice(1);
    return whole;
  });
}

export interface ReplaceOutcome {
  readonly text: string;
  /** Matches replaced. */
  readonly replaced: number;
}

/**
 * Replaces the matches of `query` in `text` whose key (matchKey) is in `only` — every match when `only` is null.
 * Line breaks are kept exactly as they are.
 */
export function replaceInText(
  text: string,
  query: SearchQuery,
  replacement: string,
  only: ReadonlySet<string> | null,
): ReplaceOutcome | null {
  const built = buildQueryRegex(query);
  if (!built.ok) return null;
  const { lines, separators } = splitLines(text);
  let replaced = 0;
  const out: string[] = [];
  lines.forEach((line, i) => {
    let result = '';
    let at = 0;
    for (const match of lineMatches(line, built.regex)) {
      if (only && !only.has(matchKey(i + 1, match.index + 1))) continue;
      result += line.slice(at, match.index) + expandReplacement(replacement, match.groups, query.regex);
      at = match.index + match.length;
      replaced += 1;
    }
    out.push(result + line.slice(at), separators[i] as string);
  });
  return { text: out.join(''), replaced };
}

/**
 * A fingerprint of a text's content, line endings aside (cyrb53, 53 bits, plus the length): main reports it for every
 * searched file, and replace in files compares it with the file's text right before replacing, so a file that changed
 * since the search (on disk or in the editor) is refused instead of edited at stale positions. Not a security hash.
 */
export function textFingerprint(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${normalized.length.toString(36)}-${hash.toString(36)}`;
}

/**
 * What one listed match becomes, for the replace preview: the match in its context line re-run with the same
 * regular expression (so `$1` shows the captured text). Null when the query is invalid or the match is not found there.
 */
export function replacementForMatch(
  query: SearchQuery,
  replacement: string,
  preview: string,
  previewStart: number,
): string | null {
  const built = buildQueryRegex(query);
  if (!built.ok) return null;
  for (const match of lineMatches(preview, built.regex)) {
    if (match.index === previewStart) return expandReplacement(replacement, match.groups, query.regex);
    if (match.index > previewStart) break;
  }
  return null;
}
