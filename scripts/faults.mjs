#!/usr/bin/env node
// S26.2 — runs the fault-injection suite (S26.1) on its own and leaves a per-platform report, so CI can prove the
// suite ran on both the Windows x64 and the macOS arm64 job (docs/release/fault-matrix.md "Running on CI").
//
//   npm run test:faults
//
// Writes reports/faults/<platform>-<arch>/{junit.xml,results.json,summary.md} and, on GitHub Actions, appends the
// summary to the job summary. Fails when a test fails, when no test ran, or when a test is skipped on this platform
// without an entry in SKIP_POLICY below — a fault test must never be silently skipped on one OS.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The files that make up the fault suite (fault-matrix.md). */
export const FAULT_SUITE = ['tests/integration/faults', 'tests/integration/protected-folder.test.ts'];

/**
 * Every skip the suite is allowed to have, with the platforms it may happen on and why. `match` is tested against the
 * test's full name (describe titles + test title). A skip on any other platform, or one not listed, fails the run.
 */
export const SKIP_POLICY = [
  {
    match: /read-only folder on the real file system \(POSIX\)/,
    platforms: ['win32'],
    reason:
      'chmod 0o555 does not make a folder read-only on Windows (NTFS uses ACLs). Covered on Windows by the ' +
      'injected EACCES/EROFS save faults, which run on every OS, and by MANUAL-CHECKS.md S26.1 step 3 (icacls deny).',
  },
  {
    match: /^macOS privacy protection \(TCC\), simulated /,
    platforms: ['win32'],
    reason:
      'The simulation needs POSIX path strings for the macOS adapter to match ~/Documents. The adapter logic itself ' +
      'is tested with POSIX strings on every OS in src/platform/protected-folders.test.ts.',
  },
];

/** Root may write into a 0o555 folder, so the POSIX read-only test skips itself when the runner is root. */
const ROOT_SKIPS = [/read-only (file|folder) on the real file system/];

/**
 * Classifies a vitest JSON report for one platform.
 * @param {{testResults: {name: string, assertionResults: {fullName: string, status: string}[]}[]}} report
 * @param {{platform: string, isRoot?: boolean}} host
 */
export function evaluate(report, host) {
  const tests = report.testResults.flatMap((file) =>
    file.assertionResults.map((a) => ({
      file: path.relative(ROOT, file.name).split(path.sep).join('/'),
      name: a.fullName,
      status: a.status,
    })),
  );
  const passed = tests.filter((t) => t.status === 'passed');
  const failed = tests.filter((t) => t.status === 'failed');
  const skipped = tests
    .filter((t) => t.status !== 'passed' && t.status !== 'failed')
    .map((t) => {
      const rule = SKIP_POLICY.find((r) => r.match.test(t.name) && r.platforms.includes(host.platform));
      if (rule) return { ...t, reason: rule.reason };
      if (host.isRoot && ROOT_SKIPS.some((r) => r.test(t.name))) return { ...t, reason: 'runner is root' };
      return { ...t, reason: null };
    });
  const unexpected = skipped.filter((t) => t.reason === null);
  const fileFailures = report.testResults.filter((f) => f.status === 'failed' && f.assertionResults.length === 0);
  const problems = [
    ...failed.map((t) => `failed: ${t.name} (${t.file})`),
    ...unexpected.map((t) => `skipped without a SKIP_POLICY entry for ${host.platform}: ${t.name} (${t.file})`),
    ...fileFailures.map((f) => `test file failed to load: ${f.name}`),
  ];
  if (tests.length === 0) problems.push('no fault test ran');
  return { tests, passed, failed, skipped, problems, ok: problems.length === 0 };
}

/** Markdown summary of one platform's run. */
export function summarize(result, target) {
  const files = [...new Set(result.tests.map((t) => t.file))].sort();
  const lines = [
    `## Fault suite (S26.2) — ${target}`,
    '',
    `${result.ok ? 'PASS' : 'FAIL'}: ${result.passed.length} passed, ${result.failed.length} failed, ` +
      `${result.skipped.length} skipped, ${result.tests.length} total.`,
    '',
    '| File | Passed | Failed | Skipped |',
    '| --- | --- | --- | --- |',
    ...files.map((f) => {
      const of = (list) => list.filter((t) => t.file === f).length;
      return `| ${f} | ${of(result.passed)} | ${of(result.failed)} | ${of(result.skipped)} |`;
    }),
  ];
  if (result.skipped.length) {
    lines.push('', '### Skipped on this platform', '');
    for (const t of result.skipped) lines.push(`- ${t.name} — ${t.reason ?? '**not allowed (no SKIP_POLICY entry)**'}`);
  }
  if (result.problems.length) {
    lines.push('', '### Problems', '');
    for (const p of result.problems) lines.push(`- ${p}`);
  }
  return lines.join('\n') + '\n';
}

function main() {
  const target = `${process.platform}-${process.arch}`;
  const outDir = path.join(ROOT, 'reports', 'faults', target);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const json = path.join(outDir, 'results.json');
  const vitest = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const run = spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      ...FAULT_SUITE,
      '--reporter=default',
      '--reporter=junit',
      '--reporter=json',
      `--outputFile.junit=${path.join(outDir, 'junit.xml')}`,
      `--outputFile.json=${json}`,
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (!existsSync(json)) {
    console.error(`fault suite produced no report (vitest exit ${run.status})`);
    process.exit(1);
  }
  const result = evaluate(JSON.parse(readFileSync(json, 'utf8')), {
    platform: process.platform,
    isRoot: process.getuid?.() === 0,
  });
  const summary = summarize(result, target);
  writeFileSync(path.join(outDir, 'summary.md'), summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log('\n' + summary);
  process.exit(result.ok && run.status === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
