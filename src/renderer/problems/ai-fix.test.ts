import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createProblemRecord, type ProblemRecord } from '../../shared/problem';
import { explain } from '../../diagnostics/rules';
import { translate } from '../i18n/index';
import { canRecheckAiFix, nextAiFixPhase, sameAiProblem, startAiFix } from './ai-fix';
import { aiFixStatusText } from './AiFixCard';
import { ProblemCardBody } from './ProblemCard';

const at = Date.UTC(2026, 9, 15);
const runtime = (id: string, generation: number, extra: Partial<ProblemRecord> = {}): ProblemRecord => ({
  ...createProblemRecord(
    {
      source: 'runtime',
      severity: 'error',
      projectId: 'p',
      file: 'script.js',
      line: 3,
      column: 13,
      code: 'ReferenceError',
      message: 'Uncaught ReferenceError: userNmae is not defined',
      at,
      preview: { sessionId: 's', generation },
    },
    id,
  ),
  ...extra,
});
const typeError = createProblemRecord(
  {
    source: 'runtime',
    severity: 'error',
    projectId: 'p',
    file: 'app.js',
    line: 7,
    code: 'TypeError',
    message: "Uncaught TypeError: Cannot read properties of null (reading 'addEventListener')",
    at,
  },
  't1',
);
const staticRecord = createProblemRecord(
  {
    source: 'static',
    severity: 'error',
    projectId: 'p',
    file: 'script.js',
    line: 3,
    code: '2304',
    message: "Cannot find name 'userNmae'.",
    at,
  },
  's1',
);

describe('AI fix verdict follows the S22.5 rules (S35.2)', () => {
  it('a failed save is never resolved and is not judged', () => {
    const fix = startAiFix(staticRecord, { saved: false, saveError: 'disk-full', loadsAtRequest: 0 });
    expect(fix.phase).toBe('save-failed');
    expect(nextAiFixPhase(fix, false, [], 5)).toBe('save-failed');
    expect(canRecheckAiFix(fix)).toBe(false);
  });

  it('a code-check problem is resolved once the re-check no longer reports it', () => {
    const fix = startAiFix(staticRecord, { saved: true, loadsAtRequest: 0 });
    expect(fix.phase).toBe('checking');
    expect(nextAiFixPhase(fix, null, [], 0)).toBe('checking');
    expect(nextAiFixPhase(fix, true, [], 0)).toBe('still-reported');
    expect(nextAiFixPhase(fix, false, [], 0)).toBe('resolved');
  });

  it('a page problem waits for a preview load after the save, and is still reported when it occurs again', () => {
    const record = runtime('r1', 1);
    const fix = startAiFix(record, { saved: true, loadsAtRequest: 2 });
    expect(fix.generation).toBe(1);
    expect(nextAiFixPhase(fix, false, [record], 2)).toBe('awaiting-refresh');
    // The reload completed and the problem did not occur again (marked stale by the new generation).
    expect(nextAiFixPhase(fix, false, [{ ...record, stale: true }], 3)).toBe('resolved');
    // It occurred again in the newer page load: still reported, even after the line moved.
    const again = runtime('r1', 2, { line: 5 });
    expect(nextAiFixPhase(fix, false, [again], 3)).toBe('still-reported');
  });

  it('recognises the same problem by name or by code and message, not by line', () => {
    expect(sameAiProblem(runtime('a', 1), runtime('b', 2, { line: 9 }))).toBe(true);
    expect(sameAiProblem(runtime('a', 1), { ...runtime('b', 2), file: 'other.js' })).toBe(false);
    expect(sameAiProblem(typeError, { ...typeError, id: 'x', line: 2 })).toBe(true);
    expect(sameAiProblem(typeError, { ...typeError, id: 'x', originalMessage: 'Uncaught TypeError: x' })).toBe(false);
  });

  it('says the state in words in zh-CN and en', () => {
    const fix = { ...startAiFix(runtime('r1', 1), { saved: true, loadsAtRequest: 0 }), phase: 'resolved' as const };
    expect(aiFixStatusText(fix, (k) => translate('en', k), 'windows')).toBe(
      'Resolved: script.js line 3 — not reported again after checking again and refreshing the preview.',
    );
    expect(aiFixStatusText({ ...fix, phase: 'awaiting-refresh' }, (k) => translate('zh-CN', k), 'windows')).toContain(
      '等预览刷新',
    );
    expect(
      aiFixStatusText(
        { ...fix, phase: 'save-failed', saveError: 'permission-denied' },
        (k) => translate('en', k),
        'windows',
      ),
    ).toContain('saving failed');
  });
});

describe('"Fix with AI" on the problem card (S35.2)', () => {
  const card = (locale: 'zh-CN' | 'en', onFixWithAi?: () => void) =>
    renderToStaticMarkup(
      createElement(ProblemCardBody, {
        record: runtime('r1', 1),
        explanation: explain(runtime('r1', 1), {}),
        onGoTo: () => undefined,
        onFixWithAi,
        t: (key) => translate(locale, key),
        locale,
        originalOpen: false,
        onToggleOriginal: () => undefined,
      }),
    );
  it('is offered only while AI is available, beside the other actions', () => {
    expect(card('zh-CN')).not.toContain('problem-fix-ai');
    expect(card('zh-CN', () => undefined)).toMatch(/data-testid="problem-fix-ai"[^>]*>用 AI 修复</);
    expect(card('en', () => undefined)).toMatch(/data-testid="problem-fix-ai"[^>]*>Fix with AI</);
  });
});
