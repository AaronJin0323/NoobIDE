/**
 * Emmet abbreviations on Tab (S53.1, decision 0039). Pure: decides whether the text before the cursor is an
 * abbreviation in a place where one makes sense, and expands it to a Monaco snippet. Monaco is connected in
 * emmet-monaco.ts; anything this returns null for gets the normal Tab (indent), so Tab keeps working as before.
 *
 * Deliberately narrower than Emmet itself, for beginners who press Tab to indent:
 * - HTML: only in text content (never inside a tag, a comment or `<script>`), and every element name in the
 *   abbreviation must be a real HTML element or an Emmet snippet (`hello` + Tab indents; it does not become `<hello>`).
 * - CSS (files and `<style>`): only where a property starts inside a rule, and only when Emmet knows the property
 *   (`m10` → `margin: 10px;`, but `foo` + Tab indents instead of guessing a property).
 */
import expand, { extract } from 'emmet';
import { htmlRegion } from './completion-context';

export type EmmetSyntax = 'html' | 'css';

export interface EmmetExpansion {
  /** Offsets (in the document) of the abbreviation that is replaced. */
  readonly start: number;
  readonly end: number;
  /** Monaco snippet text (`${1}` tab stops). */
  readonly snippet: string;
  readonly abbreviation: string;
}

/** Longest line Emmet looks at; a longer one gets the normal Tab. */
const MAX_LINE = 1_000;

/** Element names of HTML (WHATWG living standard), lower case. */
const HTML_ELEMENTS = new Set(
  (
    'a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col ' +
    'colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 ' +
    'h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu ' +
    'meta meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp script ' +
    'search section select slot small source span strong style sub summary sup table tbody td template textarea ' +
    'tfoot th thead time title tr track u ul var video wbr svg math'
  ).split(' '),
);

/** Emmet's own markup snippets a beginner meets in tutorials (`!` page skeleton, `link:css`, `btn`, `lorem`…). */
const EMMET_SNIPPET = /^(?:!|!!!|doc|html:5|c|bq|btn|inp|sect|art|hdr|ftr|tarea|fig|figc|pic|ifr|lorem\d*)$|:/;

function knownName(name: string): boolean {
  const lower = name.toLowerCase();
  return HTML_ELEMENTS.has(lower) || EMMET_SNIPPET.test(lower);
}

/** Element names written in a markup abbreviation (`ul>li.item*3+p` → ul, li, p). */
function elementNames(abbreviation: string): string[] {
  // Text in `{…}` and attribute values in `[…]` are not names.
  const bare = abbreviation.replace(/\{[^}]*\}/g, '').replace(/\[[^\]]*\]/g, '');
  return [...bare.matchAll(/(?:^|[>+^(])([a-zA-Z!][\w:!-]*)/g)].map((m) => m[1] ?? '');
}

/** Whether the markup text from `from` to `offset` leaves the cursor in text content: not in a tag or a comment. */
function inTextContent(text: string, from: number, offset: number): boolean {
  let i = from;
  while (i < offset) {
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4);
      if (close < 0 || close + 3 > offset) return false;
      i = close + 3;
    } else if (text[i] === '<') {
      const close = text.indexOf('>', i + 1);
      if (close < 0 || close >= offset) return false;
      i = close + 1;
    } else i += 1;
  }
  return true;
}

/** CSS text from `from` to the abbreviation: the abbreviation is where a property starts inside a rule. */
function atPropertyStart(text: string, from: number, abbreviationStart: number): boolean {
  let depth = 0;
  let lastStop = from - 1; // index of the last `{`, `;` or `}`
  let i = from;
  while (i < abbreviationStart) {
    const ch = text[i];
    if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      if (close < 0 || close + 2 > abbreviationStart) return false;
      i = close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const close = text.indexOf(ch, i + 1);
      if (close < 0 || close >= abbreviationStart) return false;
      i = close + 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === '{' || ch === '}' || ch === ';') lastStop = i;
    i += 1;
  }
  if (depth === 0) return false; // a selector, not a declaration
  return text.slice(lastStop + 1, abbreviationStart).trim() === '';
}

const field = (index: number, placeholder: string) => `\${${index}${placeholder ? `:${placeholder}` : ''}}`;

function expandCss(abbreviation: string): string | null {
  if (!/^[a-z!@-][\w:%.#!+-]*$/i.test(abbreviation)) return null;
  let out: string;
  try {
    out = expand(abbreviation, {
      type: 'stylesheet',
      options: { 'output.field': field, 'stylesheet.fuzzySearchMinScore': 0.5 },
    });
  } catch {
    return null;
  }
  // Emmet answers a word it does not know with `word: ;` (no property matched): that is not an expansion.
  const property = /^([\w-]+)\s*:([^;]*);?$/s.exec(out);
  if (property && property[1] === abbreviation.toLowerCase()) {
    const value = (property[2] ?? '').replace(/\$\{\d+(?::[^}]*)?\}/g, '').trim();
    if (value === '') return null;
  }
  return out;
}

function expandMarkup(abbreviation: string, lang: string): string | null {
  const names = elementNames(abbreviation);
  // `.box` and `#main` are a div; anything named must be real.
  if (!/^[.#]/.test(abbreviation) && names.length === 0) return null;
  if (!names.every(knownName)) return null;
  try {
    return expand(abbreviation, { options: { 'output.field': field }, variables: { lang } });
  } catch {
    return null;
  }
}

/**
 * The expansion of the abbreviation that ends at `offset`, or null when Tab should do what it always does.
 * `syntax` is the document's language; inside an HTML page's `<style>` the CSS rules apply.
 */
export function emmetExpansionAt(
  text: string,
  offset: number,
  syntax: EmmetSyntax,
  options: { readonly lang?: string } = {},
): EmmetExpansion | null {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const line = text.slice(lineStart, offset);
  if (line.length > MAX_LINE || line.trim() === '') return null;
  // Only at the end of a word: Tab in front of text (or in the middle of a word) indents.
  const after = text[offset];
  if (after !== undefined && /[\w.#>*+^$@!:-]/.test(after)) return null;

  let css = syntax === 'css';
  let regionStart = 0;
  if (syntax === 'html') {
    const region = htmlRegion(text, offset);
    if (region.region === 'script') return null;
    css = region.region === 'style';
    regionStart = region.start;
  }
  const found = extract(line, line.length, { type: css ? 'stylesheet' : 'markup', lookAhead: false });
  if (!found || found.end !== line.length || !found.abbreviation) return null;
  const abbreviation = found.abbreviation;
  const start = lineStart + found.start;
  if (start < regionStart) return null;
  if (css) {
    if (!atPropertyStart(text, regionStart, start)) return null;
    const snippet = expandCss(abbreviation);
    return snippet ? { start, end: offset, snippet, abbreviation } : null;
  }
  if (!inTextContent(text, regionStart, start)) return null;
  const snippet = expandMarkup(abbreviation, options.lang ?? 'en');
  return snippet ? { start, end: offset, snippet, abbreviation } : null;
}
