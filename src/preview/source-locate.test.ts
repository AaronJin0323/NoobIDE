import { describe, expect, it } from 'vitest';
import {
  locateCssRule,
  locateElement,
  normalizeSelector,
  numberedExcerpt,
  parseHtmlTree,
  styleBlock,
  type AncestryStep,
  type ElementQuery,
} from './source-locate';

const steps = (...pairs: [string, number][]): AncestryStep[] => pairs.map(([tag, nth]) => ({ tag, nth }));
const query = (q: Partial<ElementQuery> & Pick<ElementQuery, 'ancestry' | 'tag'>): ElementQuery => ({
  classes: [],
  text: '',
  ...q,
});
const linesOf = (html: string, loc: { startOffset: number; endOffset: number } | null) =>
  loc ? html.slice(loc.startOffset, loc.endOffset) : null;

const PAGE = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head>',
  '  <meta charset="utf-8">',
  '  <title>我的 网页</title>',
  '  <link rel="stylesheet" href="样式 表.css">',
  '</head>',
  '<body>',
  '  <!-- <button>not this one</button> -->',
  '  <main>',
  '    <h1>你好</h1>',
  '    <form>',
  '      <input id="name" placeholder="名字">',
  '      <button class="cta big" id="send"',
  '        type="button">发送</button>',
  '    </form>',
  '    <button class="cta">取消</button>',
  '  </main>',
  '  <script>document.write("<button>x</button>")</script>',
  '</body>',
  '</html>',
].join('\n');

describe('locateElement (S41.2)', () => {
  it('follows the ancestry to the exact element, across several lines', () => {
    const loc = locateElement(
      PAGE,
      query({
        ancestry: steps(['html', 1], ['body', 1], ['main', 1], ['form', 1], ['button', 1]),
        tag: 'button',
        id: 'send',
        classes: ['cta', 'big'],
        text: '发送',
      }),
    );
    expect(loc).toMatchObject({ match: 'exact', startLine: 14, endLine: 15 });
    expect(linesOf(PAGE, loc)).toBe('<button class="cta big" id="send"\n        type="button">发送</button>');
  });

  it('counts nth-of-type among flattened siblings (no html/head/body in the file)', () => {
    const html = '<title>t</title>\n<p>one</p>\n<div><p>inner</p></div>\n<p>two</p>';
    const loc = locateElement(html, query({ ancestry: steps(['p', 2]), tag: 'p', text: 'two' }));
    expect(loc).toMatchObject({ match: 'exact', startLine: 4 });
    expect(linesOf(html, loc)).toBe('<p>two</p>');
  });

  it('ignores comments, raw text and void elements while counting', () => {
    const loc = locateElement(
      PAGE,
      query({ ancestry: steps(['main', 1], ['button', 1]), tag: 'button', classes: ['cta'], text: '取消' }),
    );
    expect(loc).toMatchObject({ match: 'exact', startLine: 17, endLine: 17 });
  });

  it('handles implied end tags (p, li, td) and CRLF line ends', () => {
    const html = '<ul>\r\n<li>a\r\n<li>b <b>bold</b>\r\n<li>c\r\n</ul>\r\n<p>x\r\n<div>after</div>';
    const li = locateElement(html, query({ ancestry: steps(['ul', 1], ['li', 2]), tag: 'li', text: 'b bold' }));
    expect(li).toMatchObject({ match: 'exact', startLine: 3, endLine: 3 });
    expect(linesOf(html, li)).toBe('<li>b <b>bold</b>');
    // The <div> closed the <p>: it is a sibling, not a child.
    const div = locateElement(html, query({ ancestry: steps(['div', 1]), tag: 'div', text: 'after' }));
    expect(div).toMatchObject({ match: 'exact', startLine: 7 });
    const table = '<table>\n<tr><td>1<td>2\n<tr><td>3</table>';
    const td = locateElement(
      table,
      query({ ancestry: steps(['table', 1], ['tr', 2], ['td', 1]), tag: 'td', text: '3' }),
    );
    expect(td).toMatchObject({ match: 'exact', startLine: 3 });
  });

  it('falls back to a unique id (approximate) when the ancestry does not lead there', () => {
    const loc = locateElement(
      PAGE,
      query({ ancestry: steps(['div', 1], ['button', 1]), tag: 'button', id: 'send', text: '发送' }),
    );
    expect(loc).toMatchObject({ match: 'approximate', startLine: 14 });
  });

  it('falls back to tag + classes + text when unique', () => {
    const loc = locateElement(
      PAGE,
      query({ ancestry: steps(['section', 3], ['button', 9]), tag: 'button', classes: ['cta'], text: '取消' }),
    );
    expect(loc).toMatchObject({ match: 'approximate', startLine: 17 });
  });

  it('a script-created element gives none, even where the ancestry would fit another element', () => {
    // The page has a third <li> a script appended; the file has two.
    const html = '<ul id="list">\n  <li>苹果</li>\n  <li>香蕉</li>\n</ul>';
    expect(locateElement(html, query({ ancestry: steps(['ul', 1], ['li', 3]), tag: 'li', text: '橙子' }))).toBeNull();
    // A script inserted it FIRST: the ancestry leads to a real <li>, but its text disagrees — not exact, and the
    // text matches nothing.
    expect(locateElement(html, query({ ancestry: steps(['ul', 1], ['li', 1]), tag: 'li', text: '橙子' }))).toBeNull();
    // The <button> written by document.write inside <script> is not markup of the file.
    expect(locateElement(PAGE, query({ ancestry: steps(['button', 1]), tag: 'button', text: 'x' }))).toBeNull();
  });

  it('an ambiguous id or an element without anything to compare gives none', () => {
    const html = '<p id="a">1</p><p id="a">2</p><span></span><span></span>';
    expect(locateElement(html, query({ ancestry: [], tag: 'p', id: 'a', text: '3' }))).toBeNull();
    expect(locateElement(html, query({ ancestry: steps(['div', 1], ['span', 4]), tag: 'span' }))).toBeNull();
  });

  it('decodes entities and attribute quotes', () => {
    const html = '<a href=\'x\' title="a &amp; b">Tom &amp; Jerry&nbsp;!</a>';
    const tree = parseHtmlTree(html);
    expect(tree.children[0]?.attrs.get('title')).toBe('a & b');
    expect(tree.children[0]?.text).toBe('Tom & Jerry !');
    expect(locateElement(html, query({ ancestry: steps(['a', 1]), tag: 'a', text: 'Tom & Jerry !' }))).toMatchObject({
      match: 'exact',
    });
  });

  it('a > inside a quoted attribute does not end the tag', () => {
    const html = '<div data-x="a>b"><span>in</span></div>';
    const loc = locateElement(html, query({ ancestry: steps(['div', 1], ['span', 1]), tag: 'span', text: 'in' }));
    expect(linesOf(html, loc)).toBe('<span>in</span>');
  });
});

