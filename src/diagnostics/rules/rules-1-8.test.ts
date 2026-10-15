import { describe, expect, it } from 'vitest';
import { createProblemRecord } from '../../shared/problem';
import { renderExplanation } from './engine';
import { USER_NMAE_COLUMN, USER_NMAE_LINE, fixture } from './fixtures';
import { explain } from './index';

const render = (name: string, locale: 'zh-CN' | 'en' = 'zh-CN') => {
  const f = fixture(name);
  return renderExplanation(locale, f.record, explain(f.record, f.ctx));
};

describe('rule 1: misspelled variable with did-you-mean', () => {
  it('reproduces the PLAN §9 / wireframe 3 card in zh-CN and en', () => {
    const zh = render('runtime-referenceerror-one-candidate');
    expect(zh.location).toBe('script.js，第 12 行：');
    expect(zh.title).toBe('找不到变量 userNmae。');
    expect(zh.checks).toEqual([
      '检查它的拼写是否和定义时的 userName（第 9 行）一致。',
      '如果这个变量还没有定义，先声明它。',
    ]);
    const en = render('runtime-referenceerror-one-candidate', 'en');
    expect(en.location).toBe('script.js, line 12: ');
    expect(en.title).toBe('Cannot find the variable userNmae.');
    expect(en.checks).toEqual([
      'Check whether its spelling matches userName (line 9) where it was defined.',
      'If the variable has not been defined yet, declare it first.',
    ]);
    expect(en.actions.map((a) => a.label)).toEqual(['Change to userName', 'Go to code', 'Show original error']);
  });

  it('returns the single candidate and the exact span for the one-click fix (S22.5)', () => {
    const f = fixture('runtime-referenceerror-one-candidate');
    const exp = explain(f.record, f.ctx);
    expect(exp.certainty).toBe('likely');
    expect(exp.candidates).toEqual(['userName']);
    const span = {
      file: 'script.js',
      line: 12,
      column: USER_NMAE_COLUMN,
      endColumn: USER_NMAE_COLUMN + 'userNmae'.length,
    };
    expect(exp.span).toEqual(span);
    expect(USER_NMAE_LINE.slice(span.column - 1, span.endColumn - 1)).toBe('userNmae');
    expect(exp.actions[0]).toEqual({
      kind: 'replace-text',
      label: { key: 'action.replaceWith', params: { name: 'userName' } },
      span,
      from: 'userNmae',
      to: 'userName',
    });
  });

  it('offers no fix with several candidates, and lists them', () => {
    const f = fixture('runtime-referenceerror-one-candidate');
    const exp = explain(f.record, { ...f.ctx, declaredNames: [{ name: 'userName' }, { name: 'userNames' }] });
    expect(exp.candidates).toEqual(['userName', 'userNames']);
    expect(exp.actions.some((a) => a.kind === 'replace-text')).toBe(false);
    expect(exp.certainty).toBe('possible');
    expect(renderExplanation('zh-CN', f.record, exp).checks[0]).toBe(
      '检查它的拼写是否和这些已定义的名字之一一致：userName / userNames。',
    );
  });

  it('offers no fix when the name cannot be located exactly on the line', () => {
    const f = fixture('runtime-referenceerror-one-candidate');
    const noLine = explain(f.record, { declaredNames: f.ctx.declaredNames ?? [] });
    expect(noLine.candidates).toEqual(['userName']);
    expect(noLine.span).toBeUndefined();
    expect(noLine.actions.some((a) => a.kind === 'replace-text')).toBe(false);
    const twice = explain(createProblemRecord({ ...base(), column: undefined } as never), {
      declaredNames: [{ name: 'userName' }],
      lineText: 'userNmae + userNmae',
    });
    expect(twice.actions.some((a) => a.kind === 'replace-text')).toBe(false);
  });

  it('with no candidates: spelling, declare and other-file checks, worded as possible', () => {
    const exp = explain(
      fixture('runtime-referenceerror-no-candidates').record,
      fixture('runtime-referenceerror-no-candidates').ctx,
    );
    expect(exp.candidates).toEqual([]);
    expect(exp.certainty).toBe('possible');
    expect(exp.checks.map((c) => c.key)).toEqual([
      'undefinedName.check.spelling',
      'undefinedName.check.declare',
      'undefinedName.check.otherFile',
    ]);
  });

  it('handles Chinese identifiers and the language service suggestion (2552)', () => {
    expect(
      explain(fixture('runtime-referenceerror-chinese-name').record, fixture('runtime-referenceerror-chinese-name').ctx)
        .candidates,
    ).toEqual(['用户名称']);
    const s = fixture('static-2552-did-you-mean');
    const exp = explain(s.record, s.ctx);
    expect(exp.candidates).toEqual(['userName']);
    expect(exp.actions[0]?.kind).toBe('replace-text');
  });

  it('notes case-only differences', () => {
    const f = fixture('runtime-referenceerror-one-candidate');
    const r = createProblemRecord({ ...base(), message: 'Uncaught ReferenceError: username is not defined' });
    const zh = renderExplanation(
      'zh-CN',
      r,
      explain(r, { declaredNames: [{ name: 'userName', line: 9, file: 'script.js' }] }),
    );
    expect(zh.checks).toContain('JavaScript 区分大小写：username 和 userName 是两个不同的名字。');
    expect(f).toBeDefined();
  });

  function base() {
    return {
      source: 'runtime',
      severity: 'error',
      projectId: 'p',
      file: 'script.js',
      line: 1,
      code: 'ReferenceError',
      message: 'Uncaught ReferenceError: userNmae is not defined',
      at: 1,
    } as const;
  }
});

