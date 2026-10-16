import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createProblemRecord } from '../../shared/problem';
import { explain, type RuleContext } from '../../diagnostics/rules';
import { translate } from '../i18n/index';
import type { AiFixPhase, AiFixState } from './ai-fix';
import { AiFixCardBody, aiFixCardProminent } from './AiFixCard';
import { FixCardBody, fixCardProminent } from './FixCard';
import { startFix, type FixPhase, type FixState, type ReplaceTextAction } from './fix-model';
import { ProblemCardBody } from './ProblemCard';

/**
 * S45.3 (HIG Buttons): problem cards, fix cards and the AI fix card use the shared button hierarchy — at most one
 * prominent (accent, `.primary-button`) action, every other action bordered (`.secondary-button`) or plain
 * (`.quiet-button`), all small (`.control-sm`).
 */

const record = createProblemRecord(
  {
    source: 'runtime',
    severity: 'error',
    projectId: 'p',
    preview: { sessionId: 's', generation: 1 },
    file: 'script.js',
    line: 12,
    column: 18,
    code: 'ReferenceError',
    message: 'Uncaught ReferenceError: userNmae is not defined',
    at: 1,
  },
  'r',
);
const t = (key: Parameters<typeof translate>[1]) => translate('zh-CN', key);

/** The data-testid of each button, by its style. */
function buttons(html: string): { prominent: string[]; other: string[]; unstyled: string[] } {
  const result = { prominent: [] as string[], other: [] as string[], unstyled: [] as string[] };
  for (const [tag] of html.matchAll(/<button[^>]*>/g)) {
    const cls = /class="([^"]*)"/.exec(tag)?.[1] ?? '';
    const id = /data-testid="([^"]*)"/.exec(tag)?.[1] ?? '?';
    expect(cls, id).toContain('control-sm');
    if (cls.includes('primary-button')) result.prominent.push(id);
    else if (cls.includes('secondary-button') || cls.includes('quiet-button')) result.other.push(id);
    else result.unstyled.push(id);
  }
  return result;
}

describe('problem card actions', () => {
  const card = (ctx: RuleContext, withFix = true) =>
    renderToStaticMarkup(
      createElement(ProblemCardBody, {
        record,
        explanation: explain(record, ctx),
        onGoTo: () => undefined,
        onFix: withFix ? () => undefined : undefined,
        onFixWithAi: () => undefined,
        onAskAi: () => undefined,
        t,
        locale: 'zh-CN',
        originalOpen: false,
        onToggleOriginal: () => undefined,
      }),
    );
  const line = "  alert('你好，' + userNmae);";

  it('the one-click fix is the one prominent action; Go to code and Fix with AI are bordered, the rest plain', () => {
    const b = buttons(card({ lineText: line, declaredNames: [{ name: 'userName' }] }));
    expect(b.prominent).toEqual(['problem-fix']);
    expect(b.other).toEqual(['problem-go-to', 'problem-fix-ai', 'problem-show-original', 'problem-ask-ai']);
    expect(b.unstyled).toEqual([]);
  });

  it('without a fix, Go to code is the one prominent action', () => {
    for (const html of [card({ lineText: line, declaredNames: [] }), card({}, false)]) {
      const b = buttons(html);
      expect(b.prominent).toEqual(['problem-go-to']);
      expect(b.unstyled).toEqual([]);
    }
  });
});

describe('fix card actions', () => {
  const action: ReplaceTextAction = {
    kind: 'replace-text',
    label: { key: 'action.replaceWith', params: { name: 'userName' } },
    span: { file: 'script.js', line: 12, column: 18, endColumn: 26 },
    from: 'userNmae',
    to: 'userName',
  };
  const PHASES: FixPhase[] = [
    'applying',
    'not-applied',
    'save-failed',
    'checking',
    'unchecked',
    'awaiting-refresh',
    'still-reported',
    'resolved',
    'undoing',
    'undone',
    'undo-failed',
  ];
  const state = (phase: FixPhase): FixState => ({ ...startFix(record, action), phase, version: 3 });
  const render = (fix: FixState) =>
    renderToStaticMarkup(
      createElement(FixCardBody, {
        fix,
        t,
        locale: 'zh-CN',
        platform: 'windows',
        actions: {
          undo: () => undefined,
          retrySave: () => undefined,
          recheck: () => undefined,
          clear: () => undefined,
        },
        onGoTo: () => undefined,
        originalOpen: false,
        onToggleOriginal: () => undefined,
      }),
    );
  const ID = { retry: 'problem-fix-retry', recheck: 'problem-fix-recheck', 'go-to': 'problem-fix-go-to' } as const;

  it('every phase has exactly one prominent action: Save again, else Check again, else Go to code', () => {
    for (const phase of PHASES) {
      const fix = state(phase);
      const b = buttons(render(fix));
      expect(b.prominent, phase).toEqual([ID[fixCardProminent(fix)]]);
      expect(b.unstyled, phase).toEqual([]);
    }
    expect(fixCardProminent(state('save-failed'))).toBe('retry');
    expect(fixCardProminent(state('still-reported'))).toBe('recheck');
    expect(fixCardProminent(state('resolved'))).toBe('go-to');
  });
});

describe('AI fix card actions', () => {
  const PHASES: AiFixPhase[] = [
    'save-failed',
    'checking',
    'unchecked',
    'awaiting-refresh',
    'still-reported',
    'resolved',
  ];
  const render = (fix: AiFixState) =>
    renderToStaticMarkup(
      createElement(AiFixCardBody, {
        fix,
        t,
        locale: 'zh-CN',
        platform: 'windows',
        actions: { recheck: () => undefined, clear: () => undefined },
        onGoTo: () => undefined,
        originalOpen: false,
        onToggleOriginal: () => undefined,
      }),
    );

  it('at most one prominent action: Check again while unsure, else Go to code', () => {
    for (const phase of PHASES) {
      const fix: AiFixState = { record, phase };
      const b = buttons(render(fix));
      expect(b.prominent, phase).toEqual([aiFixCardProminent(fix) === 'recheck' ? 'ai-fix-recheck' : 'ai-fix-go-to']);
      expect(b.unstyled, phase).toEqual([]);
    }
    const { file: _file, ...noFile } = record;
    const fileless: AiFixState = { record: noFile, phase: 'resolved' };
    expect(aiFixCardProminent(fileless)).toBeNull();
    expect(buttons(render(fileless)).prominent).toEqual([]);
  });
});