const CSS = [
  '/* .cta { not this } */',
  'body { margin: 0; }',
  '.cta {',
  '  padding: 4px 8px;',
  '}',
  '@media (max-width: 600px) {',
  '  .cta { padding: 2px; }',
  '}',
  'a[href="x"]>.cta , h1 { content: "}"; }',
].join('\n');

describe('locateCssRule (S41.2)', () => {
  it('finds a rule by selector text and occurrence, also inside @media', () => {
    expect(locateCssRule(CSS, '.cta')).toMatchObject({ startLine: 3, endLine: 5 });
    expect(locateCssRule(CSS, '.cta', 2)).toMatchObject({ startLine: 7, endLine: 7 });
    expect(locateCssRule(CSS, '.cta', 3)).toBeNull();
  });
  it('normalises whitespace and quotes the way selectorText differs from the file', () => {
    expect(normalizeSelector('a[href=x] > .cta, h1')).toBe(normalizeSelector('a[href="x"]>.cta , h1'));
    const range = locateCssRule(CSS, 'a[href="x"] > .cta, h1');
    expect(range).toMatchObject({ startLine: 9, endLine: 9 });
    expect(CSS.slice(range?.startOffset, range?.endOffset)).toBe('a[href="x"]>.cta , h1 { content: "}"; }');
  });
  it('searches only inside a <style> block of a page', () => {
    const html = '<style>\n.a { color: red; }\n</style>\n<p class="a">x</p>\n<style>.a { color: blue; }</style>';
    const second = styleBlock(html, 1);
    expect(second).not.toBeNull();
    const range = locateCssRule(html, '.a', 1, second?.start, second?.end);
    expect(range).toMatchObject({ startLine: 5 });
    expect(html.slice(range?.startOffset, range?.endOffset)).toBe('.a { color: blue; }');
    expect(styleBlock(html, 2)).toBeNull();
  });
});

describe('numberedExcerpt', () => {
  it('numbers lines and cuts long ranges', () => {
    const text = 'a\nb\nc\nd';
    expect(numberedExcerpt(text, { startLine: 2, endLine: 4, startOffset: 0, endOffset: 0 }, 2)).toBe(
      '2 | b\n3 | c\n  | …',
    );
  });
});
