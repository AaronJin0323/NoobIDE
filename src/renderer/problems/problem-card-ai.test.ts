import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createProblemRecord } from '../../shared/problem';
import { explain } from '../../diagnostics/rules';
import { translate } from '../i18n/index';
import { ProblemCardBody } from './ProblemCard';

const record = createProblemRecord(
  {
    source: 'runtime',
    severity: 'error',
    projectId: 'p',
    file: 'script.js',
    line: 12,
    column: 18,
    code: 'ReferenceError',
    message: 'Uncaught ReferenceError: userNmae is not defined',
    at: Date.UTC(2026, 9, 15),
  },
  'r1',
);

const card = (locale: 'zh-CN' | 'en', onAskAi?: () => void) =>
  createElement(ProblemCardBody, {
    record,
    explanation: explain(record, {}),
    onGoTo: () => undefined,
    onAskAi,
    t: (key) => translate(locale, key),
    locale,
    originalOpen: false,
    onToggleOriginal: () => undefined,
  });

describe('Ask AI on the problem card (S33.2)', () => {
  it('is offered only while AI is available', () => {
    expect(renderToStaticMarkup(card('zh-CN'))).not.toContain('problem-ask-ai');
    const zh = renderToStaticMarkup(card('zh-CN', () => undefined));
    expect(zh).toMatch(/data-testid="problem-ask-ai"[^>]*><svg[^]*?<\/svg>问 AI<\/button>/);
    const en = renderToStaticMarkup(card('en', () => undefined));
    expect(en).toMatch(/data-testid="problem-ask-ai"[^>]*><svg[^]*?<\/svg>Ask AI<\/button>/);
  });
});
