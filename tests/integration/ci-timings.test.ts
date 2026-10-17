// S50.6 — scripts/ci-timings.mjs on saved fixtures (no network, no gh). The fixtures under tests/fixtures/ci were
// written by `node scripts/ci-timings.mjs --run 39015143213 --run 39011559538 --save tests/fixtures/ci` and
// trimmed to what the parser reads: the run's jobs and steps as `gh run view --json` returns them, each shard's
// e2e-report artifact (results.json) and an excerpt of `gh run view --log-failed`. The expected numbers are the
// §2 table of docs/ci/ci-stability-and-speed-plan.md, measured by hand from the same run.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  excerptLog,
  firstErrorLines,
  formatDuration,
  formatFailures,
  formatRun,
  parseJobName,
  slowestSpecFiles,
  summarizeRun,
} from '../../scripts/ci-timings-parse.mjs';
import { collect, fixtureSource, parseArgs, report, trimPlaywrightReport, trimRun } from '../../scripts/ci-timings.mjs';
import { appendStepSummary, formatStepSummary } from '../../scripts/e2e-summary.mjs';

const FIXTURES = path.resolve(__dirname, '../fixtures/ci');
const GREEN = '39015143213';
const RED = '39011559538';
const source = fixtureSource(FIXTURES);

/** `mm:ss` → seconds, so the assertions read like the plan's table. */
const t = (text: string) => text.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
const near = (actual: number | null, expected: string, tolerance = 5) => {
  expect(actual, `expected about ${expected}`).not.toBeNull();
  expect(Math.abs((actual as number) - t(expected)), `${formatDuration(actual)} vs ${expected}`).toBeLessThanOrEqual(
    tolerance,
  );
};

describe('formatDuration / parseJobName', () => {
  it('prints m:ss and h:mm:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(153)).toBe('2:33');
    expect(formatDuration(561)).toBe('9:21');
    expect(formatDuration(3684)).toBe('1:01:24');
    expect(formatDuration(null)).toBe('–');
  });
  it('reads the matrix job name and maps it to the e2e-report artifact', () => {
    expect(parseJobName('macos-arm64 (shard 2/2)')).toEqual({ target: 'macos-arm64', shard: 2, of: 2 });
    expect(parseJobName('windows-x64')).toBeNull();
  });
});

describe('run 39015143213 (green, plan §2 table)', () => {
  const summary = summarizeRun(source.viewRun(GREEN), source.e2eReports(GREEN), null);
  const job = (name: string) => {
    const found = summary.jobs.find((j) => j.name === name);
    if (!found) throw new Error(`job ${name} missing`);
    return found;
  };
  const win1 = job('windows-x64 (shard 1/2)');
  const win2 = job('windows-x64 (shard 2/2)');
  const mac1 = job('macos-arm64 (shard 1/2)');
  const mac2 = job('macos-arm64 (shard 2/2)');

  it('wall-clock 20:27 and the four shard jobs plus two gate jobs', () => {
    expect(summary.conclusion).toBe('success');
    near(summary.wallClockSeconds, '20:27', 1);
    expect(summary.jobs.map((j) => j.name)).toEqual([
      'macos-arm64 (shard 1/2)',
      'macos-arm64 (shard 2/2)',
      'windows-x64 (shard 1/2)',
      'windows-x64 (shard 2/2)',
      'windows-x64',
      'macos-arm64',
    ]);
  });

  it('queue delay: 0:02 on Windows, 2:33 and 9:21 on the macOS shards', () => {
    near(win1.queueSeconds, '0:02', 1);
    near(win2.queueSeconds, '0:02', 1);
    near(mac1.queueSeconds, '2:33', 1);
    near(mac2.queueSeconds, '9:21', 1);
  });

  it('setup, fault suite and verify per shard', () => {
    near(win1.categories.setup, '0:39');
    near(win2.categories.setup, '0:35');
    near(mac1.categories.setup, '0:24');
    near(mac2.categories.setup, '0:20');
    near(win1.categories.faults, '0:05');
    near(mac2.categories.faults, '0:03');
    near(win1.categories.verify, '1:42');
    near(win2.categories.verify, '1:20');
    near(mac1.categories.verify, '1:03');
    near(mac2.categories.verify, '1:08');
  });

  it('Playwright time from the e2e-report artifacts: 7:03 / 7:10 / 7:07 / 9:01', () => {
    near(win1.categories.playwright, '7:03');
    near(win2.categories.playwright, '7:10');
    near(mac1.categories.playwright, '7:07');
    near(mac2.categories.playwright, '9:01');
    // packaging = the E2E step minus the Playwright run
    near(win1.categories.package, '0:17');
    near(mac1.categories.package, '0:21');
    expect(win1.e2e?.expected).toBe(166);
    expect(mac2.e2e?.slowest[0]?.file).toBe('preview-isolation.spec.ts');
    expect(win1.e2e?.slowest[0]?.file).toBe('app-startup-restore.spec.ts');
  });

  it('installers 1:33 on Windows shard 1 and 0:26 on macOS shard 1, none on shard 2', () => {
    near(win1.categories.installers, '1:33');
    near(mac1.categories.installers, '0:26');
    expect(win2.categories.installers).toBeNull();
    expect(mac2.categories.installers).toBeNull();
  });

  it('job totals 11:24 / 9:29 / 9:31 / 10:59 and every step listed with its duration', () => {
    near(win1.totalSeconds, '11:24', 1);
    near(win2.totalSeconds, '9:29', 1);
    near(mac1.totalSeconds, '9:31', 1);
    near(mac2.totalSeconds, '10:59', 1);
    const names = win1.steps.map((s) => s.name);
    expect(names).toContain('Install dependencies');
    expect(names).toContain('End-to-end tests (Playwright + Electron)');
    expect(names).toContain('Make installers');
    expect(names).not.toContain('Upload e2e results on failure'); // skipped steps are not listed
    expect(win1.steps.find((s) => s.name === 'Make installers')?.seconds).toBe(77);
    expect(win1.failingStep).toBeNull();
  });

  it('formats the table with the plan rows', () => {
    const text = formatRun(summary);
    expect(text).toContain(
      'Run 39015143213  success  pull_request  claude/s48-chat-core-9b1e35  2026-10-17 07:50:36Z  wall-clock 20:27',
    );
    expect(text).toMatch(
      /Job\s+Queue\s+Setup\s+Faults\s+Verify\s+Package\s+Playwright\s+E2E step\s+Installers\s+Total/,
    );
    expect(text).toMatch(/macos-arm64 \(shard 2\/2\)\s+9:21\s+/);
    expect(text).toMatch(
      /windows-x64 \(shard 1\/2\)\s+0:02\s+0:3\d\s+0:05\s+1:42\s+0:1\d\s+7:0\d\s+7:2\d\s+1:33\s+11:24/,
    );
    expect(text).toContain('windows-x64 (shard 1/2) steps: Set up job 0:01 · Checkout 0:08');
    expect(text).not.toContain('✘');
    expect(formatRun(summary, { steps: false })).not.toContain(' steps: ');
  });
});

