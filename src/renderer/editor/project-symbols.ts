/**
 * Project symbols for context-aware completion (S43.4 / S43.5, decision 0032 "Context-aware completion"): the ids and
 * classes a file defines. HTML: `id="…"` and `class="…"` attributes plus the selectors of its `<style>` blocks. CSS:
 * `#id` / `.class` in selectors only — never in declaration blocks (`color: #fff`, `margin: .5em`), comments, strings or
 * `url(…)`. Selectors inside conditional group rules (`@media`, `@supports`, …) count.
 *
 * Pure and Monaco-free; every scan is linear (no backtracking regex over the whole text), so a 256 KB file is cheap.
 * Texts are never logged.
 */

export interface FileSymbols {
  readonly ids: readonly string[];
  readonly classes: readonly string[];
}

/** At-rules whose block contains rules (selectors), not declarations. */
const GROUP_AT_RULES = new Set([
  'media',
  'supports',
  'container',
  'layer',
  'document',
  '-moz-document',
  'scope',
  'starting-style',
]);

/** Template syntax in an attribute value means the value is not a literal name. */
const TEMPLATE = /\{\{|\$\{|<%|\{%/;

const isIdentStart = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '-' || c === '\\' || c > '\u007f';
const isIdentChar = (c: string): boolean => isIdentStart(c) || (c >= '0' && c <= '9');
const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/** Block kinds of the CSS scanner: a block of rules (top level, `@media`), of declarations, or anything else. */
export type CssBlock = 'rules' | 'decl' | 'other';

/** Where a CSS scan stopped (the end of the text, e.g. the cursor). */
export interface CssScanEnd {
  /** The kind of block the end is in ('rules' at top level). */
  readonly block: CssBlock;
  /** The end is inside a comment. */
  readonly inComment: boolean;
  /** The end is inside a string: the index of its opening quote. */
  readonly string: { readonly start: number } | null;
  /** The end is inside an unquoted `url(`: index of the first character of its content. */
  readonly url: { readonly start: number } | null;
  /** Text of the current prelude (selector or at-rule) so far, strings and comments replaced by a space. */
  readonly prelude: string;
}

/**
 * One linear pass over CSS: calls `onSelector` for every rule prelude met in a 'rules' block, and returns the state at
 * the end of the text. Shared by the extractor and by completion-context.
 */
export function scanCss(text: string, onSelector?: (selector: string) => void): CssScanEnd {
  const n = text.length;
  const stack: CssBlock[] = [];
  let chunks: string[] = [];
  let segStart = 0;
  const top = (): CssBlock => stack[stack.length - 1] ?? 'rules';
  const prelude = (end: number): string => chunks.join('') + text.slice(segStart, end);
  const reset = (next: number): void => {
    chunks = [];
    segStart = next;
  };
  const mask = (from: number, to: number): void => {
    chunks.push(text.slice(segStart, from), ' ');
    segStart = to;
  };
  const end = (extra: Partial<Pick<CssScanEnd, 'inComment' | 'string' | 'url'>>, at: number): CssScanEnd => ({
    block: top(),
    inComment: extra.inComment ?? false,
    string: extra.string ?? null,
    url: extra.url ?? null,
    prelude: prelude(at),
  });

  let i = 0;
  while (i < n) {
    const c = text[i] ?? '';
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) return end({ inComment: true }, i);
      mask(i, close + 2);
      i = close + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        const d = text[j];
        if (d === '\\') j += 2;
        else if (d === c || d === '\n') break;
        else j++;
      }
      if (j >= n) return end({ string: { start: i } }, i);
      mask(i, j + 1);
      i = j + 1;
      continue;
    }
    if ((c === 'u' || c === 'U') && text.slice(i, i + 4).toLowerCase() === 'url(' && !isIdentChar(text[i - 1] ?? ' ')) {
      let j = i + 4;
      while (j < n && isSpace(text[j] ?? '')) j++;
      if (j >= n) return end({ url: { start: j } }, i);
      const q = text[j];
      if (q !== '"' && q !== "'") {
        const close = text.indexOf(')', j);
        if (close < 0) return end({ url: { start: j } }, i);
        mask(i, close + 1);
        i = close + 1;
        continue;
      }
      i = j; // the quoted argument is an ordinary string
      continue;
    }
    if (c === '{') {
      const ctx = top();
      if (ctx === 'rules') {
        const sel = prelude(i).trim();
        if (sel.startsWith('@')) {
          let k = 1;
          while (k < sel.length && isIdentChar(sel[k] ?? '')) k++;
          stack.push(GROUP_AT_RULES.has(sel.slice(1, k).toLowerCase()) ? 'rules' : 'other');
        } else {
          if (sel && onSelector) onSelector(sel);
          stack.push('decl');
        }
      } else {
        stack.push('other');
      }
      reset(i + 1);
    } else if (c === '}') {
      stack.pop();
      reset(i + 1);
    } else if (c === ';') {
      reset(i + 1);
    }
    i++;
  }
  return end({}, n);
}

/** Reads a CSS identifier starting at `i` (handles `\:`-style escapes); returns the name and the index after it. */
function readCssIdent(s: string, i: number): { name: string; next: number } {
  let name = '';
  let k = i;
  while (k < s.length) {
    const c = s[k] ?? '';
    if (c === '\\' && k + 1 < s.length) {
      name += s[k + 1] ?? '';
      k += 2;
    } else if (isIdentChar(c)) {
      name += c;
      k++;
    } else break;
  }
  return { name, next: k };
}

/** Adds the `#id` / `.class` names of one selector list (attribute selectors `[…]` are skipped). */
function selectorSymbols(sel: string, ids: Set<string>, classes: Set<string>): void {
  let bracket = 0;
  let i = 0;
  while (i < sel.length) {
    const c = sel[i] ?? '';
    if (c === '[') bracket++;
    else if (c === ']') bracket = Math.max(0, bracket - 1);
    else if (bracket === 0 && (c === '#' || c === '.') && isIdentStart(sel[i + 1] ?? '')) {
      const second = sel[i + 2] ?? '';
      // `.-1` / `#-1` are not identifiers
      if (!(sel[i + 1] === '-' && second >= '0' && second <= '9')) {
        const { name, next } = readCssIdent(sel, i + 1);
        if (name) (c === '#' ? ids : classes).add(name);
        i = next;
        continue;
      }
    }
    i++;
  }
}

function cssInto(text: string, ids: Set<string>, classes: Set<string>): void {
  scanCss(text, (sel) => selectorSymbols(sel, ids, classes));
}

/** `#id` and `.class` names used in the selectors of a style sheet, first-seen order, case-sensitive. */
export function extractCssSymbols(text: string): FileSymbols {
  const ids = new Set<string>();
  const classes = new Set<string>();
  cssInto(text, ids, classes);
  return { ids: [...ids], classes: [...classes] };
}

const isTagStart = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

/** ids and classes an HTML document defines (attributes and `<style>` selectors), first-seen order, case-sensitive. */
export function extractHtmlSymbols(text: string): FileSymbols {
  const ids = new Set<string>();
  const classes = new Set<string>();
  const n = text.length;
  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4);
      if (close < 0) break;
      i = close + 3;
      continue;
    }
    if (!isTagStart(text[lt + 1] ?? '')) {
      i = lt + 1;
      continue;
    }
    let k = lt + 1;
    while (k < n && /[\w:-]/.test(text[k] ?? '')) k++;
    const tag = text.slice(lt + 1, k).toLowerCase();
    // attributes
    while (k < n) {
      while (k < n && (isSpace(text[k] ?? '') || text[k] === '/')) k++;
      if (k >= n || text[k] === '>') break;
      const nameStart = k;
      while (k < n) {
        const c = text[k] ?? '';
        if (isSpace(c) || c === '=' || c === '>' || c === '/') break;
        k++;
      }
      if (k === nameStart) {
        k++;
        continue;
      }
      const attr = text.slice(nameStart, k).toLowerCase();
      while (k < n && isSpace(text[k] ?? '')) k++;
      if (text[k] !== '=') continue;
      k++;
      while (k < n && isSpace(text[k] ?? '')) k++;
      let value: string;
      const q = text[k];
      if (q === '"' || q === "'") {
        const close = text.indexOf(q, k + 1);
        value = text.slice(k + 1, close < 0 ? n : close);
        k = close < 0 ? n : close + 1;
      } else {
        const vs = k;
        while (k < n && !isSpace(text[k] ?? '') && text[k] !== '>') k++;
        value = text.slice(vs, k);
      }
      if ((attr === 'id' || attr === 'class') && !TEMPLATE.test(value)) {
        if (attr === 'id') {
          const id = value.trim();
          if (id && !/\s/.test(id)) ids.add(id);
        } else {
          for (const cls of value.split(/\s+/)) if (cls) classes.add(cls);
        }
      }
    }
    i = k + 1;
    if (tag === 'script' || tag === 'style') {
      const close = new RegExp(`</${tag}`, 'gi');
      close.lastIndex = i;
      const m = close.exec(text);
      const contentEnd = m ? m.index : n;
      if (tag === 'style') cssInto(text.slice(i, contentEnd), ids, classes);
      i = m ? contentEnd + m[0].length : n;
    }
  }
  return { ids: [...ids], classes: [...classes] };
}
