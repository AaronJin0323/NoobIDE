/**
 * S55.3 quick fixes, per fix: offered only when the target is unambiguous (fixActionOf over the rules' output), the
 * verdict rules for a quick fix (the same finding on the same line keeps it "still reported"; a failed save is never
 * resolved), and the created-file templates (quiet themselves).
 */
import { describe, expect, it } from 'vitest';
import { checkBeginner, checkBeginnerHtml } from '../../diagnostics/beginner-checks';
import { checkHtml } from '../../diagnostics/html-check';
import { formatMessage } from '../../diagnostics/messages';
import { explain, type RuleContext } from '../../diagnostics/rules';
import type { ProblemRecord } from '../../shared/problem';
import { newFileTemplate } from './file-templates';
import {
  fixActionOf,
  nextPhase,
  recheckOnSave,
  reportsSameProblem,
  sameBeginnerFinding,
  startFix,
  verdict,
} from './fix-model';
import { markerToProblem } from './static-problems';

const FILES = ['index.html', 'images/logo.png', 'css/style.css', 'js/app.js'];
const CTX: RuleContext = { projectFiles: FILES, htmlIds: ['title'], htmlClasses: ['hero', 'card'] };

/** The records NoobIDE's beginner checks produce for `text` (the editor's markers → static records). */
function records(language: string, text: string, relPath: string, ctx: RuleContext = CTX): ProblemRecord[] {
  return checkBeginner(language, text, { relPath, ...ctx }).map((f) => {
    const r = markerToProblem(
      {
        owner: 'noobide-beginner',
        severity: 4,
        code: f.code,
        message: f.message,
        startLineNumber: f.line,
        startColumn: f.column,
        endLineNumber: f.line,
        endColumn: f.endColumn,
      },
      { projectId: 'p', relPath, at: 1 },
    );
    if (!r) throw new Error('no record');
    return r;
  });
}
const fixOf = (r: ProblemRecord, ctx: RuleContext = CTX) => fixActionOf(explain(r, ctx));
const label = (r: ProblemRecord, locale: 'zh-CN' | 'en', ctx: RuleContext = CTX) => {
  const fix = fixOf(r, ctx);
  return fix ? formatMessage(locale, fix.label) : null;
};

describe('fix: pick an existing file for a broken path (rules 16, 24)', () => {
  it('one similar file, or the same name in other letter case → change the path, label names the new path', () => {
    const [similar] = records('html', '<img src="images/logoo.png" alt="a">\n', 'index.html');
    expect(fixOf(similar!)).toMatchObject({ kind: 'replace-text', from: 'images/logoo.png', to: 'images/logo.png' });
    expect(label(similar!, 'zh-CN')).toBe('把路径改成 images/logo.png');
    const [cased] = records('html', '<script src="JS/App.js"></script>\n', 'index.html');
    expect(fixOf(cased!)).toMatchObject({ from: 'JS/App.js', to: 'js/app.js' });
    expect(label(cased!, 'en')).toBe('Change the path to js/app.js');
  });

  it('paths stay relative to the page, keep ?query/#fragment, and keep the root-relative form', () => {
    const [deep] = records('html', '<link rel="stylesheet" href="../css/styel.css?v=3">\n', 'pages/about.html', {
      projectFiles: [...FILES, 'pages/about.html'],
    });
    expect(fixOf(deep!, { projectFiles: [...FILES, 'pages/about.html'] })).toMatchObject({
      to: '../css/style.css?v=3',
    });
    const [root] = records('html', '<img src="/images/logoo.png" alt="a">\n', 'pages/about.html');
    expect(fixOf(root!)).toMatchObject({ to: '/images/logo.png' });
  });

  it('is not offered with several candidates, two case variants, or no file list', () => {
    const [r] = records('html', '<img src="images/log.png" alt="a">\n', 'index.html');
    expect(fixOf(r!, { projectFiles: ['images/logo.png', 'images/loge.png'] })).toBeNull();
    const [c] = records('html', '<img src="Images/Logo.png" alt="a">\n', 'index.html');
    expect(fixOf(c!, { projectFiles: ['images/logo.png', 'images/LOGO.png'] })).toBeNull();
    expect(fixOf(r!, {})).toBeNull();
  });
});

describe('fix: create a missing file from a template (rule 16)', () => {
  it('nothing similar, a text file in an existing folder → create it; never for images or a missing folder', () => {
    const [css] = records('html', '<link rel="stylesheet" href="css/theme.css">\n', 'index.html');
    expect(fixOf(css!)).toMatchObject({ kind: 'create-file', path: 'css/theme.css', template: 'css' });
    expect(label(css!, 'en')).toBe('Create the file css/theme.css');
    const [page] = records('html', '<a href="关于 我.html">关于</a>\n', 'index.html');
    expect(fixOf(page!)).toMatchObject({ kind: 'create-file', path: '关于 我.html', template: 'html' });
    const [img] = records('html', '<img src="images/banner.png" alt="a">\n', 'index.html');
    expect(fixOf(img!)).toBeNull();
    const [folder] = records('html', '<script src="lib/x.js"></script>\n', 'index.html');
    expect(fixOf(folder!)).toBeNull();
  });

  it('templates are valid and quiet: a created page reports no beginner or unclosed-tag problem', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      const html = newFileTemplate({ path: 'pages/关于 <我>.html', template: 'html' }, locale);
      expect(html).toContain(`<html lang="${locale}">`);
      expect(html).toContain('<title>关于 &lt;我&gt;</title>');
      expect(checkBeginnerHtml(html, { relPath: 'pages/x.html', projectFiles: ['pages/x.html'] })).toEqual([]);
      expect(checkHtml(html)).toEqual([]);
      expect(checkBeginner('css', newFileTemplate({ path: 'a.css', template: 'css' }, locale))).toEqual([]);
      expect(checkBeginner('javascript', newFileTemplate({ path: 'a.js', template: 'js' }, locale))).toEqual([]);
    }
  });
});

