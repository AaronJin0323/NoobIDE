import { describe, expect, it } from 'vitest';
import { createProblemRecord } from '../../shared/problem';
import { RULE_FIXTURES } from './fixtures';
import { honestyViolations } from './honesty';
import { DEFAULT_RULES, explain, explainRecord } from './index';
import { renderExplanation } from './engine';

describe('every rule fixture (S22.2/S22.3)', () => {
  it.each(RULE_FIXTURES.map((f) => [f.name, f] as const))('%s → expected rule, honest in zh-CN and en', (_n, f) => {
    const exp = explain(f.record, f.ctx);
    expect(exp.ruleId).toBe(f.rule);
    expect(honestyViolations(f.record, exp)).toEqual([]);
  });

  it('every built-in rule has at least one fixture', () => {
    const covered = new Set(RULE_FIXTURES.map((f) => f.rule));
    for (const r of DEFAULT_RULES) expect(covered.has(r.id), r.id).toBe(true);
  });

  it('rule ids are unique', () => {
    const ids = DEFAULT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('explaining keeps the original message and stack verbatim', () => {
    for (const f of RULE_FIXTURES) {
      const explained = explainRecord(f.record, f.ctx);
      expect(explained.originalMessage).toBe(f.record.originalMessage);
      expect(explained.originalStack).toBe(f.record.originalStack);
      expect(renderExplanation('zh-CN', explained, explained.explanation!).original).toBe(f.record.originalMessage);
    }
  });

  it('unrelated problems fall back honestly instead of being forced into a rule', () => {
    const odd = createProblemRecord({
      source: 'runtime',
      severity: 'error',
      projectId: 'p',
      file: 'a.js',
      line: 1,
      code: 'RangeError',
      message: 'Uncaught RangeError: Maximum call stack size exceeded',
      at: 1,
    });
    const exp = explain(odd);
    expect(exp.ruleId).toBe('fallback');
    expect(honestyViolations(odd, exp)).toEqual([]);
  });
});