describe('run 39011559538 (failed: latency budget on macOS, walkthrough race on Windows)', () => {
  const log = source.logFailed(RED) ?? '';
  const summary = summarizeRun(source.viewRun(RED), source.e2eReports(RED), log);

  it('names the failing step and the first error line per job', () => {
    const mac1 = summary.jobs.find((j) => j.name === 'macos-arm64 (shard 1/2)');
    expect(mac1?.failingStep).toBe('Verify (harness, typecheck, lint, format, unit and integration tests)');
    expect(mac1?.firstError).toContain('FAIL  src/renderer/editor/completion-latency.test.ts');
    expect(mac1?.firstError).toContain('AssertionError: expected 21.368790999999987 to be less than or equal to 10');
    const win2 = summary.jobs.find((j) => j.name === 'windows-x64 (shard 2/2)');
    expect(win2?.failingStep).toBe('End-to-end tests (Playwright + Electron)');
    expect(win2?.firstError).toBe('Error: expect(locator).toHaveAttribute(expected) failed');
    expect(win2?.e2e?.unexpected).toBe(1);
    const gate = summary.jobs.find((j) => j.name === 'windows-x64');
    expect(gate?.failingStep).toBe('Require every platform and shard');
    expect(gate?.firstError).toBe('Process completed with exit code 1.');
    expect(summary.jobs.find((j) => j.name === 'windows-x64 (shard 1/2)')?.failingStep).toBeNull();
  });

  it('strips gh colour codes (literal ^[ sequences) and ignores the generic exit-code annotation', () => {
    const errors = firstErrorLines(log);
    expect(errors['macos-arm64 (shard 1/2)']).not.toContain('^[');
    expect(errors['macos-arm64 (shard 1/2)']).not.toContain(String.fromCharCode(27));
    expect(errors['macos-arm64']).toBe('Process completed with exit code 1.');
    expect(
      firstErrorLines(
        'job\tstep\t2026-10-17T07:04:05.0000000Z ##[error]Process completed with exit code 1.\njob\tstep\t2026-10-17T07:04:05.0000001Z ##[error]No files were found',
      ),
    ).toEqual({ job: 'No files were found' });
    expect(firstErrorLines('')).toEqual({});
  });

  it('--failures lists only failed runs with step and error', () => {
    const green = summarizeRun(source.viewRun(GREEN), {}, null);
    const text = formatFailures([green, summary]);
    expect(text).not.toContain('39015143213');
    expect(text).toContain('Run 39011559538  push  main  2026-10-17 06:53:09Z');
    expect(text).toContain(
      '✘ windows-x64 (shard 2/2): "End-to-end tests (Playwright + Electron)" — Error: expect(locator).toHaveAttribute(expected) failed',
    );
    expect(formatFailures([green])).toBe('No failed runs.');
  });

  it('excerptLog keeps the error lines with context and the first lines of each job', () => {
    const excerpt = excerptLog(log);
    expect(excerpt.split('\n').length).toBeLessThanOrEqual(log.split('\n').length);
    expect(firstErrorLines(excerpt)).toEqual(firstErrorLines(log));
  });
});

