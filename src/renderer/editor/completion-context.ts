/**
 * Completion context engine (S43.4 / S43.5, decision 0032 "Context-aware completion"). Given a language and the text
 * before the cursor, it says whether NoobIDE has something specific to suggest there: a project id, a class, a selector,
 * a CSS `#id`, or a project file path. Everywhere else it returns `null` and the language services answer alone.
 *
 * - JS: string argument of `getElementById(` (id), `querySelector(All)(` / `closest(` / `matches(` (selector: `#…` id,
 *   `.…` class, bare word → selector), `getElementsByClassName(` / `classList.add|remove|toggle|contains|replace(`
 *   (class), `import … from '` / `import('` / `export … from '` (path, `.js` / `.mjs`).
 * - CSS: `.…` / `#…` in a selector (not in a declaration block), `url(` (media), `@import '…'` (css).
 * - HTML: `class="… ` (last word), `id`-references (`href="#…` on links, `for="` on labels), `src` / `href` / `action`
 *   (path, accepted kinds by element). `<script>` / `<style>` regions are treated as JS / CSS.
 *
 * Pure and Monaco-free; the caller passes a bounded window (~2000 chars). Nothing is logged.
 */
import { scanCss } from './project-symbols';

export type PathAccept = 'media' | 'css' | 'js' | 'html' | 'any';

export type CompletionContext =
  | { readonly kind: 'id'; readonly prefix: string }
  | { readonly kind: 'class'; readonly prefix: string }
  | { readonly kind: 'selector'; readonly prefix: string }
  | { readonly kind: 'css-id'; readonly prefix: string }
  | { readonly kind: 'path'; readonly prefix: string; readonly accept: PathAccept; readonly js: boolean };

type Region = 'script' | 'style' | 'markup';

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isWordChar = (c: string): boolean => /[\w$]/.test(c) || c > '\u007f';
const NAME = /^(?:[\w-]|[\u0080-￿])*$/;

/** Region and the index where its content starts. */
export function htmlRegion(text: string, offset: number): { region: Region; start: number } {
  const t = text.slice(0, offset);
  const open = /<!--|<(script|style)(?=[\s>/])/gi;
  let m: RegExpExecArray | null;
  let start = 0;
  while ((m = open.exec(t)) !== null) {
    if (m[0] === '<!--') {
      const close = t.indexOf('-->', m.index + 4);
      if (close < 0) return { region: 'markup', start };
      open.lastIndex = close + 3;
      start = close + 3;
      continue;
    }
    const name = (m[1] ?? '').toLowerCase() as 'script' | 'style';
    const gt = t.indexOf('>', open.lastIndex);
    if (gt < 0) return { region: 'markup', start };
    const close = new RegExp(`</${name}`, 'gi');
    close.lastIndex = gt + 1;
    const c = close.exec(t);
    if (!c) return { region: name, start: gt + 1 };
    open.lastIndex = c.index + c[0].length;
    start = open.lastIndex;
  }
  return { region: 'markup', start };
}

/** Region of an HTML document at an offset: inside <script>…</script> (JS), <style>…</style> (CSS), or markup. */
export function htmlRegionAt(text: string, offset: number): 'script' | 'style' | 'markup' {
  return htmlRegion(text, offset).region;
}

