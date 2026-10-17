/**
 * Paired HTML tags (S53.2): which closing tag belongs to an opening tag, for Monaco's linked editing (renaming one
 * renames the other) — Monaco's HTML service has no linked editing provider of its own. Pure and unit-tested.
 *
 * Only an explicit pair is linked: a void element (`<img>`), a self-closing tag (`<br/>`), an opening tag whose closing
 * tag is missing (`<li>` closed implicitly) and a stray closing tag are not. Comments and the content of `<script>`,
 * `<style>`, `<textarea>` and `<title>` are text, never tags.
 */

export interface TagName {
  /** Offsets of the tag name (without `<` or `</`). */
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly closing: boolean;
}

const VOID = new Set([
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
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

/** One tag: `<!--…-->`, `<name …>`, `</name>`; attribute values may contain `>`. */
const TAG = /<!--[\s\S]*?(?:-->|$)|<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^'">])*)(>|$)/g;

/** Every explicit open/close pair in the document, as [opening name, closing name]. */
export function tagPairs(text: string): [TagName, TagName][] {
  const pairs: [TagName, TagName][] = [];
  const open: TagName[] = [];
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(text)) !== null) {
    if (m[0].length === 0) {
      TAG.lastIndex += 1;
      continue;
    }
    const nameText = m[2];
    if (nameText === undefined) continue; // a comment
    const closing = m[1] === '/';
    const start = m.index + (closing ? 2 : 1);
    const tag: TagName = { start, end: start + nameText.length, name: nameText.toLowerCase(), closing };
    if (closing) {
      // The nearest open element of the same name; elements opened after it were closed implicitly.
      for (let i = open.length - 1; i >= 0; i -= 1) {
        if (open[i]?.name === tag.name) {
          pairs.push([open[i] as TagName, tag]);
          open.length = i;
          break;
        }
      }
      continue;
    }
    const selfClosing = /\/\s*$/.test(m[3] ?? '');
    if (VOID.has(tag.name) || selfClosing || m[4] !== '>') continue;
    if (RAW_TEXT.has(tag.name)) {
      // Its content is text up to the matching closing tag.
      const close = new RegExp(`</${tag.name}(?=[\\s>/]|$)`, 'gi');
      close.lastIndex = TAG.lastIndex;
      const c = close.exec(text);
      if (!c) break;
      const closeStart = c.index + 2;
      pairs.push([tag, { start: closeStart, end: closeStart + tag.name.length, name: tag.name, closing: true }]);
      TAG.lastIndex = c.index + c[0].length;
      continue;
    }
    open.push(tag);
  }
  return pairs;
}

/** The two tag-name ranges linked to the cursor (on or right after a tag name), or null when it is not in a pair. */
export function linkedTagRanges(text: string, offset: number): [TagName, TagName] | null {
  for (const pair of tagPairs(text)) {
    for (const tag of pair) if (offset >= tag.start && offset <= tag.end) return pair;
  }
  return null;
}

/** Snippet text that escapes `$`, `}` and `\` so the selected text is inserted literally. */
export function snippetLiteral(text: string): string {
  return text.replace(/[$}\\]/g, (ch) => `\\${ch}`);
}

/**
 * "Wrap with tag" (S53.2): the snippet that puts `selected` between an opening and a closing tag. Both tag names are
 * the same tab stop, so typing a name changes both (two linked cursors); `div` is selected to start with.
 */
export function wrapSnippet(selected: string): string {
  return `<\${1:div}>${snippetLiteral(selected)}</\${1:div}>`;
}
