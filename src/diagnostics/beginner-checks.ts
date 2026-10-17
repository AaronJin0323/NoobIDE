/**
 * NoobIDE's own static beginner checks for explanation rules 16–20 and 23–25 (S55.2,
 * docs/product/explanation-rules-16-25.md). Like the unclosed-element check (html-check.ts, rule 14), the findings
 * become warning markers (owner `noobide-beginner`) and static ProblemRecords; the explanation rules read the facts
 * back from the marker message (`beginnerFacts`), which quotes each fact in backticks.
 *
 * Deliberately conservative: every finding is located exactly on one line, and anything the check cannot read with
 * certainty (template placeholders, URLs with a scheme, values spanning lines, files over the size limit) is skipped.
 *
 * Pure functions over text; positions are 1-based lines and UTF-16 columns (what Monaco uses). Messages hold paths,
 * names and numbers from the file — never whole lines of code.
 */
import { portableNameKey } from '../shared/portability';
import { baseName, dirName, editDistance, samePath, typoThreshold } from './text';

export const BEGINNER_CODES = {
  brokenRef: 'html-broken-ref',
  refCase: 'html-ref-case',
  duplicateId: 'html-duplicate-id',
  imgNoAlt: 'html-img-no-alt',
  mismatchedClose: 'html-mismatched-close',
  unitlessLength: 'css-unitless-length',
  selectorPrefix: 'js-selector-prefix',
  assignInCondition: 'js-assign-in-condition',
} as const;
export type BeginnerCode = (typeof BEGINNER_CODES)[keyof typeof BEGINNER_CODES];
const ALL_CODES: ReadonlySet<string> = new Set(Object.values(BEGINNER_CODES));
export const isBeginnerCode = (code: string): code is BeginnerCode => ALL_CODES.has(code);

export interface BeginnerFinding {
  readonly code: BeginnerCode;
  readonly line: number;
  readonly column: number;
  /** Exclusive, same line. */
  readonly endColumn: number;
  /** Technical message (shown as the original message); facts are quoted in backticks. */
  readonly message: string;
}

/** Facts the project provides: its files (for references) and its HTML ids / classes (for selector checks). */
export interface BeginnerFacts {
  /** Project-relative path of the checked file. */
  readonly relPath?: string;
  /** Every project file, project-relative, '/'-separated. Without it references are not checked. */
  readonly projectFiles?: readonly string[];
  readonly htmlIds?: readonly string[];
  readonly htmlClasses?: readonly string[];
}

/** Longest text checked (like html-check.ts): larger files get no beginner findings. */
export const MAX_BEGINNER_CHECK_CHARS = 512 * 1024;

// ── Messages and their facts ─────────────────────────────────────────────────────────────────────────────────────

const q = (fact: string | number) => `\`${String(fact).replace(/`/g, "'")}\``;

export const beginnerMessages = {
  brokenRef: (attr: string, ref: string) => `${q(attr)} path ${q(ref)} does not match any file in the project.`,
  refCase: (attr: string, ref: string, actual: string) =>
    `${q(attr)} path ${q(ref)} matches the file ${q(actual)} only when letter case is ignored.`,
  duplicateId: (id: string, firstLine: number) => `Duplicate id ${q(id)} (first used on line ${q(firstLine)}).`,
  imgNoAlt: (tag = 'img') => `${q(`<${tag}>`)} has no ${q('alt')} attribute.`,
  mismatchedClose: (tag: string, open: string | undefined, pairs: boolean) =>
    open === undefined
      ? `Closing tag ${q(`</${tag}>`)} has no open element.`
      : `Closing tag ${q(`</${tag}>`)} does not match the open element ${q(`<${open}>`)}${pairs ? `, which is never closed` : ''}.`,
  unitlessLength: (property: string, value: string) =>
    `${q(`${property}: ${value}`)} has no unit; the browser ignores this declaration.`,
  selectorPrefix: (method: string, selector: string) => `${q(`${method}('${selector}')`)} selector prefix mistake.`,
  assignInCondition: (keyword: string) => `Assignment ${q('=')} in an ${q(keyword)} condition.`,
} as const;

