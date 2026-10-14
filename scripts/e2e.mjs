#!/usr/bin/env node
// npm run test:e2e — builds the production bundles (electron-forge package → .vite/ and out/), then runs the
// Playwright Electron suite in tests/e2e. Extra args go to Playwright, e.g. `npm run test:e2e -- -g "language"`.
//
// Windows / macOS: windows open briefly on the desktop; no interaction needed (CI runners have a desktop session).
// Linux without a display (containers, CI): wraps the run in xvfb-run when available.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const npx = isWin ? 'npx.cmd' : 'npx';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!process.argv.includes('--no-build')) run(npx, ['electron-forge', 'package']);

const pw = [
  'playwright',
  'test',
  '-c',
  'tests/e2e/playwright.config.ts',
  ...process.argv.slice(2).filter((a) => a !== '--no-build'),
];
const needsXvfb = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
if (needsXvfb) run('xvfb-run', ['-a', npx, ...pw]);
else run(npx, pw);
