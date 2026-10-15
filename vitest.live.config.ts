import { defineConfig } from 'vitest/config';

// S36.1 live smoke test against the real AI providers: `npm run test:ai-live`. Never part of `npm test`, `verify` or
// CI (vitest.config.ts does not include tests/live). Runs only the providers whose key is in the environment:
// NOOBIDE_AI_LIVE_ANTHROPIC_KEY and/or NOOBIDE_AI_LIVE_OPENAI_KEY; without either, every case is skipped.
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.test.ts'],
    environment: 'node',
    passWithNoTests: false,
    testTimeout: 240_000,
    hookTimeout: 60_000,
    // One provider at a time keeps the run cheap and the console output readable.
    fileParallelism: false,
  },
});
