/**
 * S41.2: where an element the user pointed at in the preview comes from in the project's files (decision 0030).
 * Pure functions over text; main reads the files (inside the project root only) and calls these.
 *
 * The page (isolated world, element-target.ts) reports the element's **ancestry** — tag and nth-of-type per level, from
 * the top of the document down to the element — with the levels a browser adds by itself flattened away (`html`,
 * `head`, `body`, `tbody`: a beginner's file often has none of them, and the browser moves `<title>` into `head` and
 * everything else into `body`). This module builds a small position-tracking tree of the HTML text with the same
 * flattening and follows that ancestry:
 *
 * - **exact**: every level is found and the element's id and text agree with the page;
 * - **approximate**: the ancestry did not lead to it (the page changed the DOM with script, or the file and the page
 *   differ), but an element with the same id, or the same tag + classes + text, is unique in the file;
 * - **none**: nothing in the file fits — typically an element a script created. Never a guessed "exact".
 *
 * Tree building is deliberately simple and bounded (`MAX_LOCATE_CHARS`): void elements, `<x />`, comments, doctype,
 * raw text (`script`, `style`, `textarea`, `title`), and the implied end tags beginners rely on (`p`, `li`, `dt`/`dd`,
 * `tr`, `td`/`th`, `option`). Lines are 1-based; CRLF counts as one line break.
 *
 * CSS rules are found by their selector text (normalised: whitespace, quotes and case ignored) and the occurrence among
 * rules with that same selector, at any `@media`/`@supports` depth, with comments and strings skipped.
 */

export const MAX_LOCATE_CHARS = 2 * 1024 * 1024;

export interface AncestryStep {
  /** Lower-case tag name. */
  readonly tag: string;
  /** 1-based position among the (flattened) siblings with the same tag. */
  readonly nth: number;
}

export interface ElementQuery {
  /** From the top of the document down to the element itself (inclusive), flattened like {@link FLATTENED}. */
  readonly ancestry: readonly AncestryStep[];
  readonly tag: string;
  readonly id?: string | undefined;
  readonly classes: readonly string[];
  /** The element's first text, whitespace collapsed (may be cut). */
  readonly text: string;
}

export interface SourceRange {
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  /** UTF-16 offsets in the text, end exclusive. */
  readonly startOffset: number;
  readonly endOffset: number;
}

export type MatchQuality = 'exact' | 'approximate';

export interface ElementLocation extends SourceRange {
  readonly match: MatchQuality;
}

/** Levels the browser adds or moves things into by itself; they are skipped on both sides. */
export const FLATTENED: ReadonlySet<string> = new Set(['html', 'head', 'body', 'tbody']);

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]); // prettier-ignore
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
/** Start tags that close an open `<p>` (HTML's "close a p element" list, the common part). */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'ul',
]); // prettier-ignore
/** For an open element (key), start tags that end it implicitly when it is the current element. */
const IMPLIED_END: Readonly<Record<string, ReadonlySet<string>>> = {
  li: new Set(['li']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
  option: new Set(['option', 'optgroup']),
  tr: new Set(['tr', 'tbody', 'thead', 'tfoot']),
  td: new Set(['td', 'th', 'tr', 'tbody', 'thead', 'tfoot']),
  th: new Set(['td', 'th', 'tr', 'tbody', 'thead', 'tfoot']),
  thead: new Set(['tbody', 'tfoot']),
};

export interface HtmlNode {
  readonly tag: string;
  readonly attrs: ReadonlyMap<string, string>;
  /** Offset of `<` of the start tag. */
  readonly start: number;
  /** Offset just after the end tag (or where the element implicitly ended). */
  end: number;
  readonly children: HtmlNode[];
  /** Text directly and indirectly inside (whitespace collapsed, entities decoded), at most TEXT_CHARS. */
  text: string;
}

const TEXT_CHARS = 400;

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Parses the attributes of a start tag's inside (`a href="x" disabled`). */
function parseAttrs(inside: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inside)) !== null) {
    const name = (m[1] ?? '').toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return attrs;
}

/** End of a tag starting at `from` (`<`): index just after its `>`, honouring quoted attribute values. */
function tagEnd(text: string, from: number): number {
  let quote = '';
  for (let i = from + 1; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i + 1;
  }
  return text.length;
}

