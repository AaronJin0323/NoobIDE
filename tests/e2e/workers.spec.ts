import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { electronArgs, repoRoot } from './launch';

// The `electron` package's main export is the path to the Electron binary.
const electronBinary = createRequire(import.meta.url)('electron') as string;

test('Monaco CSS and TypeScript workers answer in the production build (S02.4)', async () => {
  const result = await new Promise<{ code: number | null; line: string | undefined }>((resolve, reject) => {
    const child = spawn(electronBinary, electronArgs(), {
      cwd: repoRoot,
      env: { ...process.env, NOOBIDE_SELF_TEST: '1' },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, line: out.split('\n').find((l) => l.startsWith('NOOBIDE_SELFTEST ')) }));
  });
  expect(result.line, 'self-test line on stdout').toBeDefined();
  const probe = JSON.parse(result.line!.slice('NOOBIDE_SELFTEST '.length)) as {
    pass: boolean;
    css: number;
    js: number;
    workers: string[];
  };
  expect(probe.pass).toBe(true);
  expect(probe.css).toBeGreaterThan(0);
  expect(probe.js).toBeGreaterThan(0);
  expect(probe.workers).toEqual(expect.arrayContaining(['css', 'ts']));
  expect(result.code).toBe(0);
});
