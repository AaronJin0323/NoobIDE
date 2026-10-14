import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createProblemRecord, recordRepeat, type ProblemInput } from '../../shared/problem';
import { translate } from '../i18n/index';
import { OriginalError } from './ProblemCard';

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