/** The facts of a beginner finding's message (`data` of its ProblemRecord), or null for other codes. */
export function beginnerFacts(code: string, message: string): Record<string, string> | null {
  if (!isBeginnerCode(code)) return null;
  const f = [...message.matchAll(/`([^`]*)`/g)].map((m) => m[1] ?? '');
  const tag = (s: string | undefined) => s?.replace(/^<\/?|>$/g, '') ?? '';
  switch (code) {
    case 'html-broken-ref':
      return { attr: f[0] ?? '', ref: f[1] ?? '' };
    case 'html-ref-case':
      return { attr: f[0] ?? '', ref: f[1] ?? '', actual: f[2] ?? '' };
    case 'html-duplicate-id':
      return { id: f[0] ?? '', firstLine: f[1] ?? '' };
    case 'html-img-no-alt':
      return { tag: tag(f[0]) || 'img' };
    case 'html-mismatched-close':
      return {
        tagName: tag(f[0]),
        ...(f[1] !== undefined ? { open: tag(f[1]) } : {}),
        ...(message.includes('never closed') ? { pairs: 'yes' } : {}),
      };
    case 'css-unitless-length': {
      const [property = '', value = ''] = (f[0] ?? '').split(/:\s*/, 2);
      return { property, value };
    }
    case 'js-selector-prefix': {
      const m = /^(\w+)\('(.*)'\)$/.exec(f[0] ?? '');
      return { method: m?.[1] ?? '', selector: m?.[2] ?? '' };
    }
    case 'js-assign-in-condition':
      return { keyword: f[1] ?? 'if' };
  }
}

// ── Positions ────────────────────────────────────────────────────────────────────────────────────────────────────

class Lines {
  private readonly starts = [0];
  constructor(text: string) {
    for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  at(offset: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (this.starts[lo] ?? 0) + 1 };
  }
}

/** A finding at [start, end) of the text, or null when the range spans lines. */
function finding(
  lines: Lines,
  code: BeginnerCode,
  start: number,
  end: number,
  message: string,
): BeginnerFinding | null {
  const a = lines.at(start);
  const b = lines.at(end);
  if (a.line !== b.line || end <= start) return null;
  return { code, line: a.line, column: a.column, endColumn: b.column, message };
}

// ── References (rules 16 and 24) ─────────────────────────────────────────────────────────────────────────────────

/**
 * The project-relative path a `src`/`href` value points at, seen from `fromFile`; null when it is not a path into the
 * project that can be checked (a URL with a scheme, `//host`, `#anchor`, empty, a template placeholder, a folder, a
 * path leaving the project).
 */
