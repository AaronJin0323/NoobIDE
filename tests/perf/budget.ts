import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * S58.3 (ADR 0038): the one place a performance test reads its wall-clock budget through.
 *
 * Two modes, chosen from the environment:
 * - `enforce` (developer machines, `npm run verify`): the measured value must be within the budget, which was
 *   measured on the dev machine (docs/perf/*.md). A miss fails the test.
 * - `report` (GitHub Actions, `GITHUB_ACTIONS` set): the value is recorded, not asserted. A hosted runner is shared
 *   and several times slower than the dev machine, so a budget miss there says nothing about the change under test.
 *   The test fails only on an error (no finite number) or a value more than `REPORT_FAIL_FACTOR` × budget: a
 *   regression of that size is real on any machine.
 *
 * Every measurement, in both modes, is appended to `reports/perf/<platform>-<arch>.json` (gitignored); the perf
 * project's global setup turns that file into the job summary on GitHub Actions (tests/perf/global-setup.ts).
 * `NOOBIDE_PERF_MODE=enforce|report` overrides the detection and `NOOBIDE_PERF_REPORT_DIR` the report folder (tests).
 */
export type BudgetMode = 'enforce' | 'report';

export type BudgetStatus = 'ok' | 'over' | 'failed';

export interface BudgetResult {
  readonly name: string;
  readonly value: number;
  readonly budget: number;
  readonly unit: string;
  /** value / budget, rounded to two decimals; null when the value was not a finite number. */
  readonly ratio: number | null;
  readonly status: BudgetStatus;
  readonly mode: BudgetMode;
}

export interface BudgetReport {
  readonly platform: string;
  readonly arch: string;
  readonly node: string;
  readonly runner: 'github-actions' | 'local';
  readonly results: BudgetResult[];
}

/** In report mode a result this many times over budget still fails the test (a regression, not runner noise). */
export const REPORT_FAIL_FACTOR = 5;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function budgetMode(env: NodeJS.ProcessEnv = process.env): BudgetMode {
  if (env.NOOBIDE_PERF_MODE === 'enforce' || env.NOOBIDE_PERF_MODE === 'report') return env.NOOBIDE_PERF_MODE;
  return env.GITHUB_ACTIONS ? 'report' : 'enforce';
}

export function reportDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.NOOBIDE_PERF_REPORT_DIR ? path.resolve(env.NOOBIDE_PERF_REPORT_DIR) : path.join(ROOT, 'reports', 'perf');
}

/** `reports/perf/win32-x64.json`, `reports/perf/darwin-arm64.json` (the names docs/perf uses). */
export function reportFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(reportDir(env), `${process.platform}-${process.arch}.json`);
}

/** The verdict alone, so the policy can be unit-tested without the filesystem. */
export function judge(value: number, budget: number, mode: BudgetMode): { status: BudgetStatus; ratio: number | null } {
  if (!Number.isFinite(value) || !Number.isFinite(budget) || budget <= 0) return { status: 'failed', ratio: null };
  const ratio = Math.round((value / budget) * 100) / 100;
  if (value <= budget) return { status: 'ok', ratio };
  if (mode === 'enforce') return { status: 'failed', ratio };
  return { status: value > budget * REPORT_FAIL_FACTOR ? 'failed' : 'over', ratio };
}

export function readReport(file: string): BudgetReport | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as BudgetReport).results))
      return parsed as BudgetReport;
  } catch {
    // no report yet, or unreadable: start a new one
  }
  return null;
}

function record(result: BudgetResult, env: NodeJS.ProcessEnv): void {
  const file = reportFile(env);
  mkdirSync(path.dirname(file), { recursive: true });
  const report: BudgetReport = readReport(file) ?? {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    runner: env.GITHUB_ACTIONS ? 'github-actions' : 'local',
    results: [],
  };
  const results = report.results.filter((r) => r.name !== result.name);
  results.push(result);
  writeFileSync(file, `${JSON.stringify({ ...report, results }, null, 2)}\n`);
}

/**
 * Records `value` against `budget` and throws when the test must fail in the current mode. `name` identifies the
 * measurement in the report; keep it stable across sessions so the numbers can be compared.
 */
export function checkBudget(
  name: string,
  value: number,
  budget: number,
  options: { unit?: string; env?: NodeJS.ProcessEnv } = {},
): BudgetResult {
  const env = options.env ?? process.env;
  const mode = budgetMode(env);
  const unit = options.unit ?? 'ms';
  const { status, ratio } = judge(value, budget, mode);
  const result: BudgetResult = { name, value, budget, unit, ratio, status, mode };
  record(result, env);
  if (status === 'failed') {
    const shown = Number.isFinite(value) ? `${value.toFixed(2)} ${unit}` : String(value);
    const limit =
      mode === 'enforce'
        ? `the ${budget} ${unit} budget (enforced on developer machines)`
        : `${REPORT_FAIL_FACTOR}× the ${budget} ${unit} budget (the most a hosted runner is allowed; see docs/perf/ci-runners.md)`;
    throw new Error(`perf budget "${name}": measured ${shown}, over ${limit}`);
  }
  return result;
}

/** Markdown for the job summary: one table per report. */
export function summarise(report: BudgetReport): string {
  const rows = report.results.map((r) => {
    const value = Number.isFinite(r.value) ? `${r.value.toFixed(2)} ${r.unit}` : String(r.value);
    const ratio = r.ratio === null ? '–' : `${r.ratio.toFixed(2)}×`;
    const status = r.status === 'ok' ? 'within budget' : r.status === 'over' ? 'over budget (reported)' : 'FAILED';
    return `| ${r.name} | ${value} | ${r.budget} ${r.unit} | ${ratio} | ${status} |`;
  });
  return [
    `## Perf budgets — ${report.platform}-${report.arch} (${report.results[0]?.mode ?? 'enforce'} mode)`,
    '',
    '| Measurement | Measured | Budget | Ratio | Status |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

/** Appends the summary of this run's report to `$GITHUB_STEP_SUMMARY` when GitHub Actions provides one. */
export function publishSummary(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = reportFile(env);
  const report = readReport(file);
  if (!report || !env.GITHUB_STEP_SUMMARY) return false;
  appendFileSync(env.GITHUB_STEP_SUMMARY, summarise(report));
  return true;
}

/** Removes the previous run's report so a run's file holds only its own numbers. */
export function resetReport(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(reportFile(env), { force: true });
}
