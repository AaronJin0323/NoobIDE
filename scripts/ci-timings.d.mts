// Types for scripts/ci-timings.mjs (used by tests/integration/ci-timings.test.ts).
import type { PlaywrightReport, Run, RunSummary } from './ci-timings-parse.mjs';

export interface Options {
  runs: number;
  failures: boolean;
  json: boolean;
  artifacts: boolean;
  steps: boolean;
  repo: string | null;
  workflow: string;
  runIds: string[];
  save: string | null;
  help?: boolean;
}
export interface Source {
  listRuns(n: number): Run[];
  viewRun(id: number | string): Run;
  e2eReports(id: number | string, run?: Run): Record<string, PlaywrightReport>;
  logFailed(id: number | string): string | null;
}
export function parseArgs(argv: string[]): Options;
export function ghSource(opts?: { repo?: string | null; workflow?: string; artifacts?: boolean }): Source;
export function fixtureSource(dir: string): Source;
export function collect(
  source: Source,
  opts: Options,
  hooks?: {
    onFetched?: (fetched: { run: Run; reports: Record<string, PlaywrightReport>; log: string | null }) => void;
  },
): RunSummary[];
export function trimPlaywrightReport(results: PlaywrightReport): PlaywrightReport;
export function trimRun(run: Run): Run;
export function report(summaries: RunSummary[], opts: Options): string;
