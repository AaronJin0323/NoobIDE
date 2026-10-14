import { defineConfig } from 'vitest/config';

// Unit tests live next to the code (src/**/*.test.ts).
// Integration tests live in tests/integration. E2E tests (Playwright + Electron) live in tests/e2e and are
// run separately via `npm run test:e2e` once S02.6 adds them.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: false,
  },
});
