import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createProblemRecord, recordRepeat, type ProblemInput } from '../../shared/problem';
import { translate } from '../i18n/index';
import { explain, type RuleContext } from '../../diagnostics/rules';
import { OriginalError, ProblemCardBody } from './ProblemCard';

const input: ProblemInput = {
  source: 'runtime',
  severity: 'error',
  projectId: 'p',
  preview: { sessionId: 's4', generation: 3 },
  file: 'script.js',
  line: 12,
  column: 20,
  code: 'ReferenceError',
  message: 'Uncaught ReferenceError: userNmae is not defined',
  stack:
    'ReferenceError: userNmae is not defined\n    at HTMLButtonElement.<anonymous> (http://127.0.0.1:51734/script.js:12:20)',
  at: Date.UTC(2026, 9, 14, 10, 42, 31),
};

const render = (record: ReturnType<typeof createProblemRecord>, locale: 'zh-CN' | 'en' = 'zh-CN') =>
  renderToStaticMarkup(createElement(OriginalError, { id: 'o', record, locale, t: (key) => translate(locale, key) }));

describe('original error (S17.2)', () => {
  it('shows the message and stack verbatim, the code, source attribution and times', () => {
    const html = render(createProblemRecord(input, 'r1'));
    expect(html).toContain('Uncaught ReferenceError: userNmae is not defined');
    expect(html).toContain('at HTMLButtonElement.&lt;anonymous&gt; (http://127.0.0.1:51734/script.js:12:20)');
    expect(html).toContain('代码 ReferenceError');
    expect(html).toContain('来源：预览页面（会话 s4，第 3 次加载）');
    expect(html).toContain('首次');
  });

  it('keeps the latest repeat beside the first when it differs, and says when text was cut', () => {
    const first = createProblemRecord(input, 'r1');
    const repeated = recordRepeat(first, {
      ...input,
      message: 'Uncaught ReferenceError: userNmae is not defined (2)',
      at: input.at + 9000,
    });
    const html = render({ ...repeated, truncated: true }, 'en');
    expect(html).toContain('Latest occurrence:');
    expect(html).toContain('(2)');
    expect(html).toContain('only the beginning is kept');
    expect(html).toContain('Latest ');
  });
});

// ── S22.4: the card matches the PLAN §9 example; S22.5: the fix is offered only with exactly one candidate ──
const LINE_12 = "  alert('你好，' + userNmae);";
const runtimeRecord = createProblemRecord({ ...input, column: 18 }, 'card');

const card = (
  record: ReturnType<typeof createProblemRecord>,
  ctx: RuleContext,
  locale: 'zh-CN' | 'en' = 'zh-CN',
  opts: { onFix?: boolean; originalOpen?: boolean } = {},
) =>
  renderToStaticMarkup(
    createElement(ProblemCardBody, {
      record,
      explanation: explain(record, ctx),
      onGoTo: () => undefined,
      onFix: opts.onFix === false ? undefined : () => undefined,
      t: (key) => translate(locale, key),
      locale,
      originalOpen: opts.originalOpen ?? false,
      onToggleOriginal: () => undefined,
    }),
  );
const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('problem card (S22.4, PLAN §9)', () => {
  const ctx: RuleContext = { lineText: LINE_12, declaredNames: [{ name: 'userName', file: 'script.js', line: 9 }] };

  it('zh-CN: file and line, what was reported, explanation, checks, Go to code and Show original', () => {
    const t = text(card(runtimeRecord, ctx, 'zh-CN', { onFix: false }));
    expect(t).toContain('运行时错误');
    expect(t).toContain('script.js，第 12 行：找不到变量 userNmae。');
    expect(t).toContain('这个名字可能拼错了，也可能还没有定义。');
    expect(t).toContain('可以这样检查：');
    expect(t).toContain('检查它的拼写是否和定义时的 userName（第 9 行）一致。');
    expect(t).toContain('如果这个变量还没有定义，先声明它。');
    expect(t).toContain('转到代码');
    expect(t).toContain('显示原始错误');
  });

  it('en: the same card in English', () => {
    const t = text(card(runtimeRecord, ctx, 'en', { onFix: false }));
    expect(t).toContain('Runtime error');
    expect(t).toContain('script.js, line 12: ');
    expect(t).toMatch(/userNmae/);
    expect(t).toMatch(/userName \(line 9\)/);
    expect(t).toContain('Go to code');
    expect(t).toContain('Show original error');
  });

  it('keeps the original error verbatim behind Show original, and is a labelled group', () => {
    const html = card(runtimeRecord, ctx, 'zh-CN', { originalOpen: true });
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-labelledby="problem-card-head-card"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Uncaught ReferenceError: userNmae is not defined');
  });

  it('lists possible causes for an uncertain resource problem (wireframe 3b)', () => {
    const record = createProblemRecord(
      {
        source: 'resource',
        severity: 'error',
        projectId: 'p',
        file: 'index.html',
        line: 14,
        code: 'resource-failed',
        message: 'GET http://127.0.0.1:1/images/%E5%A4%B4%E5%83%8F.PNG 404 (Not Found)',
        resource: {
          requestedUrl: 'http://127.0.0.1:1/images/%E5%A4%B4%E5%83%8F.PNG',
          requestedPath: 'images/头像.PNG',
          initiatorFile: 'index.html',
          status: 404,
          resourceType: 'image',
        },
        at: 1,
      },
      'res',
    );
    const t = text(card(record, { projectFiles: ['index.html', 'images/头像.png'] }));
    expect(t).toContain('资源加载失败');
    expect(t).toContain('index.html，第 14 行：');
    expect(t).toContain('可能的原因：');
  });
});

describe('one-click fix offer (S22.5)', () => {
  it('exactly one declared name and the span located: the primary button names the replacement', () => {
    const ctx: RuleContext = { lineText: LINE_12, declaredNames: [{ name: 'userName' }, { name: 'greet' }] };
    expect(card(runtimeRecord, ctx)).toMatch(/data-testid="problem-fix"[^>]*>改成 userName</);
    expect(card(runtimeRecord, ctx, 'en')).toMatch(/data-testid="problem-fix"[^>]*>Change to userName</);
  });

  it('several candidates: no fix, the normal explanation and Go to code', () => {
    const ctx: RuleContext = { lineText: LINE_12, declaredNames: [{ name: 'userName' }, { name: 'userNome' }] };
    const html = card(runtimeRecord, ctx);
    expect(html).not.toContain('problem-fix');
    expect(html).toContain('problem-go-to');
    expect(text(html)).toContain('检查它的拼写是否和这些已定义的名字之一一致');
  });

  it('no candidate, or the misspelled name not located on the line: no fix', () => {
    const none = card(runtimeRecord, { lineText: LINE_12, declaredNames: [{ name: 'total' }] });
    expect(none).not.toContain('problem-fix');
    expect(none).toContain('problem-go-to');
    const unlocated = card(runtimeRecord, { declaredNames: [{ name: 'userName' }] });
    expect(unlocated).not.toContain('problem-fix');
  });

  it('no fix handler: no fix button even with one candidate', () => {
    const ctx: RuleContext = { lineText: LINE_12, declaredNames: [{ name: 'userName' }] };
    expect(card(runtimeRecord, ctx, 'zh-CN', { onFix: false })).not.toContain('problem-fix');
  });
});
