/**
 * Static checks for the built-in templates (S20.1): HTML well-formedness, local references and network URLs.
 * Deliberately small and strict — the templates are short, hand-written files we control, so every element is closed
 * explicitly and anything unusual is a finding.
 */

export const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
const RAW_TEXT = new Set(['script', 'style']);

export interface HtmlTag {
  readonly name: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly line: number;
}

export interface HtmlReport {
  readonly errors: string[];
  readonly tags: HtmlTag[];
}

const lineAt = (src: string, index: number) => src.slice(0, index).split('\n').length;

function parseAttributes(raw: string, line: number, errors: string[]): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const name = m[1]!.toLowerCase();
    if (attrs.has(name)) errors.push(`line ${line}: duplicate attribute ${name}`);
    attrs.set(name, m[2] ?? m[3] ?? m[4] ?? '');
  }
  const leftover = raw.replace(re, '').replace(/[\s/]/g, '');
  if (leftover !== '') errors.push(`line ${line}: cannot parse attributes near ${JSON.stringify(leftover)}`);
  return attrs;
}

/** Tokenises an HTML document and checks nesting, doctype, lang, charset, title and unique ids. */
export function checkHtml(src: string): HtmlReport {
  const errors: string[] = [];
  const tags: HtmlTag[] = [];
  const stack: { name: string; line: number }[] = [];
  const ids = new Set<string>();
  const token =
    /<!--[\s\S]*?-->|<!doctype\s+html\s*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  let doctypeSeen = false;
  let firstMarkup = true;
  let last = 0;
  for (let m = token.exec(src); m; m = token.exec(src)) {
    const between = src.slice(last, m.index);
    if (/[<>]/.test(between)) errors.push(`line ${lineAt(src, last)}: stray < or > in text`);
    last = token.lastIndex;
    const line = lineAt(src, m.index);
    const text = m[0];
    if (text.startsWith('<!--')) continue;
    if (/^<!doctype/i.test(text)) {
      if (!firstMarkup || doctypeSeen) errors.push(`line ${line}: <!doctype html> must come first`);
      doctypeSeen = true;
      continue;
    }
    if (firstMarkup && !doctypeSeen) errors.push('document must start with <!doctype html>');
    firstMarkup = false;
    if (m[1]) {
      const name = m[1].toLowerCase();
      const open = stack.pop();
      if (!open || open.name !== name) {
        errors.push(
          `line ${line}: </${name}> does not match ${open ? `<${open.name}> from line ${open.line}` : 'anything'}`,
        );
        if (open) stack.push(open);
      }
      continue;
    }
    const name = m[2]!.toLowerCase();
    const rawAttrs = m[3] ?? '';
    const attrs = parseAttributes(rawAttrs.replace(/\/\s*$/, ''), line, errors);
    tags.push({ name, attrs, line });
    const id = attrs.get('id');
    if (id !== undefined) {
      if (ids.has(id)) errors.push(`line ${line}: duplicate id ${id}`);
      ids.add(id);
    }
    if (VOID_ELEMENTS.has(name)) continue;
    if (rawAttrs.trim().endsWith('/')) errors.push(`line ${line}: <${name} /> is not a void element`);
    if (RAW_TEXT.has(name)) {
      const close = src.toLowerCase().indexOf(`</${name}`, token.lastIndex);
      if (close < 0) {
        errors.push(`line ${line}: <${name}> is never closed`);
        break;
      }
      token.lastIndex = close;
      last = close;
    }
    stack.push({ name, line });
  }
  if (/[<>]/.test(src.slice(last))) errors.push(`line ${lineAt(src, last)}: stray < or > in text`);
  for (const open of stack) errors.push(`line ${open.line}: <${open.name}> is never closed`);

  const first = (n: string) => tags.find((t) => t.name === n);
  if (!first('html')?.attrs.get('lang')) errors.push('<html> needs a lang attribute');
  if (!tags.some((t) => t.name === 'meta' && t.attrs.get('charset')?.toLowerCase() === 'utf-8')) {
    errors.push('missing <meta charset="utf-8">');
  }
  if (!first('title')) errors.push('missing <title>');
  for (const required of ['head', 'body']) if (!first(required)) errors.push(`missing <${required}>`);
  return { errors, tags };
}

/** Local file references in an HTML page: src/href (except in-page `#…` links) and srcset candidates. */
export function htmlReferences(tags: readonly HtmlTag[]): string[] {
  const refs: string[] = [];
  for (const tag of tags) {
    for (const attr of ['src', 'href', 'poster', 'data']) {
      const value = tag.attrs.get(attr);
      if (value !== undefined && !value.startsWith('#')) refs.push(value);
    }
    const srcset = tag.attrs.get('srcset');
    if (srcset) for (const part of srcset.split(',')) refs.push(part.trim().split(/\s+/)[0]!);
  }
  return refs;
}

/** `url(...)` and `@import` targets in a stylesheet. */
export function cssReferences(css: string): string[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const refs: string[] = [];
  for (const m of noComments.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi))
    refs.push(m[1] ?? m[2] ?? m[3] ?? '');
  for (const m of noComments.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) refs.push(m[1] ?? m[2] ?? '');
  return refs.filter((r) => !r.startsWith('data:'));
}

/** XML namespace names are identifiers, never fetched; everything else that looks like a URL is forbidden. */
const NAMESPACE = /\sxmlns(?::\w+)?="http:\/\/www\.w3\.org\/[^"]*"/g;

/** Network URLs anywhere in a text file: http(s):, ftp:, ws(s): or protocol-relative `//host.tld`. */
export function networkUrls(text: string): string[] {
  const scrubbed = text.replace(NAMESPACE, '');
  const found = scrubbed.match(
    /\b(?:https?|ftp|wss?):\/\/[^\s"'<>)]*|(?<![\w:/])\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}/gi,
  );
  return found ?? [];
}

/** Resolves a page-relative reference to a template-relative `/` path, or explains why it is not a local file. */
export function resolveLocal(fromFile: string, ref: string): { path: string } | { error: string } {
  if (ref.trim() === '') return { error: 'empty reference' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) return { error: `${ref} is not a relative path` };
  if (ref.startsWith('/')) return { error: `${ref} is root-absolute; use a relative path` };
  if (ref.includes('\\')) return { error: `${ref} uses \\; use /` };
  const clean = ref.split(/[?#]/)[0]!;
  const parts = fromFile.split('/').slice(0, -1);
  for (const seg of decodeURIComponent(clean).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return { error: `${ref} leaves the project folder` };
      parts.pop();
    } else parts.push(seg);
  }
  return { path: parts.join('/') };
}
