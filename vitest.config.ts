import { defineConfig } from 'vitest/config';

// Unit tests live next to the code (src/**/*.test.ts).
// Integration tests live in tests/integration. E2E tests (Playwright + Electron) live in tests/e2e and are
// run separately via `npm run test:e2e` once S02.6 adds them. Performance budgets (tests/perf/**/*.perf.test.ts)
// are the `perf` project (vitest.perf.config.ts, `npm run test:perf`), never part of `npm test` (S58.3, ADR 0038).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.perf.test.ts', 'tests/perf/**'],
    // Bound contention so filesystem latency checks are not starved by unrelated test workers.
    maxWorkers: 4,
    environment: 'node',
    passWithNoTests: false,
  },
});
