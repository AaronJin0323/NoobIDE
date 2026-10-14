import { describe, expect, it } from 'vitest';
import { createProblemRecord, type ProblemRecord } from '../../shared/problem';
import { en } from '../messages/en';
import { zhCN } from '../messages/zh-CN';
import { formatMessage, msg } from '../messages';
import { FALLBACK_RULE_ID, explainProblem, renderExplanation, withExplanation } from './engine';
import { honestyViolations } from './honesty';
import type { Rule } from './types';

const record = createProblemRecord({
  source: 'runtime',
  severity: 'error',
  projectId: 'p',
  file: 'script.js',
  line: 3,
  column: 5,
  code: 'Error',
  message: 'Uncaught Error: boom',
  stack: 'Error: boom\n    at http://127.0.0.1:5000/script.js:3:5',
  at: 1,
});

const certainRule: Rule = {
  id: 'always',
  explain: () => ({
    certainty: 'certain',
    title: msg('fallback.title.runtime'),
    explanation: msg('fallback.explanation'),
  }),
};

describe('diagnostics message dictionaries', () => {
  it('en defines exactly the zh-CN keys, all non-empty, with the same placeholders', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, zh] of Object.entries(zhCN)) {
      const e = en[key as keyof typeof en];
      expect(zh.trim(), key).not.toBe('');
      expect(e.trim(), key).not.toBe('');
      expect(placeholders(e), key).toEqual(placeholders(zh));
    }
  });

  it('formats params as plain text and leaves unknown keys visible', () => {
    expect(formatMessage('zh-CN', msg('action.replaceWith', { name: 'userName' }))).toBe('改成 userName');
    expect(formatMessage('en', msg('location.fileLine', { file: '我的 主页/script.js', line: 12 }))).toBe(
      '我的 主页/script.js, line 12: ',
    );
    expect(formatMessage('en', { key: 'no.such.key' })).toBe('no.such.key');
  });
});

describe('rules engine (S22.1)', () => {
  it('falls back to an honest "cause not certain" explanation when no rule applies', () => {
    const exp = explainProblem(record);
    expect(exp.ruleId).toBe(FALLBACK_RULE_ID);
    expect(exp.certainty).toBe('unknown');
    expect(exp.actions.map((a) => a.kind)).toEqual(['go-to-code', 'show-original']);
    expect(honestyViolations(record, exp)).toEqual([]);
    const zh = renderExplanation('zh-CN', record, exp);
    expect(zh.location).toBe('script.js，第 3 行：');
    expect(zh.explanation).toContain('不能确定');
    expect(renderExplanation('en', record, exp).explanation).toContain('cannot tell');
  });

  it('first matching rule wins; non-matching and throwing rules are skipped', () => {
    const never: Rule = { id: 'never', explain: () => null };
    const broken: Rule = {
      id: 'broken',
      explain: () => {
        throw new Error('bug in rule');
      },
    };
    expect(explainProblem(record, {}, [never, broken, certainRule]).ruleId).toBe('always');
  });

  it('never alters the original evidence and always offers "Show original error"', () => {
    const before: ProblemRecord = structuredClone(record);
    const explained = withExplanation(record, {}, [certainRule]);
    const { explanation, ...rest } = explained;
    expect(rest).toEqual(before);
    expect(record).toEqual(before);
    expect(explanation?.actions.at(-1)?.kind).toBe('show-original');
    expect(renderExplanation('en', explained, explanation!).original).toBe('Uncaught Error: boom');
  });

  it('go-to-code is offered only with a known location; a rule fix comes first', () => {
    const noLoc = createProblemRecord({
      source: 'runtime',
      severity: 'error',
      projectId: 'p',
      code: 'x',
      message: 'Script error.',
      at: 1,
    });
    expect(explainProblem(noLoc).actions.map((a) => a.kind)).toEqual(['show-original']);
    const withFix: Rule = {
      id: 'fix',
      explain: () => ({
        certainty: 'likely',
        title: msg('fallback.title.runtime'),
        explanation: msg('fallback.explanation'),
        checks: [msg('fallback.check.readOriginal')],
        actions: [
          { kind: 'show-original', label: msg('action.showOriginal') },
          {
            kind: 'replace-text',
            label: msg('action.replaceWith', { name: 'b' }),
            span: { file: 'script.js', line: 3, column: 5, endColumn: 6 },
            from: 'a',
            to: 'b',
          },
        ],
      }),
    };
    expect(explainProblem(record, {}, [withFix]).actions.map((a) => a.kind)).toEqual([
      'replace-text',
      'go-to-code',
      'show-original',
    ]);
  });

  it('honesty check flags uncertain explanations worded as fact', () => {
    const overconfident: Rule = {
      id: 'bad',
      explain: () => ({
        certainty: 'possible',
        title: msg('fallback.title.runtime'),
        explanation: msg('action.goToCode'),
      }),
    };
    const v = honestyViolations(record, explainProblem(record, {}, [overconfident]));
    expect(v.some((s) => s.includes('not worded as a possibility'))).toBe(true);
    expect(v.some((s) => s.includes('without causes or checks'))).toBe(true);
  });
});
