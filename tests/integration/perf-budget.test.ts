import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REPORT_FAIL_FACTOR,
  budgetMode,
  checkBudget,
  judge,
  publishSummary,
  readReport,
  reportFile,
  resetReport,
  summarise,
} from '../perf/budget';

/**
 * S58.3 (ADR 0038): the budget helper every perf test reads its budget through. Enforced on developer machines,
 * reported on GitHub Actions (fails only on an error or a result more than 5× over budget), always recorded to
 * reports/perf/<platform>-<arch>.json. The report folder is redirected to a temp dir here.
 */
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noobide-perf 报告-'));
  env = { NOOBIDE_PERF_REPORT_DIR: dir };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('budget mode', () => {
  it('enforces on developer machines and reports on GitHub Actions; NOOBIDE_PERF_MODE overrides', () => {
    expect(budgetMode({})).toBe('enforce');
    expect(budgetMode({ GITHUB_ACTIONS: 'true' })).toBe('report');
    expect(budgetMode({ GITHUB_ACTIONS: 'true', NOOBIDE_PERF_MODE: 'enforce' })).toBe('enforce');
    expect(budgetMode({ NOOBIDE_PERF_MODE: 'report' })).toBe('report');
    expect(budgetMode({ NOOBIDE_PERF_MODE: 'nonsense' })).toBe('enforce');
  });

  it('judges: within budget is ok everywhere; over budget fails when enforced, is reported up to 5× on CI', () => {
    expect(judge(9, 10, 'enforce')).toEqual({ status: 'ok', ratio: 0.9 });
    expect(judge(10, 10, 'report')).toEqual({ status: 'ok', ratio: 1 });
    expect(judge(10.5, 10, 'enforce')).toEqual({ status: 'failed', ratio: 1.05 });
    expect(judge(10.5, 10, 'report')).toEqual({ status: 'over', ratio: 1.05 });
    expect(judge(50, 10, 'report')).toEqual({ status: 'over', ratio: 5 });
    expect(judge(50.1, 10, 'report')).toEqual({ status: 'failed', ratio: 5.01 });
    expect(REPORT_FAIL_FACTOR).toBe(5);
  });

  it('an error (no finite number, no positive budget) fails in both modes', () => {
    for (const mode of ['enforce', 'report'] as const) {
      expect(judge(Number.NaN, 10, mode)).toEqual({ status: 'failed', ratio: null });
      expect(judge(Infinity, 10, mode)).toEqual({ status: 'failed', ratio: null });
      expect(judge(1, 0, mode)).toEqual({ status: 'failed', ratio: null });
    }
  });
});

describe('checkBudget', () => {
  it('throws on a miss when enforced, naming the measurement and the budget', () => {
    expect(() => checkBudget('p95 latency', 21.4, 10, { env })).toThrow(
      /perf budget "p95 latency": measured 21\.40 ms, over the 10 ms budget \(enforced on developer machines\)/,
    );
    expect(() => checkBudget('p95 latency', 9.9, 10, { env })).not.toThrow();
  });

  it('on GitHub Actions a miss is recorded, not thrown, until it is more than 5× over budget', () => {
    const ci = { ...env, GITHUB_ACTIONS: 'true' };
    expect(checkBudget('p95 latency', 21.4, 10, { env: ci })).toMatchObject({ status: 'over', ratio: 2.14 });
    expect(() => checkBudget('max lag', 2600, 500, { env: ci })).toThrow(/over 5× the 500 ms budget/);
    expect(() => checkBudget('broken', Number.NaN, 500, { env: ci })).toThrow(/measured NaN/);
    const report = readReport(reportFile(ci));
    expect(report).toMatchObject({
      platform: process.platform,
      arch: process.arch,
      runner: 'github-actions',
    });
    expect(report?.results.map((r) => [r.name, r.status])).toEqual([
      ['p95 latency', 'over'],
      ['max lag', 'failed'],
      ['broken', 'failed'],
    ]);
  });

  it('records every measurement (also within budget) to reports/perf/<platform>-<arch>.json, one row per name', () => {
    checkBudget('a', 1, 10, { env });
    checkBudget('b', 2, 10, { env, unit: 'MB' });
    checkBudget('a', 3, 10, { env }); // a rerun replaces the row
    expect(path.basename(reportFile(env))).toBe(`${process.platform}-${process.arch}.json`);
    const report = readReport(reportFile(env));
    expect(report?.runner).toBe('local');
    expect(report?.results).toEqual([
      { name: 'b', value: 2, budget: 10, unit: 'MB', ratio: 0.2, status: 'ok', mode: 'enforce' },
      { name: 'a', value: 3, budget: 10, unit: 'ms', ratio: 0.3, status: 'ok', mode: 'enforce' },
    ]);
    resetReport(env);
    expect(readReport(reportFile(env))).toBeNull();
  });

  it('publishes a markdown table to $GITHUB_STEP_SUMMARY when GitHub provides one, otherwise nothing', async () => {
    const ci = { ...env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md') };
    checkBudget('p95 latency', 21.4, 10, { env: ci });
    checkBudget('max lag', 120, 500, { env: ci });
    expect(publishSummary(env)).toBe(false); // no summary file requested
    expect(publishSummary(ci)).toBe(true);
    const summary = await readFile(ci.GITHUB_STEP_SUMMARY!, 'utf8');
    expect(summary).toContain(`## Perf budgets — ${process.platform}-${process.arch} (report mode)`);
    expect(summary).toContain('| p95 latency | 21.40 ms | 10 ms | 2.14× | over budget (reported) |');
    expect(summary).toContain('| max lag | 120.00 ms | 500 ms | 0.24× | within budget |');
    expect(summarise(readReport(reportFile(ci))!)).toBe(summary);
  });
});