describe('collect + report through the fixture source (what the CLI does with gh)', () => {
  it('lists the newest runs first and reproduces the table and the aggregate', () => {
    const opts = parseArgs(['--runs', '2', '--no-steps']);
    const summaries = collect(source, opts);
    expect(summaries.map((s) => String(s.id))).toEqual([GREEN, RED]);
    const text = report(summaries, opts);
    expect(text).toContain('Run 39015143213  success');
    expect(text).toContain('Run 39011559538  failure');
    expect(text).toContain('✘ macos-arm64 (shard 1/2): failed at "Verify');
    expect(text).toMatch(/queue:macos-arm64\s+2\s+9:21\s+9:21/); // only the green run counts
    expect(text).toContain('2 job(s) queued for more than a minute');
    expect(JSON.parse(report(summaries, parseArgs(['--json'])))).toHaveLength(2);
    expect(report(summaries, parseArgs(['--failures']))).not.toContain('39015143213');
  });

  it('parseArgs: defaults, --runs N, --run ids, unknown flag', () => {
    expect(parseArgs([])).toMatchObject({ runs: 20, failures: false, json: false, artifacts: true, workflow: 'CI' });
    expect(parseArgs(['--runs=5', '--failures', '--no-artifacts', '--repo', 'o/r'])).toMatchObject({
      runs: 5,
      failures: true,
      artifacts: false,
      repo: 'o/r',
    });
    expect(parseArgs(['--run', '1', '--run', '2']).runIds).toEqual(['1', '2']);
    expect(() => parseArgs(['--runs', '0'])).toThrow();
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });

  it('--failures skips the artifact downloads', () => {
    let downloads = 0;
    const counting = { ...source, e2eReports: (id: string) => (downloads++, source.e2eReports(id)) };
    collect(counting, parseArgs(['--failures', '--runs', '2']));
    expect(downloads).toBe(0);
    collect(counting, parseArgs(['--runs', '2']));
    expect(downloads).toBe(2);
  });

  it('trimRun / trimPlaywrightReport keep what the parser needs', () => {
    const run = source.viewRun(GREEN);
    expect(summarizeRun(trimRun(run), source.e2eReports(GREEN), null)).toEqual(
      summarizeRun(run, source.e2eReports(GREEN), null),
    );
    const results = source.e2eReports(GREEN)['e2e-report-macos-arm64-2']!;
    expect(slowestSpecFiles(trimPlaywrightReport(results), 5)).toEqual(slowestSpecFiles(results, 5));
  });
});

describe('E2E job summary (scripts/e2e-summary.mjs)', () => {
  const results = JSON.parse(readFileSync(path.join(FIXTURES, 'runs', GREEN, 'e2e-report-macos-arm64-2.json'), 'utf8'));

  it('lists the 10 slowest spec files, slowest first, with the shard total', () => {
    const slowest = slowestSpecFiles(results, 10);
    expect(slowest).toHaveLength(10);
    expect(slowest[0]).toMatchObject({ file: 'preview-isolation.spec.ts' });
    expect(slowest[0]!.ms).toBeGreaterThan(110_000);
    expect(slowest[1]!.file).toBe('recovery.spec.ts');
    for (let i = 1; i < slowest.length; i++) expect(slowest[i - 1]!.ms).toBeGreaterThanOrEqual(slowest[i]!.ms);
    expect(slowest.every((f) => f.tests > 0)).toBe(true);

    const md = formatStepSummary(results);
    expect(md).toContain('### E2E shard 2/2: 161 passed, 0 failed, 0 flaky, 0 skipped');
    expect(md).toContain('Playwright wall-clock **9:02**');
    expect(md).toContain('| Slowest spec files (10) | Tests | Time |');
    expect(md.split('\n').filter((l) => l.startsWith('| `')).length).toBe(10);
    expect(md).toMatch(/\| `preview-isolation\.spec\.ts` \| \d+ \| 1:5\d \|/);
    expect(formatStepSummary(results, { shard: '1/2', limit: 3 })).toContain('### E2E shard 1/2');
  });

  it('appendStepSummary appends to the summary file and never throws', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'noobide-e2e-summary-'));
    try {
      const summaryFile = path.join(dir, 'summary.md');
      const reportFile = path.join(dir, 'results.json');
      writeFileSync(summaryFile, 'before\n');
      writeFileSync(reportFile, JSON.stringify(results));
      expect(appendStepSummary(reportFile, summaryFile, { shard: '2/2' })).toBe(true);
      const written = readFileSync(summaryFile, 'utf8');
      expect(written.startsWith('before\n### E2E shard 2/2')).toBe(true);
      expect(written).toContain('`preview-isolation.spec.ts`');
      expect(appendStepSummary(path.join(dir, 'missing.json'), summaryFile)).toBe(false);
      writeFileSync(reportFile, '{not json');
      expect(appendStepSummary(reportFile, summaryFile)).toBe(false);
      expect(appendStepSummary(reportFile, undefined)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