/** A path prefix NoobIDE can complete: relative, no URL scheme, no protocol-relative or absolute path. */
function pathContext(prefix: string, accept: PathAccept, js: boolean): CompletionContext | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(prefix) || prefix.startsWith('/') || prefix.startsWith('\\')) return null;
  if (/\{\{|\$\{|<%|\{%|[?#]/.test(prefix)) return null;
  return { kind: 'path', prefix, accept, js };
}

/** Text after the last occurrence of any of `stops`. */
function lastPiece(s: string, stops: string): string {
  let i = s.length;
  while (i > 0 && !stops.includes(s[i - 1] ?? '')) i--;
  return s.slice(i);
}

function selectorContext(content: string): CompletionContext | null {
  const piece = lastPiece(content, ' \t\n>+~,(');
  let i = piece.length;
  while (i > 0 && NAME.test(piece[i - 1] ?? '')) i--;
  const word = piece.slice(i);
  const before = piece[i - 1];
  if (before === '#') return { kind: 'id', prefix: word };
  if (before === '.') return { kind: 'class', prefix: word };
  if (i === 0) return { kind: 'selector', prefix: word };
  return null;
}

// ---------------------------------------------------------------- JavaScript

interface Frame {
  readonly callee: string;
  arg: number;
}

const REGEX_AFTER = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);

/** Identifier (with one `obj.` qualifier) right before index `end` (exclusive), skipping whitespace. */
function calleeBefore(src: string, end: number): string {
  let k = end;
  const skip = (): void => {
    while (k > 0 && isSpace(src[k - 1] ?? '')) k--;
  };
  const ident = (): string => {
    const e = k;
    while (k > 0 && isWordChar(src[k - 1] ?? '')) k--;
    return src.slice(k, e);
  };
  skip();
  const name = ident();
  if (!name) return '';
  skip();
  if (src[k - 1] !== '.') return name;
  k--;
  if (src[k - 1] === '?') k--;
  skip();
  const obj = ident();
  return obj ? `${obj}.${name}` : name;
}

/** Scans JS; when the end is inside a string returns its opening quote and the enclosing call frame. */
function scanJs(src: string): { start: number; quote: string; frame: Frame | undefined } | null {
  const n = src.length;
  const stack: Frame[] = [];
  let last = '';
  let i = 0;
  while (i < n) {
    const c = src[i] ?? '';
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) return null;
      i = nl + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) return null;
      i = close + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        const d = src[j];
        if (d === '\\') j += 2;
        else if (d === c || (d === '\n' && c !== '`')) break;
        else j++;
      }
      if (j >= n) return { start: i, quote: c, frame: stack[stack.length - 1] };
      i = j + 1;
      last = 'a';
      continue;
    }
    if (c === '/' && REGEX_AFTER.has(last)) {
      let j = i + 1;
      let cls = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') j += 2;
        else if (d === '\n') break;
        else {
          if (d === '[') cls = true;
          else if (d === ']') cls = false;
          else if (d === '/' && !cls) break;
          j++;
        }
      }
      if (j >= n) return null;
      i = j + 1;
      last = 'a';
      continue;
    }
    if (c === '(') stack.push({ callee: calleeBefore(src, i), arg: 0 });
    else if (c === '[' || c === '{') stack.push({ callee: '', arg: 0 });
    else if (c === ')' || c === ']' || c === '}') stack.pop();
    else if (c === ',') {
      const f = stack[stack.length - 1];
      if (f) f.arg++;
    }
    if (!isSpace(c)) last = isWordChar(c) ? 'a' : c;
    i++;
  }
  return null;
}