export function resolveReference(fromFile: string, ref: string): string | null {
  const value = ref.trim();
  if (!value || value.startsWith('#') || value.startsWith('//') || /^[A-Za-z][\w+.-]*:/.test(value)) return null;
  if (/[{}$<>\\]/.test(value)) return null;
  let path = value.split(/[?#]/, 1)[0] ?? '';
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (!path || path.endsWith('/')) return null;
  const parts = path.startsWith('/') ? [] : dirName(fromFile).split('/').filter(Boolean);
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.length ? parts.join('/') : null;
}

export type ReferenceMatch =
  | { readonly kind: 'exact' }
  /** Same name except for letter case: `actuals` are the files that match that way (one, normally). */
  | { readonly kind: 'case'; readonly actuals: readonly string[] }
  /** No file, not even with other case. `candidates`: similar names in the same folder, or the same name elsewhere. */
  | { readonly kind: 'missing'; readonly candidates: readonly string[] };

export function matchReference(path: string, files: readonly string[]): ReferenceMatch {
  if (files.some((f) => samePath(f, path))) return { kind: 'exact' };
  const key = portableNameKey(path);
  const actuals = files.filter((f) => portableNameKey(f) === key);
  if (actuals.length) return { kind: 'case', actuals };
  const name = baseName(path);
  const folder = dirName(path);
  const max = typoThreshold(name.length);
  const nameKey = portableNameKey(name);
  const candidates = files.filter((f) => {
    const sameFolder = portableNameKey(dirName(f)) === portableNameKey(folder);
    if (sameFolder) return max > 0 && editDistance(baseName(f), name) <= max;
    return portableNameKey(baseName(f)) === nameKey;
  });
  return { kind: 'missing', candidates };
}

/** `target` written relative to the folder of `fromFile` ('/'-separated, `../` where needed). */
export function relativeReference(fromFile: string, target: string): string {
  const from = dirName(fromFile).split('/').filter(Boolean);
  const to = target.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common += 1;
  return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/');
}

// ── HTML scanning ────────────────────────────────────────────────────────────────────────────────────────────────

interface Attr {
  readonly name: string;
  readonly value: string;
  /** Offset of the value's first character (inside the quotes). */
  readonly valueStart: number;
}

interface Tag {
  readonly name: string;
  readonly closing: boolean;
  readonly nameStart: number;
  readonly attrs: readonly Attr[];
  /** Offset just after the `>`. */
  readonly end: number;
}

interface RawBlock {
  readonly tag: 'script' | 'style';
  readonly attrs: readonly Attr[];
  readonly start: number;
  readonly text: string;
}

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]); // prettier-ignore
const OPTIONAL_END = new Set([
  'html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'option', 'optgroup', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'colgroup', 'caption', 'rb', 'rt', 'rtc', 'rp',
]); // prettier-ignore
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

function parseAttrs(text: string, from: number, to: number): Attr[] {
  const attrs: Attr[] = [];
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  re.lastIndex = from;
  for (let m = re.exec(text); m && m.index < to; m = re.exec(text)) {
    const raw = m[2] ?? m[3] ?? m[4];
    const value = raw ?? '';
    const valueStart =
      raw === undefined ? m.index + m[0].length : m.index + m[0].length - value.length - (m[4] === undefined ? 1 : 0);
    attrs.push({ name: (m[1] ?? '').toLowerCase(), value, valueStart });
  }
  return attrs;
}

