/**
 * A small, safe Markdown subset for AI answers (S33.1). Model output is untrusted text: it is parsed into a plain data
 * tree here and rendered by Markdown.tsx as React elements, so nothing is ever interpreted as HTML (raw `<tags>` stay
 * visible text) and nothing navigates (links are shown as text with their address, never clickable).
 *
 * Supported: paragraphs (line breaks kept), headings, bullet and numbered lists (one level), block quotes, horizontal
 * rules, fenced code blocks (``` or ~~~, with a language), inline code, **bold**, *italic* / _italic_, [links](url),
 * and backslash escapes. Streaming-friendly: an unclosed code fence is a code block that is still arriving.
 *
 * Pure TypeScript, no DOM.
 */

export type MdInline =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'code'; readonly text: string }
  | { readonly type: 'strong'; readonly children: readonly MdInline[] }
  | { readonly type: 'em'; readonly children: readonly MdInline[] }
  | { readonly type: 'link'; readonly children: readonly MdInline[]; readonly url: string };

export type MdBlock =
  | { readonly type: 'paragraph'; readonly children: readonly MdInline[] }
  | { readonly type: 'heading'; readonly level: number; readonly children: readonly MdInline[] }
  | {
      readonly type: 'list';
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly (readonly MdInline[])[];
    }
  | { readonly type: 'quote'; readonly children: readonly MdInline[] }
  | { readonly type: 'rule' }
  /**
   * `closed` is false while the closing fence has not arrived (streaming) or was never sent. `lang` is lowercase;
   * `file` is the file name the info string gives (S48.5: ```js app.js, ```js title="app.js", ```app.js), else ''.
   */
  | {
      readonly type: 'code';
      readonly lang: string;
      readonly file: string;
      readonly text: string;
      readonly closed: boolean;
    };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/;
const LANG = /^[a-z0-9_+#-]{1,32}$/i;
/** A file name or project path with an extension; no quotes, spaces or characters a path cannot hold. */
const FILE = /^(?!.*\.\.)[^\s"'<>|*?`]{1,256}\.[a-z0-9]{1,10}$/i;

/** S48.5: the language and file name of a fence's info string (`js`, `js app.js`, `js:app.js`, `js title="app.js"`). */
export function fenceInfo(info: string): { readonly lang: string; readonly file: string } {
  const words = info.trim().split(/\s+/).filter(Boolean);
  let lang = '';
  let file = '';
  const first = words[0] ?? '';
  const colon = /^([^:]+):(.+)$/.exec(first);
  if (colon && LANG.test(colon[1] ?? '') && FILE.test(colon[2] ?? '')) {
    lang = colon[1] ?? '';
    file = colon[2] ?? '';
  } else if (LANG.test(first)) {
    lang = first;
  } else if (FILE.test(first)) {
    file = first;
    lang = /\.([a-z0-9]+)$/i.exec(first)?.[1] ?? '';
  }
  for (const word of words.slice(1)) {
    if (file) break;
    const attr = /^(?:title|file|filename|name)=["']?([^"']+)["']?$/i.exec(word);
    const candidate = attr ? (attr[1] ?? '') : word;
    if (FILE.test(candidate)) file = candidate;
  }
  return { lang: lang.toLowerCase(), file: file.replace(/\\/g, '/') };
}

const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^ {0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const BLANK = /^\s*$/;

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    QUOTE.test(line)
  );
}

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (BLANK.test(line)) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const { lang, file } = fenceInfo(fence[2] ?? '');
      const body: string[] = [];
      let closed = false;
      i += 1;
      while (i < lines.length) {
        const inner = lines[i] ?? '';
        const trimmed = inner.trim();
        if (trimmed.length >= marker.length && trimmed === (marker[0] ?? '`').repeat(trimmed.length)) {
          closed = true;
          i += 1;
          break;
        }
        body.push(inner);
        i += 1;
      }
      blocks.push({ type: 'code', lang, file, text: body.join('\n'), closed });
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: (heading[1] ?? '#').length, children: parseInline(heading[2] ?? '') });
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const match = QUOTE.exec(lines[i] ?? '');
        if (!match) break;
        body.push(match[1] ?? '');
        i += 1;
      }
      blocks.push({ type: 'quote', children: parseInline(body.join('\n')) });
      continue;
    }
    const bullet = BULLET.test(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const item = ordered ? NUMBERED.exec(current)?.[2] : BULLET.exec(current)?.[1];
        if (item !== undefined) {
          items.push(item);
          i += 1;
          continue;
        }
        // A non-blank, indented line that starts no other block continues the last item.
        if (!BLANK.test(current) && /^\s+/.test(current) && !startsBlock(current) && items.length > 0) {
          items[items.length - 1] += `\n${current.trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({
        type: 'list',
        ordered,
        start: ordered ? Number(numbered?.[1] ?? '1') : 1,
        items: items.map((item) => parseInline(item)),
      });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (BLANK.test(current) || (body.length > 0 && startsBlock(current))) break;
      body.push(current);
      i += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(body.join('\n')) });
  }
  return blocks;
}

const ESCAPABLE = '\\`*_{}[]()#+-.!>~|<';
const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** Index of the closing `delim` for an emphasis opened at `from`, or -1. */
function closingDelimiter(text: string, from: number, delim: string): number {
  let j = from;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === '`') {
      // Code spans inside emphasis are skipped as a whole.
      const run = /^`+/.exec(text.slice(j))?.[0] ?? '`';
      const end = text.indexOf(run, j + run.length);
      j = end === -1 ? j + run.length : end + run.length;
      continue;
    }
    if (text.startsWith(delim, j) && j > from && !isSpace(text[j - 1])) {
      // `**` must not be read as a single-`*` closer (and vice versa).
      const single = delim.length === 1;
      if (!single || text[j + 1] !== delim) {
        if (delim === '_' && isWord(text[j + 1])) {
          j += 1;
          continue;
        }
        return j;
      }
      j += 2;
      continue;
    }
    j += 1;
  }
  return -1;
}

