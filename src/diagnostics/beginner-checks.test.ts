import { describe, expect, it } from 'vitest';
import {
  MAX_BEGINNER_CHECK_CHARS,
  beginnerFacts,
  beginnerMessages,
  checkBeginner,
  checkBeginnerHtml,
  checkBeginnerJs,
  maskJs,
  matchReference,
  relativeReference,
  resolveReference,
} from './beginner-checks';

describe('beginner checks (S55.2): references', () => {
  it('resolves relative, ./, ../ and root-relative paths, drops ?query and #fragment, decodes %xx', () => {
    expect(resolveReference('pages/a.html', '../img/x.png')).toBe('img/x.png');
    expect(resolveReference('pages/a.html', './b.html#top')).toBe('pages/b.html');
    expect(resolveReference('pages/a.html', '/css/s.css?v=1')).toBe('css/s.css');
    expect(resolveReference('a.html', '%E5%9B%BE%E7%89%87/my%20pic.png')).toBe('图片/my pic.png');
  });

  it('does not check what is not a project path', () => {
    for (const ref of [
      '',
      '#top',
      '//cdn.x/a.js',
      'https://x/a.js',
      'mailto:a@b',
      'data:image/png;base64,AA',
      '{{ url }}',
      'a/',
      '../../up.png',
      'C:\\x.png',
      '%E0%A4%A',
    ]) {
      expect(resolveReference('pages/a.html', ref), ref).toBeNull();
    }
  });

  it('matches exactly (NFC), by case only, or lists similar names / the same name elsewhere', () => {
    const files = ['images/logo.png', 'img/icon.png', 'Café.png'.normalize('NFD')];
    expect(matchReference('images/logo.png', files).kind).toBe('exact');
    expect(matchReference('Café.png', files).kind).toBe('exact');
    expect(matchReference('Images/LOGO.png', files)).toEqual({ kind: 'case', actuals: ['images/logo.png'] });
    expect(matchReference('images/logoo.png', files)).toEqual({ kind: 'missing', candidates: ['images/logo.png'] });
    expect(matchReference('images/icon.png', files)).toEqual({ kind: 'missing', candidates: ['img/icon.png'] });
    expect(matchReference('images/zzz.png', files)).toEqual({ kind: 'missing', candidates: [] });
  });

  it('writes a target relative to the referring file', () => {
    expect(relativeReference('index.html', 'images/a.png')).toBe('images/a.png');
    expect(relativeReference('pages/x/a.html', 'pages/b.css')).toBe('../b.css');
    expect(relativeReference('pages/a.html', 'pages/b.css')).toBe('b.css');
  });

  it('checks only <link> stylesheets and icons, and nothing without a file list', () => {
    const html = '<link rel="preconnect" href="nope.css">\n<link rel="stylesheet" href="nope.css">\n';
    expect(checkBeginnerHtml(html, { relPath: 'a.html', projectFiles: ['a.html'] }).map((f) => f.line)).toEqual([2]);
    expect(checkBeginnerHtml(html, { relPath: 'a.html' })).toEqual([]);
  });

  it('locates unquoted and single-quoted values exactly', () => {
    const html = "<img src=x.png alt=a>\n<img src='y.png' alt=''>\n";
    const list = checkBeginnerHtml(html, { relPath: 'a.html', projectFiles: ['a.html'] });
    expect(list.map((f) => [f.line, f.column, f.endColumn])).toEqual([
      [1, 10, 15],
      [2, 11, 16],
    ]);
  });
});

describe('beginner checks: HTML structure', () => {
  it('raw text elements, comments and void elements never produce stray closing tags', () => {
    const html = '<!-- </div> -->\n<title>a</title>\n<script>if (a < b) {}</script>\n<style>p{}</style>\n<br/><hr>\n';
    expect(checkBeginnerHtml(html)).toEqual([]);
  });

  it('a non-JavaScript or external <script> is not checked as code', () => {
    const html = '<script type="text/template">if (a = b) {}</script>\n<script src="a.js">if (a = b) {}</script>\n';
    expect(checkBeginnerHtml(html)).toEqual([]);
    expect(checkBeginnerHtml('<script type="module">\nif (a = b) {}\n</script>\n')).toEqual([
      expect.objectContaining({ code: 'js-assign-in-condition', line: 2, column: 7 }),
    ]);
  });

  it('skips files over the size limit', () => {
    expect(checkBeginner('html', `<img>${' '.repeat(MAX_BEGINNER_CHECK_CHARS)}`)).toEqual([]);
  });
});

describe('beginner checks: JavaScript', () => {
  it('masks comments, strings, templates and regular expressions but keeps offsets', () => {
    const code = 'a = "x=y"; // b = c\nr = /=/g; t = `${q = 1}`;';
    const masked = maskJs(code);
    expect(masked).toHaveLength(code.length);
    const gap = ' '.repeat(8);
    expect(masked).toBe(`a = "   "; ${gap}\nr = / /g; t = \`${gap}\`;`);
  });

  it('selector checks need the call in code; querySelector needs a project id or class and is never a tag', () => {
    const js = "q.querySelector('main'); q.querySelector('hero'); q.querySelector('my-el');";
    expect(checkBeginnerJs(js, { htmlClasses: ['hero', 'main', 'my-el'] }).map((f) => f.column)).toEqual([43]);
    expect(checkBeginnerJs(js)).toEqual([]);
  });

  it('assignment: only at the top level of the condition', () => {
    expect(checkBeginnerJs('if (a.some((x) => (y = x))) {}')).toEqual([]);
    expect(checkBeginnerJs('while (n = next()) {}')).toEqual([
      expect.objectContaining({ code: 'js-assign-in-condition', column: 10 }),
    ]);
  });
});

describe('beginner checks: facts round-trip through the message', () => {
  it('every message gives its facts back', () => {
    expect(beginnerFacts('html-ref-case', beginnerMessages.refCase('href', 'A.css', 'a.css'))).toEqual({
      attr: 'href',
      ref: 'A.css',
      actual: 'a.css',
    });
    expect(beginnerFacts('html-mismatched-close', beginnerMessages.mismatchedClose('dvi', 'div', true))).toEqual({
      tagName: 'dvi',
      open: 'div',
      pairs: 'yes',
    });
    expect(beginnerFacts('html-mismatched-close', beginnerMessages.mismatchedClose('dvi', undefined, false))).toEqual({
      tagName: 'dvi',
    });
    expect(beginnerFacts('css-unitless-length', beginnerMessages.unitlessLength('margin', '0 10'))).toEqual({
      property: 'margin',
      value: '0 10',
    });
    expect(beginnerFacts('js-selector-prefix', beginnerMessages.selectorPrefix('querySelectorAll', 'hero'))).toEqual({
      method: 'querySelectorAll',
      selector: 'hero',
    });
    expect(beginnerFacts('js-assign-in-condition', beginnerMessages.assignInCondition('while'))).toEqual({
      keyword: 'while',
    });
    expect(beginnerFacts('2304', 'x')).toBeNull();
  });
});