/** A synthetic root (`#document`) whose children are the file's top-level elements. */
export function parseHtmlTree(text: string): HtmlNode {
  const root: HtmlNode = { tag: '#document', attrs: new Map(), start: 0, end: text.length, children: [], text: '' };
  if (text.length > MAX_LOCATE_CHARS) return root;
  const stack: HtmlNode[] = [root];
  const top = () => stack[stack.length - 1] ?? root;
  const addText = (raw: string) => {
    const t = collapse(decodeEntities(raw));
    if (!t) return;
    for (const node of stack) {
      if (node === root || node.text.length >= TEXT_CHARS) continue;
      node.text = (node.text ? `${node.text} ${t}` : t).slice(0, TEXT_CHARS);
    }
  };
  /** Ends the current element at `at` (where the token that ended it begins; trailing whitespace excluded). */
  const popTo = (at: number) => {
    const node = stack.pop();
    if (!node) return;
    let end = at;
    while (end > node.start && /\s/.test(text[end - 1] ?? '')) end -= 1;
    node.end = Math.max(end, node.start + 1);
  };

  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      addText(text.slice(i));
      break;
    }
    if (lt > i) addText(text.slice(i, lt));
    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4);
      i = close < 0 ? text.length : close + 3;
      continue;
    }
    if (text[lt + 1] === '!' || text[lt + 1] === '?') {
      i = tagEnd(text, lt);
      continue;
    }
    const endTag = /^<\/([a-zA-Z][^\s/>]*)/.exec(text.slice(lt, lt + 64));
    if (endTag) {
      const name = (endTag[1] ?? '').toLowerCase();
      const after = tagEnd(text, lt);
      const index = stack.map((n) => n.tag).lastIndexOf(name);
      if (index > 0) {
        while (stack.length - 1 > index) popTo(lt);
        const node = stack.pop();
        if (node) node.end = after;
      }
      i = after;
      continue;
    }
    const startTag = /^<([a-zA-Z][^\s/>]*)/.exec(text.slice(lt, lt + 64));
    if (!startTag) {
      addText('<');
      i = lt + 1;
      continue;
    }
    const name = (startTag[1] ?? '').toLowerCase();
    const after = tagEnd(text, lt);
    const selfClosing = text[after - 2] === '/';
    const inside = text.slice(lt + 1 + name.length, selfClosing ? after - 2 : after - 1);

    // Implied end tags of the element being closed by this start tag.
    for (;;) {
      const current = top();
      if (current === root) break;
      if (current.tag === 'p' && CLOSES_P.has(name)) popTo(lt);
      else if (IMPLIED_END[current.tag]?.has(name)) popTo(lt);
      else break;
    }

    const node: HtmlNode = { tag: name, attrs: parseAttrs(inside), start: lt, end: after, children: [], text: '' };
    top().children.push(node);
    if (VOID.has(name) || selfClosing) {
      i = after;
      continue;
    }
    if (RAW_TEXT.has(name)) {
      const close = new RegExp(`</${name}\\s*>`, 'i');
      close.lastIndex = 0;
      const rest = text.slice(after);
      const m = close.exec(rest);
      const contentEnd = m ? after + m.index : text.length;
      if (name === 'title' || name === 'textarea') {
        stack.push(node);
        addText(text.slice(after, contentEnd));
        stack.pop();
      }
      node.end = m ? contentEnd + m[0].length : text.length;
      i = node.end;
      continue;
    }
    stack.push(node);
    i = after;
  }
  while (stack.length > 1) popTo(text.length);
  return root;
}

/** Children of `node` with the {@link FLATTENED} levels replaced by their own children, in document order. */
export function effectiveChildren(node: HtmlNode): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const child of node.children) {
    if (FLATTENED.has(child.tag)) out.push(...effectiveChildren(child));
    else out.push(child);
  }
  return out;
}

function* walk(node: HtmlNode): Generator<HtmlNode> {
  for (const child of node.children) {
    yield child;
    yield* walk(child);
  }
}

