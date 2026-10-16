import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createProblemRecord, type ProblemRecord } from '../../shared/problem';
import { translate, type Locale } from '../i18n/index';
import { I18nValueProvider } from '../i18n/I18nProvider';
import { ProblemsPanel } from '../workbench/ProblemsPanel';
import { buildView } from './problems-view';

const located = createProblemRecord(
  {
    source: 'runtime',
    severity: 'error',
    projectId: 'p',
    file: 'script.js',
    line: 3,
    column: 13,
    code: 'ReferenceError',
    message: 'Uncaught ReferenceError: userNmae is not defined',
    at: Date.UTC(2026, 9, 15),
  },
  'r1',
);
const unlocated = createProblemRecord(
  {
    source: 'runtime',
    severity: 'error',
    projectId: 'p',
    code: 'Error',
    message: 'Script error.',
    at: Date.UTC(2026, 9, 15) + 1,
  },
  'r2',
);

const noop = () => undefined;
function render(records: ProblemRecord[], onFixWithAi?: () => void, locale: Locale = 'zh-CN') {
  return renderToStaticMarkup(
    createElement(
      I18nValueProvider,
      { value: { locale, t: (key) => translate(locale, key), setLocale: noop } },
      createElement(ProblemsPanel, {
        open: true,
        onToggle: noop,
        projectOpen: true,
        view: buildView('p', [], records),
        onFixWithAi,
      }),
    ),
  );
}

describe('"Fix with AI" right on a problem row', () => {
  it('is on the collapsed row of a located problem while AI is offered', () => {
    const html = render([located], noop);
    expect(html).toMatch(/data-testid="problem-row-fix-ai"[^>]*><svg[^]*?<\/svg>用 AI 修复<\/button>/);
    // Its name says which problem it fixes (several rows each have one).
    expect(html).toMatch(/aria-label="用 AI 修复：[^"]+" [^>]*data-testid="problem-row-fix-ai"/);
    expect(render([located], noop, 'en')).toContain('>Fix with AI</button>');
  });

  it('is a sibling of the row toggle, never nested inside it', () => {
    const html = render([located], noop);
    const summaryStart = html.indexOf('data-testid="problem-summary"');
    const summaryEnd = html.indexOf('</button>', summaryStart);
    const fix = html.indexOf('data-testid="problem-row-fix-ai"');
    expect(summaryStart).toBeGreaterThan(-1);
    expect(fix).toBeGreaterThan(summaryEnd);
    expect(html).toContain('class="problem-row-line"');
  });

  it('is not offered without AI, or for a problem without a file and line', () => {
    expect(render([located])).not.toContain('problem-row-fix-ai');
    expect(render([unlocated], noop)).not.toContain('problem-row-fix-ai');
  });
});