const IMPORT_FROM = /(?:^|[^\w$.])(?:import|export)\b[^;'"`]*\bfrom\s*$/;
const IMPORT_BARE = /(?:^|[^\w$.])import\s*$/;
const SELECTOR_METHODS = new Set(['querySelector', 'querySelectorAll', 'closest', 'matches']);
const CLASS_LIST_METHODS = new Set(['add', 'remove', 'toggle', 'contains', 'replace']);

function jsContext(src: string): CompletionContext | null {
  const s = scanJs(src);
  if (!s) return null;
  const content = src.slice(s.start + 1);
  if (s.quote === '`' && content.includes('${')) return null;
  const head = src.slice(Math.max(0, s.start - 400), s.start);
  if (s.quote !== '`' && (IMPORT_FROM.test(head) || IMPORT_BARE.test(head))) return pathContext(content, 'js', true);
  const frame = s.frame;
  if (!frame) return null;
  const lastCh = head.trimEnd().at(-1);
  if (lastCh !== '(' && lastCh !== ',') return null;
  const dot = frame.callee.lastIndexOf('.');
  const method = frame.callee.slice(dot + 1);
  const obj = dot < 0 ? '' : frame.callee.slice(0, dot);
  const first = frame.arg === 0 && lastCh === '(';
  if (first && frame.callee === 'import') return pathContext(content, 'js', true);
  if (first && method === 'getElementById') return NAME.test(content) ? { kind: 'id', prefix: content } : null;
  if (first && method === 'getElementsByClassName') {
    const word = lastPiece(content, ' \t');
    return NAME.test(word) ? { kind: 'class', prefix: word } : null;
  }
  if (first && SELECTOR_METHODS.has(method)) return selectorContext(content);
  if (obj === 'classList' && CLASS_LIST_METHODS.has(method)) {
    return NAME.test(content) ? { kind: 'class', prefix: content } : null;
  }
  return null;
}

// ---------------------------------------------------------------- CSS

function cssContext(src: string): CompletionContext | null {
  const end = scanCss(src);
  if (end.inComment) return null;
  const preludeTrim = end.prelude.trimStart();
  const isImport = /^@import\b/i.test(preludeTrim);
  if (end.url) return pathContext(src.slice(end.url.start), isImport ? 'css' : 'media', false);
  if (end.string) {
    const content = src.slice(end.string.start + 1);
    const head = src.slice(Math.max(0, end.string.start - 40), end.string.start).trimEnd();
    if (/(?:^|[^\w-])url\(\s*$/i.test(head)) return pathContext(content, isImport ? 'css' : 'media', false);
    if (isImport && /@import$/i.test(head)) return pathContext(content, 'css', false);
    return null;
  }
  if (end.block !== 'rules' || preludeTrim.startsWith('@')) return null;
  const p = end.prelude;
  if (p.lastIndexOf('[') > p.lastIndexOf(']')) return null;
  let i = p.length;
  while (i > 0 && NAME.test(p[i - 1] ?? '')) i--;
  const word = p.slice(i);
  if (p[i - 1] === '.') return /^-?\d/.test(word) ? null : { kind: 'class', prefix: word };
  if (p[i - 1] === '#') return { kind: 'css-id', prefix: word };
  return null;
}

// ---------------------------------------------------------------- HTML markup

const MEDIA_TAGS = new Set(['img', 'audio', 'video', 'source', 'track', 'embed', 'picture']);
const PAGE_TAGS = new Set(['a', 'area', 'iframe', 'form', 'frame']);

interface OpenAttr {
  readonly tag: string;
  readonly attr: string;
  readonly value: string;
  readonly attrs: ReadonlyMap<string, string>;
}

/** When `src` ends inside an attribute value of an open tag, that attribute. */
function openAttribute(src: string): OpenAttr | null {
  const commentOpen = src.lastIndexOf('<!--');
  if (commentOpen >= 0 && src.indexOf('-->', commentOpen + 4) < 0) return null;
  let lt = src.lastIndexOf('<');
  while (lt >= 0 && !/[A-Za-z]/.test(src[lt + 1] ?? '')) lt = lt > 0 ? src.lastIndexOf('<', lt - 1) : -1;
  if (lt < 0) return null;
  const n = src.length;
  let k = lt + 1;
  while (k < n && /[\w:-]/.test(src[k] ?? '')) k++;
  const tag = src.slice(lt + 1, k).toLowerCase();
  const attrs = new Map<string, string>();
  while (k < n) {
    while (k < n && (isSpace(src[k] ?? '') || src[k] === '/')) k++;
    if (k >= n) return null;
    if (src[k] === '>') return null;
    const ns = k;
    while (k < n) {
      const c = src[k] ?? '';
      if (isSpace(c) || c === '=' || c === '>' || c === '/') break;
      k++;
    }
    if (k === ns) {
      k++;
      continue;
    }
    const attr = src.slice(ns, k).toLowerCase();
    while (k < n && isSpace(src[k] ?? '')) k++;
    if (src[k] !== '=') continue;
    k++;
    while (k < n && isSpace(src[k] ?? '')) k++;
    if (k >= n) return null;
    const q = src[k];
    if (q === '"' || q === "'") {
      const close = src.indexOf(q, k + 1);
      if (close < 0) return { tag, attr, value: src.slice(k + 1), attrs };
      attrs.set(attr, src.slice(k + 1, close));
      k = close + 1;
    } else {
      const vs = k;
      while (k < n && !isSpace(src[k] ?? '') && src[k] !== '>') k++;
      if (k >= n) return { tag, attr, value: src.slice(vs), attrs };
      attrs.set(attr, src.slice(vs, k));
    }
  }
  return null;
}

function pathAcceptFor(tag: string, attrs: ReadonlyMap<string, string>): PathAccept {
  if (MEDIA_TAGS.has(tag)) return 'media';
  if (tag === 'input') return (attrs.get('type') ?? '').toLowerCase() === 'image' ? 'media' : 'any';
  if (tag === 'link') return /\bicon\b/i.test(attrs.get('rel') ?? '') ? 'media' : 'css';
  if (tag === 'script') return 'js';
  if (PAGE_TAGS.has(tag)) return 'html';
  return 'any';
}

function markupContext(src: string): CompletionContext | null {
  const a = openAttribute(src);
  if (!a) return null;
  const { tag, attr, value } = a;
  if (/\{\{|\$\{|<%|\{%/.test(value)) return null;
  if (attr === 'class') {
    const word = lastPiece(value, ' \t\n\r\f');
    return NAME.test(word) ? { kind: 'class', prefix: word } : null;
  }
  if (attr === 'for' && tag === 'label') return NAME.test(value) ? { kind: 'id', prefix: value } : null;
  if (attr === 'href' && (tag === 'a' || tag === 'area') && value.startsWith('#')) {
    const id = value.slice(1);
    return NAME.test(id) ? { kind: 'id', prefix: id } : null;
  }
  if (
    attr === 'src' ||
    attr === 'href' ||
    (attr === 'action' && tag === 'form') ||
    (attr === 'poster' && tag === 'video')
  ) {
    const accept = attr === 'poster' ? 'media' : pathAcceptFor(tag, a.attrs);
    return pathContext(value, accept, false);
  }
  return null;
}

// ---------------------------------------------------------------- entry point

/**
 * `before` = text before the cursor (caller passes up to ~2000 chars). language: 'html' | 'css' | 'javascript'. For
 * html, the region comes from htmlRegionAt(before, before.length); script regions are JS and style regions CSS.
 */
export function completionContextAt(languageId: string, before: string): CompletionContext | null {
  if (languageId === 'javascript') return jsContext(before);
  if (languageId === 'css') return cssContext(before);
  if (languageId === 'html') {
    const { region, start } = htmlRegion(before, before.length);
    if (region === 'script') return jsContext(before.slice(start));
    if (region === 'style') return cssContext(before.slice(start));
    return markupContext(before);
  }
  return null;
}
