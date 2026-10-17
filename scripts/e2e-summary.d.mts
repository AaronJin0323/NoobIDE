// Types for scripts/e2e-summary.mjs (used by tests/integration/ci-timings.test.ts).
import type { PlaywrightReport } from './ci-timings-parse.mjs';

export function formatStepSummary(results: PlaywrightReport, opts?: { shard?: string | null; limit?: number }): string;
export function appendStepSummary(
  resultsPath: string | null | undefined,
  summaryPath: string | null | undefined,
  opts?: { shard?: string | null },
): boolean;