describe('rule 2: brackets and syntax', () => {
  it('end of input → unclosed bracket, likely', () => {
    const f = fixture('runtime-unexpected-end');
    const exp = explain(f.record, f.ctx);
    expect(exp.certainty).toBe('likely');
    expect(render('runtime-unexpected-end').explanation).toContain('没有闭合');
  });

  it('extra closing bracket names the token', () => {
    expect(render('runtime-unexpected-close', 'en').title).toBe('Unexpected } here.');
    expect(render('static-brace-expected', 'en').title).toBe(
      'The code ends before it is finished (unexpected end of input).',
    );
    expect(render('runtime-missing-paren').title).toBe('函数调用缺少右括号 )。');
  });

  it('points at full-width Chinese punctuation on the line', () => {
    expect(render('runtime-invalid-token-fullwidth').causes[0]).toBe(
      '这一行有中文标点 ；，代码里的符号需要用英文标点。',
    );
  });

  it('other syntax errors get the generic, possible explanation', () => {
    const f = fixture('runtime-unexpected-identifier');
    expect(explain(f.record).certainty).toBe('possible');
    expect(render('runtime-unexpected-identifier', 'en').title).toBe('Unexpected name here.');
  });
});

describe('rule 3: DOM element is null', () => {
  it('names the missing id and a similar id from the HTML', () => {
    const r = render('runtime-null-addEventListener');
    expect(r.title).toBe('要操作的页面元素没有找到（得到的是 null），所以无法使用 addEventListener。');
    expect(r.causes).toEqual([
      'HTML 里可能没有 id 为“btn”的元素。',
      'HTML 里有一个相似的 id：“Btn”，可能是拼写或大小写不一致。',
      '脚本可能在元素出现之前就运行了：<script> 写在 <head> 里或元素的上方。',
    ]);
  });

  it('handles querySelector and a # passed to getElementById', () => {
    expect(render('runtime-null-set-textContent-selector', 'en').causes[0]).toBe(
      'The selector “.title” may not match any element.',
    );
    expect(render('runtime-null-id-with-hash', 'en').causes[0]).toBe(
      "getElementById does not take a #: it may need to be getElementById('box').",
    );
  });

  it('when the id exists in the HTML, only the timing cause remains', () => {
    const f = fixture('runtime-null-addEventListener');
    const exp = explain(f.record, { ...f.ctx, htmlIds: ['btn'] });
    expect(exp.causes.map((c) => c.key)).toEqual(['nullElement.cause.tooEarly']);
  });
});