/** Line starts of `text` (offset of each line's first character). */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** 1-based line of `offset`. */
export function lineOf(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export function rangeOf(text: string, startOffset: number, endOffset: number, starts = lineStarts(text)): SourceRange {
  return {
    startLine: lineOf(starts, startOffset),
    endLine: lineOf(starts, Math.max(startOffset, endOffset - 1)),
    startOffset,
    endOffset,
  };
}

/** Whether two collapsed texts plausibly are the same element's text (one starts with the other's beginning). */
function textAgrees(source: string, page: string): boolean {
  const a = collapse(source);
  const b = collapse(page).replace(/…$/, '');
  if (!b) return true; // nothing to compare (an image, an empty element)
  if (!a) return false;
  const n = Math.min(a.length, b.length, 40);
  return a.slice(0, n) === b.slice(0, n);
}

function classesOf(node: HtmlNode): string[] {
  return (node.attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
}

function sameClasses(node: HtmlNode, classes: readonly string[]): boolean {
  const own = new Set(classesOf(node));
  return own.size === new Set(classes).size && classes.every((c) => own.has(c));
}

/** Follows the ancestry from the root; the element, or null when a level is missing. */
function follow(root: HtmlNode, ancestry: readonly AncestryStep[]): HtmlNode | null {
  let current = root;
  for (const step of ancestry) {
    if (FLATTENED.has(step.tag)) continue;
    let seen = 0;
    let next: HtmlNode | null = null;
    for (const child of effectiveChildren(current)) {
      if (child.tag !== step.tag) continue;
      seen += 1;
      if (seen === step.nth) {
        next = child;
        break;
      }
    }
    if (!next) return null;
    current = next;
  }
  return current === root ? null : current;
}

/** Where the element described by `query` is in `html`, or null. */
export function locateElement(html: string, query: ElementQuery): ElementLocation | null {
  if (html.length > MAX_LOCATE_CHARS || !query.tag) return null;
  const root = parseHtmlTree(html);
  const starts = lineStarts(html);
  const located = (node: HtmlNode, match: MatchQuality): ElementLocation => ({
    ...rangeOf(html, node.start, node.end, starts),
    match,
  });
  const tag = query.tag.toLowerCase();

  const byAncestry = follow(root, query.ancestry);
  if (
    byAncestry &&
    byAncestry.tag === tag &&
    (byAncestry.attrs.get('id') ?? '') === (query.id ?? '') &&
    textAgrees(byAncestry.text, query.text)
  ) {
    return located(byAncestry, 'exact');
  }

  const all = [...walk(root)].filter((n) => n.tag === tag);
  if (query.id) {
    const withId = all.filter((n) => n.attrs.get('id') === query.id);
    if (withId.length === 1 && withId[0]) return located(withId[0], 'approximate');
    if (withId.length > 1) return null;
  }
  // Tag + classes + text: only when that leaves exactly one element (and there is something to compare).
  if (query.classes.length === 0 && !collapse(query.text)) return null;
  const fits = all.filter(
    (n) => (!query.id || !n.attrs.has('id')) && sameClasses(n, query.classes) && textAgrees(n.text, query.text),
  );
  return fits.length === 1 && fits[0] ? located(fits[0], 'approximate') : null;
}

/** The content range (inside the tags) of the `index`-th (0-based) `<style>` element of `html`, or null. */
export function styleBlock(html: string, index: number): { start: number; end: number } | null {
  if (html.length > MAX_LOCATE_CHARS || index < 0) return null;
  const root = parseHtmlTree(html);
  let seen = 0;
  for (const node of walk(root)) {
    if (node.tag !== 'style') continue;
    if (seen === index) {
      const open = tagEnd(html, node.start);
      const close = html.lastIndexOf('</', node.end);
      return { start: open, end: close >= open ? close : node.end };
    }
    seen += 1;
  }
  return null;
}

/** Selector text compared without whitespace, quotes or case (`.a>.b` = `.a > .b`, `[type=text]` = `[type="text"]`). */
export function normalizeSelector(selector: string): string {
  return selector.replace(/[\s"']+/g, '').toLowerCase();
}

/** Comments replaced by spaces (offsets unchanged). */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?(\*\/|$)/g, (c) => ' '.repeat(c.length));
}

/**
 * Where the `occurrence`-th (1-based) rule with `selector` is in `css` (from the selector to its closing brace), or
 * null. `from`/`to` limit the search to part of the text (a `<style>` block's content); offsets stay those of `css`.
 */
export function locateCssRule(
  css: string,
  selector: string,
  occurrence = 1,
  from = 0,
  to = css.length,
): SourceRange | null {
  if (css.length > MAX_LOCATE_CHARS || !selector.trim()) return null;
  const wanted = normalizeSelector(selector);
  const text = blankComments(css);
  let seen = 0;
  let preludeStart = from;
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      i = close < 0 || close >= to ? to : close + 1;
      continue;
    }
    if (c === ';' || c === '}') {
      preludeStart = i + 1;
      i += 1;
      continue;
    }
    if (c !== '{') {
      i += 1;
      continue;
    }
    const prelude = text.slice(preludeStart, i);
    if (prelude.trim().startsWith('@')) {
      // A group rule (@media, @supports …): its rules are searched in place.
      preludeStart = i + 1;
      i += 1;
      continue;
    }
    const blockEnd = matchingBrace(text, i, to);
    if (normalizeSelector(prelude) === wanted) {
      seen += 1;
      if (seen === occurrence) {
        let start = preludeStart;
        while (start < i && /\s/.test(text[start] ?? '')) start += 1;
        return rangeOf(css, start, blockEnd);
      }
    }
    preludeStart = blockEnd;
    i = blockEnd;
  }
  return null;
}

/** Index just after the `}` closing the block opened at `open`, or `to`. */
function matchingBrace(text: string, open: number, to: number): number {
  let depth = 0;
  for (let i = open; i < to; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      if (close < 0 || close >= to) return to;
      i = close;
    } else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return to;
}

/** At most `maxLines` numbered lines of `text` from `range` (`  14 | <button …>`), for the AI context. */
export function numberedExcerpt(text: string, range: SourceRange, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  const last = Math.min(range.endLine, range.startLine + maxLines - 1);
  const width = String(last).length;
  const out: string[] = [];
  for (let n = range.startLine; n <= last; n += 1) {
    out.push(`${String(n).padStart(width, ' ')} | ${(lines[n - 1] ?? '').slice(0, 300)}`);
  }
  if (last < range.endLine) out.push(`${' '.repeat(width)} | …`);
  return out.join('\n');
}
