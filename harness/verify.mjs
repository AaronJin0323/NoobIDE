#!/usr/bin/env node
// Runs every quality gate and prints one summary. Exit code 1 if any gate fails.
//
//   npm run verify            harness check, typecheck, lint, format check, unit/integration tests, perf budgets
//   npm run verify -- --e2e   …plus end-to-end tests (once S02.6 adds them)
//   npm run verify -- --quick harness check, typecheck and tests only (no lint, format or perf)
//
// The perf gate (S50.3, ADR 0038) runs the perf project with budgets enforced on this machine; on GitHub Actions the
// same project reports instead (tests/perf/budget.ts). ci.yml runs plain `npm test`, so hosted runs never assert them.
//
// A gate is skipped (not failed) only when its npm script does not exist yet; the summary says so.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts ?? {};
const isWin = process.platform === 'win32';

const gates = [
  { name: 'harness', cmd: [process.execPath, 'harness/session.mjs', 'check'] },
  { name: 'typecheck', script: 'typecheck' },
  { name: 'lint', script: 'lint', skip: args.has('--quick') },
  { name: 'format', script: 'format:check', skip: args.has('--quick') },
  { name: 'test', script: 'test' },
  { name: 'perf', script: 'test:perf', skip: args.has('--quick') },
  { name: 'e2e', script: 'test:e2e', skip: !args.has('--e2e') },
];

const results = [];
for (const g of gates) {
  if (g.skip) continue;
  if (g.script && !scripts[g.script]) {
    results.push({ name: g.name, status: 'missing', ms: 0 });
    continue;
  }
  const [bin, ...argv] = g.cmd ?? ['npm', 'run', '--silent', g.script];
  console.log(`\n▶ ${g.name}`);
  const t = Date.now();
  const r = spawnSync(bin, argv, { cwd: ROOT, stdio: 'inherit', shell: isWin && bin === 'npm' });
  results.push({ name: g.name, status: r.status === 0 ? 'pass' : 'FAIL', ms: Date.now() - t });
}

console.log('\n── verify summary ──');
for (const r of results) {
  const mark = r.status === 'pass' ? '✔' : r.status === 'missing' ? '–' : '✘';
  const note = r.status === 'missing' ? 'no npm script yet' : `${(r.ms / 1000).toFixed(1)}s`;
  console.log(`${mark} ${r.name.padEnd(10)} ${r.status.padEnd(8)} ${note}`);
}
const failed = results.filter((r) => r.status === 'FAIL');
if (failed.length) {
  console.log(
    `\nverify FAILED (${failed.map((r) => r.name).join(', ')}). Fix before starting new work or ending the session.`,
  );
  process.exit(1);
}
console.log('\nverify passed.');