export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) out.push({ type: 'text', text: buffer });
    buffer = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (ch === '\\' && i + 1 < text.length && ESCAPABLE.includes(text[i + 1] ?? '')) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(text.slice(i))?.[0] ?? '`';
      const end = text.indexOf(run, i + run.length);
      if (end !== -1) {
        flush();
        let code = text.slice(i + run.length, end);
        if (code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        out.push({ type: 'code', text: code });
        i = end + run.length;
        continue;
      }
      buffer += run;
      i += run.length;
      continue;
    }
    if ((ch === '*' || ch === '_') && text[i + 1] === ch && !isSpace(text[i + 2])) {
      const delim = ch + ch;
      const end = closingDelimiter(text, i + 2, delim);
      if (end !== -1) {
        flush();
        out.push({ type: 'strong', children: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && text[i + 1] !== ch && !isSpace(text[i + 1])) {
      if (ch === '*' || !isWord(text[i - 1])) {
        const end = closingDelimiter(text, i + 1, ch);
        if (end !== -1) {
          flush();
          out.push({ type: 'em', children: parseInline(text.slice(i + 1, end)) });
          i = end + 1;
          continue;
        }
      }
    }
    if (ch === '[') {
      const link = /^\[([^\]\n]*)\]\(\s*<?([^\s()<>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(text.slice(i));
      if (link) {
        flush();
        out.push({ type: 'link', children: parseInline(link[1] ?? ''), url: link[2] ?? '' });
        i += link[0].length;
        continue;
      }
    }
    if (ch === '<') {
      const auto = /^<((?:https?|mailto):[^\s<>]+)>/i.exec(text.slice(i));
      if (auto) {
        flush();
        const url = auto[1] ?? '';
        out.push({ type: 'link', children: [{ type: 'text', text: url }], url });
        i += auto[0].length;
        continue;
      }
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return out;
}

/** The plain text of inline content (labels, link text equal to the address, tests). */
export function inlineText(nodes: readonly MdInline[]): string {
  return nodes.map((node) => ('text' in node ? node.text : inlineText(node.children))).join('');
}
