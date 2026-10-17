import { defineConfig } from 'vitest/config';

// S50.3 (ADR 0038): the `perf` project — wall-clock budgets (p95 latency, max lag, throughput) measured on the dev
// machine (docs/perf/*.md). `npm run test:perf` runs it; `npm run verify` runs it after the unit tests and enforces
// the budgets on developer machines. On GitHub Actions (.github/workflows/perf.yml, not a required check) the same
// tests report their numbers to reports/perf/<platform>-<arch>.json and the job summary and fail only on an error or
// a result more than 5× over budget. tests/perf/budget.ts holds the policy. Never part of `npm test` or ci.yml.
export default defineConfig({
  test: {
    include: ['tests/perf/**/*.perf.test.ts'],
    environment: 'node',
    passWithNoTests: false,
    // One file at a time, one worker: a measurement must not share the CPU with other test files.
    fileParallelism: false,
    maxWorkers: 1,
    globalSetup: ['tests/perf/global-setup.ts'],
    testTimeout: 60_000,
  },
});