describe('rules 4–6: script, image and stylesheet 404', () => {
  it('image case mismatch matches wireframe 3b, with "show images in file tree"', () => {
    const zh = render('image-404-case-mismatch');
    expect(zh.location).toBe('index.html，第 14 行：');
    expect(zh.title).toBe('图片 images/头像.PNG 没有加载出来（404）。');
    expect(zh.causesHeading).toBe('可能的原因：');
    expect(zh.causes[0]).toBe(
      '文件名大小写不一致：项目里是 images/头像.png。在 Windows 上能显示，在 Mac 或网站上可能不行。',
    );
    expect(zh.actions.map((a) => a.label)).toEqual(['转到代码', '在文件树中显示 images', '显示原始错误']);
    const f = fixture('image-404-case-mismatch');
    expect(explain(f.record, f.ctx).certainty).toBe('likely');
  });

  it('script in another folder; missing script; stylesheet with a similar name', () => {
    expect(render('script-404-other-folder', 'en').causes).toEqual([
      'The file may be in another folder: the project has js/app.js.',
    ]);
    const missing = fixture('script-404-missing');
    expect(explain(missing.record, missing.ctx).causes.map((c) => c.key)).toEqual(['notFound.cause.missing']);
    expect(render('script-404-missing').title).toBe('脚本 js/app.js 没有加载出来（404），里面的代码不会运行。');
    const css = render('css-404-similar-name');
    expect(css.title).toBe('样式表 styles.css 没有加载出来（404），里面的样式不会生效。');
    expect(css.causes).toEqual(['文件名可能拼错了：项目里有一个相似的文件 style.css。']);
    expect(css.checks[0]).toBe('路径是从 我的 主页/index.html 所在的文件夹开始算的；去上一级文件夹要写 ../。');
  });

  it('without a file list it stays generic and possible', () => {
    const f = fixture('image-404-no-file-list');
    const exp = explain(f.record, f.ctx);
    expect(exp.certainty).toBe('possible');
    expect(exp.causes.map((c) => c.key)).toEqual(['notFound.cause.missing']);
  });

  it('a link to a page that does not exist is explained as a missing page (zh-CN and en)', () => {
    const zh = render('page-404-missing');
    expect(zh.title).toBe('页面 about.html 不存在（404）：有一个链接指向了不存在的页面。');
    expect(zh.explanation).toContain('回到入口页面');
    expect(zh.causes).toEqual(['项目里可能还没有这个文件，或者文件名写错了。']);
    expect(zh.checks).toEqual([
      '检查 index.html 里这个链接的 href：文件名、扩展名和大小写。',
      '路径是从 index.html 所在的文件夹开始算的；去上一级文件夹要写 ../。',
      '如果这个页面还没写，就在文件列表里用完全相同的名字新建它。',
    ]);
    const en = render('page-404-missing', 'en');
    expect(en.title).toBe('The page about.html does not exist (404): a link leads to a missing page.');
    expect(en.explanation).toContain('Back to entry page');
    expect(render('page-404-similar-name').causes).toEqual(['文件名可能拼错了：项目里有一个相似的文件 关于我.html。']);
    const f = fixture('page-404-similar-name');
    expect(explain(f.record, f.ctx).certainty).toBe('likely');
  });

  it('the page rule leaves the preview root and other resources alone', () => {
    const f = fixture('page-404-missing');
    const root = { ...f.record, resource: { ...f.record.resource!, requestedPath: '' } };
    expect(explain(root).ruleId).not.toBe('page-not-found');
    const byExtension = { ...f.record, resource: { ...f.record.resource!, resourceType: 'other' as const } };
    expect(explain(byExtension).ruleId).toBe('page-not-found');
    const fetched = { ...f.record, resource: { ...f.record.resource!, resourceType: 'fetch' as const } };
    expect(explain(fetched).ruleId).not.toBe('page-not-found');
  });

  it('does not apply to non-404 statuses or fetch requests', () => {
    const f = fixture('image-404-no-file-list');
    const ok = { ...f.record, resource: { ...f.record.resource!, status: 500 } };
    expect(explain(ok).ruleId).toBe('fallback');
    const fetched = { ...f.record, resource: { ...f.record.resource!, resourceType: 'fetch' as const } };
    expect(explain(fetched).ruleId).not.toBe('image-not-found');
  });
});

describe('rule 7: misspelled CSS property', () => {
  it('suggests the close property and returns its exact span', () => {
    const f = fixture('css-unknown-property-colr');
    const exp = explain(f.record, f.ctx);
    expect(exp.candidates).toEqual(['color']);
    expect(exp.span).toEqual({ file: 'style.css', line: 4, column: 3, endColumn: 7 });
    expect(render('css-unknown-property-colr').explanation).toBe('可能是 color 拼错了。');
    expect(render('css-unknown-property-backround-color', 'en').explanation).toBe(
      'It may be a misspelling of background-color.',
    );
  });

  it('ignores vendor-prefixed properties and other sources', () => {
    const f = fixture('css-unknown-property-colr');
    expect(explain({ ...f.record, originalMessage: "Unknown property: '-webkit-foo'" }).ruleId).toBe('fallback');
    expect(explain({ ...f.record, source: 'console' }).ruleId).not.toBe('css-unknown-property');
  });
});

describe('rule 8: module import failures', () => {
  it('bare specifier explains npm packages are not supported', () => {
    const en = render('module-bare-specifier', 'en');
    expect(en.title).toBe('The module "lodash" could not be loaded.');
    expect(en.explanation).toContain('npm');
  });

  it('import outside a module → type="module"', () => {
    expect(render('module-import-outside-module').checks).toEqual(['在 HTML 里给这个 <script> 加上 type="module"。']);
  });

  it('missing export names the module and the import', () => {
    expect(render('module-missing-export', 'en').title).toBe('./util.js has no export named add.');
  });

  it('MIME type text/html → the module file may not exist', () => {
    const f = fixture('module-mime-html');
    expect(explain(f.record).certainty).toBe('possible');
  });
});
