// Types for scripts/ci-timings-parse.mjs (used by tests/integration/ci-timings.test.ts).
export interface RunStep {
  name: string;
  status?: string;
  conclusion?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}
export interface RunJob {
  name: string;
  status?: string;
  conclusion?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  steps?: RunStep[];
}
export interface Run {
  databaseId?: number | string;
  displayTitle?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  status?: string;
  conclusion?: string | null;
  headBranch?: string;
  event?: string;
  jobs?: RunJob[];
}
export interface PlaywrightReport {
  config?: { shard?: { current: number; total: number } | null };
  stats?: {
    startTime?: string;
    duration?: number;
    expected?: number;
    skipped?: number;
    unexpected?: number;
    flaky?: number;
  };
  suites?: unknown[];
}
export interface SpecFileTime {
  file: string;
  ms: number;
  tests: number;
}
export interface JobSummary {
  name: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  queueSeconds: number | null;
  totalSeconds: number | null;
  steps: { name: string; seconds: number | null; conclusion?: string | null }[];
  categories: {
    setup: number | null;
    faults: number | null;
    verify: number | null;
    e2e: number | null;
    installers: number | null;
    playwright: number | null;
    package: number | null;
  };
  failingStep: string | null;
  firstError?: string | null;
  e2e: {
    seconds: number | null;
    expected: number | null;
    unexpected: number | null;
    skipped: number | null;
    slowest: SpecFileTime[];
  } | null;
}
export interface RunSummary {
  id: number | string | null;
  url: string | null;
  title: string;
  branch: string;
  event: string;
  status: string;
  conclusion: string;
  createdAt: string | null;
  wallClockSeconds: number | null;
  jobs: JobSummary[];
}
export interface AggregateStats {
  [measure: string]: { n: number; median: number; max: number };
}

export function secondsBetween(from: string | null | undefined, to: string | null | undefined): number | null;
export function formatDuration(seconds: number | null | undefined): string;
export function parseJobName(name: string): { target: string; shard: number; of: number } | null;
export function e2eReportArtifactName(jobName: string): string | null;
export function playwrightSeconds(results: PlaywrightReport | null | undefined): number | null;
export function slowestSpecFiles(results: PlaywrightReport | null | undefined, limit?: number): SpecFileTime[];
export const STEP_CATEGORIES: { key: string; label: string; match: RegExp }[];
export function summarizeJob(run: Run, job: RunJob, e2eReport?: PlaywrightReport): JobSummary;
export function firstErrorLines(logText: string | null | undefined): Record<string, string | null>;
export function excerptLog(logText: string | null | undefined, opts?: { context?: number; head?: number }): string;
export function summarizeRun(
  run: Run,
  reports?: Record<string, PlaywrightReport>,
  failedLog?: string | null,
): RunSummary;
export function formatRun(summary: RunSummary, opts?: { steps?: boolean }): string;
export function formatFailures(summaries: RunSummary[]): string;
export function aggregate(summaries: RunSummary[]): AggregateStats;
export function formatAggregate(stats: AggregateStats): string;
