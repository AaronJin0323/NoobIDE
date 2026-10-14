/**
 * NoobIDE's own static HTML check (S19.2): elements that are opened but never closed. Monaco's HTML service has no
 * diagnostics, and a missing `</div>` is one of the most common beginner mistakes (PLAN §9 rule 14). The findings use
 * the code `html-unclosed-tag` with the tag name, which the explanation rule `html-unclosed-tag` consumes.
 *
 * Deliberately conservative — it only reports what is certainly unclosed:
 * - void elements (`<img>`, `<br>` …) and `<x />` never need a closing tag;
 * - elements whose end tag HTML allows to be omitted (`<p>`, `<li>`, `<td>`, `<html>`, `<body>` …) are not reported;
 * - comments, `<!doctype>`, and the raw text inside `<script>`, `<style>`, `<textarea>` and `<title>` are skipped;
 * - a stray closing tag is ignored (it closes nothing; the browser ignores it too).
 *
 * Pure function over the text; positions are 1-based lines and UTF-16 columns (what Monaco uses).
 */
export const HTML_UNCLOSED_CODE = 'html-unclosed-tag';

export interface HtmlFinding {
  readonly code: typeof HTML_UNCLOSED_CODE;
  readonly tagName: string;
  /** Position of the tag name in the opening tag. */
  readonly line: number;
  readonly column: number;
  readonly endColumn: number;
  /** Technical message in the style of a language service (shown as the original message). */
  readonly message: string;
}

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]); // prettier-ignore

const OPTIONAL_END = new Set([
  'html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'option', 'optgroup', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'colgroup', 'caption', 'rb', 'rt', 'rtc', 'rp',
]); // prettier-ignore

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

/** Longest document checked; larger files are not checked (no false sense of completeness, no slow typing). */
export const MAX_HTML_CHECK_CHARS = 512 * 1024;

export function unclosedMessage(tagName: string): string {
  return `Unclosed element \`${tagName}\`.`;
}

export function checkHtml(text: string): HtmlFinding[] {
  if (text.length > MAX_HTML_CHECK_CHARS) return [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const position = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (lineStarts[lo] ?? 0) + 1 };
  };

  const lower = text.toLowerCase();
  const open: { name: string; offset: number }[] = [];
  const findings: HtmlFinding[] = [];
  const report = (element: { name: string; offset: number }) => {
    if (OPTIONAL_END.has(element.name)) return;
    const { line, column } = position(element.offset);
    findings.push({
      code: HTML_UNCLOSED_CODE,
      tagName: element.name,
      line,
      column,
      endColumn: column + element.name.length,
      message: unclosedMessage(element.name),
    });
  };

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
      i = lt + 1; // not a finished tag (the user may be typing it): look past this '<'
      continue;
    }
    const selfClosing = text[end - 1] === '/';
    i = end + 1;
    if (closing) {
      const index = findLastIndex(open, (e) => e.name === name);
      if (index < 0) continue; // stray closing tag
      for (const element of open.splice(index)) if (element.name !== name) report(element);
      continue;
    }
    if (VOID.has(name) || selfClosing) continue;
    if (RAW_TEXT.has(name)) {
      const close = lower.indexOf(`</${name}`, i);
      if (close < 0) {
        report({ name, offset: nameStart });
        break;
      }
      i = close;
      open.push({ name, offset: nameStart });
      continue;
    }
    open.push({ name, offset: nameStart });
  }
  for (const element of open) report(element);
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Offset of the `>` that ends a tag, skipping quoted attribute values; -1 if the tag is not finished. */
function tagEnd(text: string, from: number): number {
  let quote: string | null = null;
  for (let j = from; j < text.length; j += 1) {
    const c = text[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return j;
    } else if (c === '<') {
      return -1; // a new tag starts before this one ended: treat as unfinished
    }
  }
  return -1;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let k = items.length - 1; k >= 0; k -= 1) if (predicate(items[k] as T)) return k;
  return -1;
}