describe('fix: add an alt attribute (rule 18)', () => {
  it('always offered, replaces exactly the tag name', () => {
    const [img] = records('html', '<p><IMG src="images/logo.png"></p>\n', 'index.html');
    expect(fixOf(img!)).toMatchObject({ from: 'IMG', to: 'IMG alt=""' });
  });
});

describe('fix: close or fix a tag (rule 19)', () => {
  it('a stray closing tag paired with the unclosed element → rename it; otherwise no fix', () => {
    const [stray] = records('html', '<div>\n  <p>a</p>\n</dvi>\n', 'index.html').filter(
      (r) => r.code === 'html-mismatched-close',
    );
    expect(fixOf(stray!)).toMatchObject({ from: 'dvi', to: 'div' });
    expect(label(stray!, 'zh-CN')).toBe('把 </dvi> 改成 </div>');
    // Upper case is kept as written, so the exact replacement matches the text.
    const [upper] = records('html', '<DIV>\n</DVI>\n', 'index.html');
    expect(fixOf(upper!)).toMatchObject({ from: 'DVI', to: 'div' });
    const [dup] = records('html', '<div>\n</div>\n</div>\n', 'index.html');
    expect(fixOf(dup!)).toBeNull();
  });
});

describe('fix: rename to the defined id/class (rule 23)', () => {
  it('drops the # in getElementById for a defined id; adds # or . in querySelector when exactly one exists', () => {
    const [byId, query] = records('javascript', "getElementById('#title');\nquerySelector('hero');\n", 'js/app.js');
    expect(fixOf(byId!)).toMatchObject({ from: '#title', to: 'title' });
    expect(fixOf(query!)).toMatchObject({ from: 'hero', to: '.hero' });
    expect(label(query!, 'en')).toBe("Change 'hero' to '.hero'");
    expect(fixOf(query!, { htmlIds: ['hero'], htmlClasses: ['hero'] })).toBeNull();
    const [unknown] = records('javascript', "getElementById('#nav');\n", 'js/app.js');
    expect(fixOf(unknown!)).toBeNull();
  });
});

describe('rules without a quick fix (17, 20, 25) offer none', () => {
  it('duplicate id, unitless length, assignment in a condition', () => {
    const all = [
      ...records('html', '<p id="a"></p>\n<p id="a"></p>\n', 'index.html'),
      ...records('css', 'p { width: 10; }\n', 'css/style.css'),
      ...records('javascript', 'if (a = 1) {}\n', 'js/app.js'),
    ];
    expect(all).toHaveLength(3);
    for (const r of all) expect(fixOf(r)).toBeNull();
  });
});

describe('verdict of a quick fix', () => {
  const [record] = records('html', '<img src="images/logoo.png" alt="a">\n', 'index.html');
  const fix = startFix(record!, fixOf(record!)!);

  it('the same finding (same code, line and path) is the same problem; a different path is not', () => {
    expect(reportsSameProblem(fix, record!)).toBe(true);
    const [other] = records('html', '<img src="images/logo2.png" alt="a">\n', 'index.html', { projectFiles: [] });
    expect(sameBeginnerFinding(record!, { code: other!.code, line: 1, message: other!.originalMessage })).toBe(false);
  });

  it('resolved only after the re-check answered "not reported"; a failed save never becomes resolved', () => {
    const checking = { ...fix, phase: 'checking' as const, version: 2 };
    expect(verdict(checking, null, [])).toBe('checking');
    expect(verdict(checking, true, [])).toBe('still-reported');
    expect(verdict(checking, false, [])).toBe('resolved');
    const failed = { ...fix, phase: 'save-failed' as const, version: 2 };
    expect(nextPhase(failed, false, [])).toBe('save-failed');
  });
});

describe('re-check on save (review fix)', () => {
  const [page] = records('html', '<link rel="stylesheet" href="css/theme.css">\n', 'index.html');
  const create = startFix(page!, fixOf(page!)!);

  it('a save of the page re-checks a saved create-file fix, never one whose own save failed', () => {
    expect(recheckOnSave({ ...create, phase: 'checking' }, 'index.html')).toBe(true);
    expect(recheckOnSave({ ...create, phase: 'unchecked' }, 'index.html')).toBe(true);
    expect(recheckOnSave({ ...create, phase: 'save-failed' }, 'index.html')).toBe(false);
    expect(recheckOnSave({ ...create, phase: 'save-failed' }, 'css/theme.css')).toBe(true);
    expect(recheckOnSave({ ...create, phase: 'checking' }, 'other.html')).toBe(false);
    expect(recheckOnSave({ ...create, phase: 'not-applied' }, 'css/theme.css')).toBe(false);
  });
});