/** Offset of the `>` that ends a tag, skipping quoted values; -1 when unfinished (same as html-check.ts). */
function tagEnd(text: string, from: number): number {
  let quote: string | null = null;
  for (let j = from; j < text.length; j += 1) {
    const c = text[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return j;
    else if (c === '<') return -1;
  }
  return -1;
}

function scanHtml(text: string): { tags: Tag[]; raw: RawBlock[] } {
  const tags: Tag[] = [];
  const raw: RawBlock[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text[lt + 1] === '!' || text[lt + 1] === '?') {
      const end = text.indexOf('>', lt + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    const closing = text[lt + 1] === '/';
    const nameStart = lt + (closing ? 2 : 1);
    const nameMatch = /^[A-Za-z][A-Za-z0-9-]*/.exec(text.slice(nameStart, nameStart + 64));
    if (!nameMatch) {
      i = lt + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    const end = tagEnd(text, nameStart + nameMatch[0].length);
    if (end < 0) {
      i = lt + 1;
      continue;
    }
    const attrs = closing ? [] : parseAttrs(text, nameStart + nameMatch[0].length, end);
    tags.push({ name, closing, nameStart, attrs, end: end + 1 });
    i = end + 1;
    if (!closing && RAW_TEXT.has(name) && text[end - 1] !== '/') {
      const close = lower.indexOf(`</${name}`, i);
      const stop = close < 0 ? text.length : close;
      if (name === 'script' || name === 'style') raw.push({ tag: name, attrs, start: i, text: text.slice(i, stop) });
      i = stop;
    }
  }
  return { tags, raw };
}

/** Attributes holding a path, per element (rule 16/24). */
const REF_ATTRS: Readonly<Record<string, string>> = {
  script: 'src', img: 'src', source: 'src', audio: 'src', video: 'src', iframe: 'src', embed: 'src', track: 'src',
  link: 'href', a: 'href', area: 'href',
}; // prettier-ignore

const isStylesheetOrIcon = (tag: Tag) =>
  /\b(?:stylesheet|icon)\b/i.test(tag.attrs.find((a) => a.name === 'rel')?.value ?? '');

export function checkBeginnerHtml(text: string, facts: BeginnerFacts = {}): BeginnerFinding[] {
  if (text.length > MAX_BEGINNER_CHECK_CHARS) return [];
  const lines = new Lines(text);
  const out: (BeginnerFinding | null)[] = [];
  const { tags, raw } = scanHtml(text);
  const firstId = new Map<string, number>();
  const open: { name: string; offset: number }[] = [];
  const unclosed = new Set<number>();
  const strays: { tag: Tag; open?: { name: string; offset: number } }[] = [];

  for (const tag of tags) {
    if (tag.closing) {
      const index = open.map((e) => e.name).lastIndexOf(tag.name);
      if (index < 0) {
        const expected = [...open].reverse().find((e) => !OPTIONAL_END.has(e.name));
        strays.push({ tag, ...(expected ? { open: expected } : {}) });
        continue;
      }
      for (const e of open.splice(index)) if (e.name !== tag.name) unclosed.add(e.offset);
      continue;
    }
    if (!VOID.has(tag.name) && text[tag.end - 2] !== '/') {
      open.push({ name: tag.name, offset: tag.nameStart });
    }

    // Rule 17: duplicate id.
    const id = tag.attrs.find((a) => a.name === 'id');
    if (id && id.value.trim()) {
      const first = firstId.get(id.value);
      if (first === undefined) firstId.set(id.value, lines.at(id.valueStart).line);
      else
        out.push(
          finding(
            lines,
            'html-duplicate-id',
            id.valueStart,
            id.valueStart + id.value.length,
            beginnerMessages.duplicateId(id.value, first),
          ),
        );
    }
    // Rule 18: <img> without alt.
    if (tag.name === 'img' && !tag.attrs.some((a) => a.name === 'alt')) {
      out.push(
        finding(
          lines,
          'html-img-no-alt',
          tag.nameStart,
          tag.nameStart + 3,
          beginnerMessages.imgNoAlt(text.slice(tag.nameStart, tag.nameStart + 3)),
        ),
      );
    }
    // Rules 16 and 24: references.
    const attrName = REF_ATTRS[tag.name];
    const files = facts.projectFiles;
    if (attrName && files && facts.relPath && (tag.name !== 'link' || isStylesheetOrIcon(tag))) {
      const attr = tag.attrs.find((a) => a.name === attrName);
      const target = attr ? resolveReference(facts.relPath, attr.value) : null;
      if (attr && target) {
        const match = matchReference(target, files);
        const start = attr.valueStart;
        const end = start + attr.value.length;
        if (match.kind === 'case') {
          out.push(
            finding(
              lines,
              'html-ref-case',
              start,
              end,
              beginnerMessages.refCase(attrName, attr.value, match.actuals.join(', ')),
            ),
          );
        } else if (match.kind === 'missing') {
          out.push(finding(lines, 'html-broken-ref', start, end, beginnerMessages.brokenRef(attrName, attr.value)));
        }
      }
    }
  }
  for (const e of open) unclosed.add(e.offset);

  // Rule 19: a closing tag that closes nothing.
  for (const { tag, open: expected } of strays) {
    const pairs = expected !== undefined && unclosed.has(expected.offset);
    out.push(
      finding(
        lines,
        'html-mismatched-close',
        tag.nameStart,
        tag.nameStart + tag.name.length,
        beginnerMessages.mismatchedClose(tag.name, expected?.name, pairs),
      ),
    );
  }

  // Rules 20, 23, 25 inside <style> and <script> blocks (not external or non-JS scripts).
  for (const block of raw) {
    if (block.tag === 'style') out.push(...shift(checkBeginnerCss(block.text), lines, block.start));
    else {
      const type =
        block.attrs
          .find((a) => a.name === 'type')
          ?.value.trim()
          .toLowerCase() ?? '';
      const js = type === '' || type === 'module' || /javascript|ecmascript/.test(type);
      if (js && !block.attrs.some((a) => a.name === 'src')) {
        out.push(...shift(checkBeginnerJs(block.text, facts), lines, block.start));
      }
    }
  }
  return sorted(out);
}

/** Findings of an embedded block moved to positions in the whole document. */
function shift(findings: readonly BeginnerFinding[], lines: Lines, blockStart: number) {
  const origin = lines.at(blockStart);
  return findings.map((f) => {
    const column = f.line === 1 ? origin.column + f.column - 1 : f.column;
    return { ...f, line: origin.line + f.line - 1, column, endColumn: column + (f.endColumn - f.column) };
  });
}

const sorted = (items: readonly (BeginnerFinding | null)[]): BeginnerFinding[] =>
  items.filter((f): f is BeginnerFinding => f !== null).sort((a, b) => a.line - b.line || a.column - b.column);

// ── CSS (rule 20) ────────────────────────────────────────────────────────────────────────────────────────────────

/** Properties whose value is a length (a bare non-zero number is invalid). Unitless-by-design properties are absent. */
// prettier-ignore
export const LENGTH_PROPERTIES: ReadonlySet<string> = new Set([
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'top', 'right', 'bottom', 'left', 'inset', 'font-size',
  'border-width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-radius', 'gap', 'row-gap', 'column-gap', 'outline-width', 'letter-spacing', 'word-spacing', 'text-indent',
]);

/** Comments blanked out (same length), so offsets stay valid. */
function blankCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (c) => c.replace(/[^\n]/g, ' '));
}

export function checkBeginnerCss(text: string): BeginnerFinding[] {
  if (text.length > MAX_BEGINNER_CHECK_CHARS) return [];
  const lines = new Lines(text);
  const code = blankCssComments(text);
  const out: (BeginnerFinding | null)[] = [];
  let depth = 0;
  let segmentStart = 0;
  for (let i = 0; i <= code.length; i += 1) {
    const c = code[i];
    if (c !== '{' && c !== '}' && c !== ';' && i !== code.length) continue;
    // A segment ending in `{` is a selector or an at-rule prelude; others are declarations (inside a block).
    if (c !== '{' && depth > 0) {
      const decl = /^(\s*)([A-Za-z-]+)(\s*:\s*)([\s\S]*?)\s*$/.exec(code.slice(segmentStart, i));
      if (
        decl?.[2] &&
        decl[4] !== undefined &&
        LENGTH_PROPERTIES.has(decl[2].toLowerCase()) &&
        !decl[4].includes('(')
      ) {
        const valueStart = segmentStart + (decl[1]?.length ?? 0) + decl[2].length + (decl[3]?.length ?? 0);
        const value = decl[4];
        const bare = /(^|\s)(-?(?:\d+\.?\d*|\.\d+))(?=\s|$|!)/.exec(value);
        if (bare?.[2] && Number(bare[2]) !== 0) {
          const start = valueStart + bare.index + (bare[1]?.length ?? 0);
          out.push(
            finding(
              lines,
              'css-unitless-length',
              start,
              start + bare[2].length,
              beginnerMessages.unitlessLength(decl[2], value.replace(/\s*!important$/i, '')),
            ),
          );
        }
      }
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth = Math.max(0, depth - 1);
    segmentStart = i + 1;
  }
  return sorted(out);
}

// ── JavaScript (rules 23 and 25) ─────────────────────────────────────────────────────────────────────────────────

/**
 * The code with comments, string contents, template literals and regular expression literals blanked to spaces
 * (quotes kept, same length), so a pattern found in it is real code.
 */
export function maskJs(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  let lastSignificant = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? '';
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && !(c !== '`' && text[j] === '\n')) j += text[j] === '\\' ? 2 : 1;
      blank(i + 1, Math.min(j, text.length));
      i = j + 1;
      lastSignificant = c;
      continue;
    }
    if (c === '/' && (lastSignificant === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSignificant))) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n' && (inClass || text[j] !== '/')) {
        if (text[j] === '\\') j += 1;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
      lastSignificant = '/';
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = /[\w$]/.test(c) ? 'a' : c;
    i += 1;
  }
  return out.join('');
}

