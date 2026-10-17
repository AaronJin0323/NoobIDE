import { defineConfig } from '@playwright/test';

// Electron end-to-end tests (S02.6). Run through `npm run test:e2e`, which builds the production bundles first.
// No browsers are downloaded: Playwright drives the Electron binary from node_modules.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '../../reports/e2e/results.json' }]],
  // S50.2: a failed test leaves its trace and screenshot in outputDir, which CI uploads on failure
  // (e2e-results-<target>-<shard>). retries stay 0: a flaky test is a bug (docs/testing.md).
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: '../../test-results/e2e',
});
