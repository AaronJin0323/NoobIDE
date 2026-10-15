import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { runSelfTest } from './packaged';

// The `electron` package's main export is the path to the Electron binary.
const electronBinary = createRequire(import.meta.url)('electron') as string;

test('Monaco CSS and TypeScript workers answer in the production build (S02.4)', async () => {
  // On its own temporary app data, like every e2e launch (tests/e2e/packaged.ts).
  const { code, result } = await runSelfTest(electronBinary, {}, { appArgs: ['.'] });
  expect(result, 'self-test line on stdout').toBeDefined();
  const probe = result as {
    pass: boolean;
    css: number;
    js: number;
    workers: string[];
  };
  expect(probe.pass).toBe(true);
  expect(probe.css).toBeGreaterThan(0);
  expect(probe.js).toBeGreaterThan(0);
  expect(probe.workers).toEqual(expect.arrayContaining(['css', 'ts']));
  expect(code).toBe(0);
});