// prettier-ignore
const HTML_TAGS: ReadonlySet<string> = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption',
  'code', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'em', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'label',
  'legend', 'li', 'link', 'main', 'mark', 'menu', 'meta', 'nav', 'ol', 'optgroup', 'option', 'output', 'p', 'picture',
  'pre', 'progress', 'q', 's', 'script', 'section', 'select', 'small', 'source', 'span', 'strong', 'style', 'sub',
  'summary', 'sup', 'svg', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title',
  'tr', 'u', 'ul', 'var', 'video',
]);
const PLAIN_NAME = /^[A-Za-z_\u0080-￿][\w\u0080-￿-]*$/u;
const SELECTOR_CALL = /\b(getElementById|querySelector|querySelectorAll)\s*\(\s*(['"])([^'"\\\n]*)\2\s*\)/g;

export function checkBeginnerJs(text: string, facts: BeginnerFacts = {}): BeginnerFinding[] {
  if (text.length > MAX_BEGINNER_CHECK_CHARS) return [];
  const lines = new Lines(text);
  const mask = maskJs(text);
  const out: (BeginnerFinding | null)[] = [];

  // Rule 23: selector-prefix mistakes. The call itself must be code (not inside a comment or string).
  for (const m of text.matchAll(SELECTOR_CALL)) {
    const [, method = '', , arg = ''] = m;
    if (mask.slice(m.index, m.index + method.length) !== method) continue;
    const argStart = m.index + m[0].indexOf(arg, method.length);
    const reported =
      method === 'getElementById'
        ? /^[#.]/.test(arg) && PLAIN_NAME.test(arg.slice(1))
        : PLAIN_NAME.test(arg) &&
          !HTML_TAGS.has(arg.toLowerCase()) &&
          !arg.includes('-') &&
          Boolean(facts.htmlIds?.includes(arg) || facts.htmlClasses?.includes(arg));
    if (reported && arg) {
      out.push(
        finding(
          lines,
          'js-selector-prefix',
          argStart,
          argStart + arg.length,
          beginnerMessages.selectorPrefix(method, arg),
        ),
      );
    }
  }

  // Rule 25: a single `=` at the top level of an if/while condition.
  for (const m of mask.matchAll(/\b(if|while)\s*\(/g)) {
    const keyword = m[1] ?? 'if';
    const open = m.index + m[0].length - 1;
    const close = matchingParen(mask, open);
    if (close < 0) continue;
    const inner = mask.slice(open + 1, close);
    const lead = open + 1 + (inner.length - inner.trimStart().length);
    const tail = close - 1 - (inner.length - inner.trimEnd().length);
    if (mask[lead] === '(' && matchingParen(mask, lead) === tail) continue; // `if ((m = re.exec(s)))`: deliberate
    let depth = 0;
    for (let k = open + 1; k < close; k += 1) {
      const c = mask[k];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') depth -= 1;
      else if (c === '=' && depth === 0) {
        const before = mask[k - 1] ?? '';
        const after = mask[k + 1] ?? '';
        if (after === '=' || after === '>' || /[=!<>+\-*/%&|^?]/.test(before)) {
          if (after === '=') k += mask[k + 2] === '=' ? 2 : 1;
          continue;
        }
        out.push(finding(lines, 'js-assign-in-condition', k, k + 1, beginnerMessages.assignInCondition(keyword)));
        break;
      }
    }
  }
  return sorted(out);
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let k = open; k < text.length; k += 1) {
    if (text[k] === '(') depth += 1;
    else if (text[k] === ')') {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** The checks for a file, by its language. */
export function checkBeginner(language: string, text: string, facts: BeginnerFacts = {}): BeginnerFinding[] {
  if (language === 'html') return checkBeginnerHtml(text, facts);
  if (language === 'css') return checkBeginnerCss(text);
  if (language === 'javascript') return checkBeginnerJs(text, facts);
  return [];
}
