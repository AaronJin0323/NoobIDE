#!/usr/bin/env node
// npm run test:e2e — builds the production bundles (electron-forge package → .vite/ and out/, plus the S28.4
// next-version build in out/upgrade-next), then runs the Playwright Electron suite in tests/e2e. Extra args go to
// Playwright, e.g. `npm run test:e2e -- -g "language"`.
//
// Windows / macOS: windows open briefly on the desktop; no interaction needed (CI runners have a desktop session).
// Linux without a display (containers, CI): wraps the run in xvfb-run when available.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendStepSummary } from './e2e-summary.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const npx = isWin ? 'npx.cmd' : 'npx';

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: isWin, env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!process.argv.includes('--no-build')) {
  // S28.4: "the next version" of the same code (patch + 1) in out/upgrade-next for tests/e2e/upgrade.spec.ts, built
  // first so the normal build below leaves .vite/ with package.json's own version.
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const [major, minor, patch] = version.split(/[.+-]/).map(Number);
  // The packaged upgrade test is macOS-only; Windows installation upgrades have a separate manual check.
  if (process.platform === 'darwin') {
    run(npx, ['electron-forge', 'package'], {
      NOOBIDE_BUILD_VERSION: `${major}.${minor}.${patch + 1}`,
      NOOBIDE_OUT_DIR: path.join(root, 'out', 'upgrade-next'),
    });
  }
  run(npx, ['electron-forge', 'package']);
}

const pw = [
  'playwright',
  'test',
  '-c',
  'tests/e2e/playwright.config.ts',
  ...process.argv.slice(2).filter((a) => a !== '--no-build'),
];
const needsXvfb = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
const status = needsXvfb ? spawnStatus('xvfb-run', ['-a', npx, ...pw]) : spawnStatus(npx, pw);
summarizeForGitHub();
process.exit(status);

function spawnStatus(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: isWin });
  return r.status ?? 1;
}

// S50.6: on GitHub Actions, append the 10 slowest spec files and the shard total to the job summary after every
// Playwright run, pass or fail (the data is the JSON report playwright.config.ts writes to reports/e2e/results.json).
function summarizeForGitHub() {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const shard = process.argv.find((a) => a.startsWith('--shard='))?.slice('--shard='.length) ?? null;
  appendStepSummary(path.join(root, 'reports', 'e2e', 'results.json'), process.env.GITHUB_STEP_SUMMARY, { shard });
}
