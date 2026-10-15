import { describe, expect, it } from 'vitest';
import { extractCssSymbols, extractHtmlSymbols } from './project-symbols';

describe('extractCssSymbols (S43.4)', () => {
  const cases: [string, string, string[], string[]][] = [
    ['simple selectors', '.card { color: red; } #title { margin: 0 }', ['title'], ['card']],
    ['compound and lists', 'div.a.b, #x > .c:hover, ul li.d::before {}', ['x'], ['a', 'b', 'c', 'd']],
    ['hex colours in declarations are not ids', '.a { color: #fff; background: #ABCDEF }', [], ['a']],
    ['numbers in declarations are not classes', '.a { margin: .5em; line-height: 1.5 }', [], ['a']],
    ['comments are skipped', '/* .ghost #nope { } */ .real {}', [], ['real']],
    ['strings and attribute selectors are skipped', 'a[href$=".pdf"], [data-x="#y"] .z {}', [], ['z']],
    ['url() content is skipped', '.a { background: url(img/x.png#frag) } .b{}', [], ['a', 'b']],
    [
      'data url with ; and { inside',
      '.a { background: url(data:image/svg+xml;utf8,<svg>{</svg>) } .b {}',
      [],
      ['a', 'b'],
    ],
    [
      '@media nesting counts',
      '@media (min-width: 600px) { .wide { } #side {} } .after {}',
      ['side'],
      ['wide', 'after'],
    ],
    ['@supports nesting counts', '@supports (display:grid) { .grid {} }', [], ['grid']],
    ['@keyframes steps are not selectors', '@keyframes spin { from { x: 1 } 50.5% { } } .k {}', [], ['k']],
    ['@font-face / @import are not selectors', '@import "a.css"; @font-face { src: url(f.woff) } .f {}', [], ['f']],
    ['dedupe keeps first-seen order', '.b {} .a {} .b {} #i {} #i {}', ['i'], ['b', 'a']],
    ['case-sensitive', '.Btn {} .btn {}', [], ['Btn', 'btn']],
    ['escaped names', '.sm\\:p-4 {}', [], ['sm:p-4']],
    ['non-ASCII names', '.标题 {} #主要 {}', ['主要'], ['标题']],
    ['digits-only after dot is not a class', '.5 {} .-1 {} .ok {}', [], ['ok']],
    ['nested rules inside a declaration block are ignored', '.a { color: red; .inner { } }', [], ['a']],
    ['unterminated comment', '.a {} /* .b {}', [], ['a']],
  ];
  it.each(cases)('%s', (_name, css, ids, classes) => {
    expect(extractCssSymbols(css)).toEqual({ ids, classes });
  });
});

describe('extractHtmlSymbols (S43.4)', () => {
  const cases: [string, string, string[], string[]][] = [
    ['double, single and unquoted ids', `<p id="a"></p><p id='b'></p><p id=c></p>`, ['a', 'b', 'c'], []],
    ['class lists', '<div class="card  big\tred"><span class=x></span></div>', [], ['card', 'big', 'red', 'x']],
    ['comments are ignored', '<!-- <p id="ghost" class="nope"> --><p id="real">', ['real'], []],
    ['template syntax is ignored', '<p id="{{ x }}" class="a ${b}"></p><p class="ok">', [], ['ok']],
    ['style blocks contribute selectors', '<style>.s {} #t { color: #fff }</style><p class="p">', ['t'], ['s', 'p']],
    ['script blocks are skipped', '<script>el.innerHTML = \'<p id="x" class="y">\'</script><b id="z">', ['z'], []],
    [
      'attribute names are case-insensitive, values case-sensitive',
      '<P ID="Top" CLASS="Hero hero">',
      ['Top'],
      ['Hero', 'hero'],
    ],
    ['dedupe keeps first-seen order', '<a class="b a"><b class="a c" id="x"><i id="x">', ['x'], ['b', 'a', 'c']],
    ['data-id / aria attributes do not count', '<p data-id="no" data-class="no" aria-labelledby="no">', [], []],
    ['ids with spaces are not ids', '<p id="two words">', [], []],
    ['Chinese names', '<p id="标题" class="卡片 大">', ['标题'], ['卡片', '大']],
    ['unclosed comment ends the scan', '<p id="a"><!-- <p id="b">', ['a'], []],
    ['> inside a quoted value', '<p title="a > b" id="after">', ['after'], []],
  ];
  it.each(cases)('%s', (_name, html, ids, classes) => {
    expect(extractHtmlSymbols(html)).toEqual({ ids, classes });
  });

  it('copes with a 256 KB document', () => {
    const chunk = '<div id="i{n}" class="c{n} shared"><style>.s{n} { color: #fff; margin: .5em }</style></div>\n';
    let text = '';
    for (let n = 0; text.length < 256 * 1024; n++) text += chunk.replaceAll('{n}', String(n));
    const t0 = performance.now();
    const symbols = extractHtmlSymbols(text);
    const ms = performance.now() - t0;
    expect(symbols.ids.length).toBeGreaterThan(1000);
    expect(symbols.classes).toContain('shared');
    expect(ms).toBeLessThan(500);
  });
});
