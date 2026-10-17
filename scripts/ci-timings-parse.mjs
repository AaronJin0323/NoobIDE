// S50.6 — pure parsing and formatting for scripts/ci-timings.mjs (docs/ci/ci-stability-and-speed-plan.md §2).
// No network, no gh: everything here works on the JSON that `gh run list` / `gh run view --json` return, on a
// Playwright JSON report (reports/e2e/results.json) and on the text of `gh run view --log-failed`, so
// tests/integration/ci-timings.test.ts can run it on saved fixtures under tests/fixtures/ci/.

/** Seconds between two ISO timestamps, or null when either is missing. */
export function secondsBetween(from, to) {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  // gh reports a step or job that has not started or finished with the zero time (0001-01-01T00:00:00Z).
  if (from.startsWith('0001-') || to.startsWith('0001-')) return null;
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / 1000);
}

/** 153 → "2:33"; 3684 → "1:01:24"; null → "–". */
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '–';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}

/** "windows-x64 (shard 1/2)" → { target: "windows-x64", shard: 1, of: 2 }; gate jobs → null. */
export function parseJobName(name) {
  const m = /^(\S+) \(shard (\d+)\/(\d+)\)$/.exec(name ?? '');
  return m ? { target: m[1], shard: Number(m[2]), of: Number(m[3]) } : null;
}

/** Artifact that holds a shard's Playwright report (ci.yml "Upload E2E timing report"). */
export function e2eReportArtifactName(jobName) {
  const p = parseJobName(jobName);
  return p ? `e2e-report-${p.target}-${p.shard}` : null;
}

/** Total Playwright test time in seconds from a JSON reporter file (stats.duration is milliseconds). */
export function playwrightSeconds(results) {
  const ms = results?.stats?.duration;
  return typeof ms === 'number' ? Math.round(ms / 1000) : null;
}

/** Per spec file: test time (sum of result durations, ms) and test count, slowest first. */
export function slowestSpecFiles(results, limit = 10) {
  const perFile = new Map();
  const visit = (suite, file) => {
    const own = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      const key = spec.file ?? own ?? suite.title ?? '?';
      const entry = perFile.get(key) ?? { file: key, ms: 0, tests: 0 };
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          entry.ms += result.duration ?? 0;
          entry.tests += 1;
        }
      }
      perFile.set(key, entry);
    }
    for (const child of suite.suites ?? []) visit(child, own);
  };
  for (const suite of results?.suites ?? []) visit(suite, suite.file);
  return [...perFile.values()].sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file)).slice(0, limit);
}

// The §2 table rows. Each category is the sum of the steps whose names match; "e2e" is split into packaging and
// Playwright when the shard's report is known (the step runs scripts/e2e.mjs, which packages first).
export const STEP_CATEGORIES = [
  {
    key: 'setup',
    label: 'Setup',
    match: /^(Set up job|Checkout|Set up Node\.js|Check runner architecture|Install dependencies)$/,
  },
  { key: 'faults', label: 'Faults', match: /^(Fault suite.*|Upload fault suite report)$/ },
  { key: 'verify', label: 'Verify', match: /^Verify\b/ },
  { key: 'e2e', label: 'E2E step', match: /^End-to-end tests\b/ },
  {
    key: 'installers',
    label: 'Installers',
    match: /^(Make installers|Inspect binary architectures|Upload installers)$/,
  },
];

const NOISE_STEPS = /^(Post .*|Complete job)$/;

/**
 * One job of a run → queue delay, every step's duration, the §2 categories, and the failing step (if any).
 * `e2eReport` is the parsed results.json of the shard's e2e-report artifact, when it could be downloaded.
 */
export function summarizeJob(run, job, e2eReport) {
  const queueSeconds = secondsBetween(run.createdAt, job.startedAt);
  const totalSeconds = secondsBetween(job.startedAt, job.completedAt);
  const steps = (job.steps ?? [])
    .filter((s) => s.conclusion !== 'skipped' && !NOISE_STEPS.test(s.name))
    .map((s) => ({ name: s.name, seconds: secondsBetween(s.startedAt, s.completedAt), conclusion: s.conclusion }));
  const categories = {};
  for (const c of STEP_CATEGORIES) {
    const matching = steps.filter((s) => c.match.test(s.name));
    // A category is unknown (–) until every step in it has finished.
    categories[c.key] =
      matching.length && matching.every((s) => s.seconds !== null)
        ? matching.reduce((sum, s) => sum + s.seconds, 0)
        : null;
  }
  const playwrightSecs = e2eReport ? playwrightSeconds(e2eReport) : null;
  categories.playwright = playwrightSecs;
  categories.package =
    playwrightSecs !== null && categories.e2e !== null ? Math.max(0, categories.e2e - playwrightSecs) : null;
  const failingStep = (job.steps ?? []).find((s) => s.conclusion === 'failure')?.name ?? null;
  return {
    name: job.name,
    conclusion: job.conclusion ?? job.status ?? null,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    queueSeconds,
    totalSeconds,
    steps,
    categories,
    failingStep,
    e2e: e2eReport
      ? {
          seconds: playwrightSecs,
          expected: e2eReport.stats?.expected ?? null,
          unexpected: e2eReport.stats?.unexpected ?? null,
          skipped: e2eReport.stats?.skipped ?? null,
          slowest: slowestSpecFiles(e2eReport, 3),
        }
      : null,
  };
}

// gh writes colour codes as a literal caret-bracket (^[[31m) when stdout is not a terminal; also accept real ESC.
// eslint-disable-next-line no-control-regex -- the escape character is exactly what this removes
const ANSI = /(?:\x1b|\^\[)\[[0-9;]*[A-Za-z]/g;
const LOG_LINE = /^([^\t]*)\t([^\t]*)\t\uFEFF?(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z )?(.*)$/;
const EXIT_CODE = /^##\[error\]Process completed with exit code/;
// "AssertionError: expected…", "Error: expect(locator)…", Vitest's "FAIL tests/… > name", or a specific annotation.
const ERROR_LINE = /^(?:##\[error\])?\s*(?:[A-Za-z.]*Error:|FAIL\b)/;

/**
 * `gh run view --log-failed` text → per job: the first line that looks like the actual error (an `Error:` /
 * `AssertionError` / Vitest `FAIL` line, or a `##[error]` annotation that is not the generic exit-code one).
 * Lines are `<job>\t<step>\t<timestamp> <text>`; ANSI colour codes are removed.
 */
export function firstErrorLines(logText) {
  const byJob = new Map();
  for (const raw of (logText ?? '').split(/\r?\n/)) {
    const m = LOG_LINE.exec(raw);
    if (!m) continue;
    const [, job, , rest] = m;
    const text = rest.replace(ANSI, '').trim();
    if (!text) continue;
    const entry = byJob.get(job) ?? { job, error: null, detail: null, fallback: null, exit: null };
    if (ERROR_LINE.test(text) && !EXIT_CODE.test(text)) {
      const clean = text.replace(/^##\[error\]/, '');
      if (!entry.error) entry.error = clean;
      // A Vitest FAIL line names the test; the assertion that follows says why. Keep both.
      else if (entry.error.startsWith('FAIL') && !entry.detail && /Error:/.test(clean)) entry.detail = clean;
    }
    if (text.startsWith('##[error]')) {
      const clean = text.replace(/^##\[error\]/, '');
      if (EXIT_CODE.test(text)) entry.exit ??= clean;
      else entry.fallback ??= clean;
    }
    byJob.set(job, entry);
  }
  const out = {};
  for (const { job, error, detail, fallback, exit } of byJob.values()) {
    out[job] = error ? (detail ? `${error} — ${detail}` : error) : (fallback ?? exit ?? null);
  }
  return out;
}

/**
 * Shorten a --log-failed text to the lines worth keeping as a fixture: per job the first three lines and every
 * error-looking line with two lines of context before and after it. Keeps the raw format (tabs, ANSI codes).
 */
export function excerptLog(logText, { context = 2, head = 3 } = {}) {
  const lines = (logText ?? '').split(/\r?\n/);
  const keep = new Set();
  const seen = new Map();
  lines.forEach((raw, i) => {
    const m = LOG_LINE.exec(raw);
    if (!m) return;
    const job = m[1];
    const count = (seen.get(job) ?? 0) + 1;
    seen.set(job, count);
    if (count <= head) keep.add(i);
    const text = m[3].replace(ANSI, '').trim();
    if (ERROR_LINE.test(text) || text.startsWith('##[error]')) {
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep.add(k);
    }
  });
  return lines.filter((_, i) => keep.has(i)).join('\n');
}

/**
 * Whole run → summary. `reports` maps artifact name → parsed results.json; `failedLog` is the --log-failed text
 * for failed runs (or null).
 */
export function summarizeRun(run, reports = {}, failedLog = null) {
  const errors = failedLog ? firstErrorLines(failedLog) : {};
  const jobs = (run.jobs ?? []).map((job) => {
    const artifact = e2eReportArtifactName(job.name);
    const summary = summarizeJob(run, job, artifact ? reports[artifact] : undefined);
    summary.firstError = summary.failingStep ? (errors[job.name] ?? null) : null;
    return summary;
  });
  const shardJobs = jobs.filter((j) => parseJobName(j.name));
  shardJobs.sort((a, b) => {
    const pa = parseJobName(a.name);
    const pb = parseJobName(b.name);
    return pa.target.localeCompare(pb.target) || pa.shard - pb.shard;
  });
  const gateJobs = jobs.filter((j) => !parseJobName(j.name));
  return {
    id: run.databaseId ?? run.id ?? null,
    url: run.url ?? null,
    title: run.displayTitle ?? run.name ?? '',
    branch: run.headBranch ?? '',
    event: run.event ?? '',
    status: run.status ?? '',
    conclusion: run.conclusion || run.status || '',
    createdAt: run.createdAt ?? null,
    wallClockSeconds: secondsBetween(run.createdAt, run.updatedAt),
    jobs: [...shardJobs, ...gateJobs],
  };
}

function pad(text, width, right = false) {
  const t = String(text);
  return right ? t.padStart(width) : t.padEnd(width);
}

function table(header, rows, rightFrom = 1) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) =>
    cells
      .map((c, i) => pad(c, widths[i], i >= rightFrom))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

const COLUMNS = [
  ['Queue', (j) => j.queueSeconds],
  ['Setup', (j) => j.categories.setup],
  ['Faults', (j) => j.categories.faults],
  ['Verify', (j) => j.categories.verify],
  ['Package', (j) => j.categories.package],
  ['Playwright', (j) => j.categories.playwright],
  ['E2E step', (j) => j.categories.e2e],
  ['Installers', (j) => j.categories.installers],
  ['Total', (j) => j.totalSeconds],
];

/** Text report for one summarized run: header line, the §2-style table, each job's steps, and errors. */
export function formatRun(summary, { steps = true } = {}) {
  const when = summary.createdAt ? summary.createdAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '?';
  const lines = [
    `Run ${summary.id}  ${summary.conclusion || '?'}  ${summary.event}  ${summary.branch}  ${when}  wall-clock ${formatDuration(summary.wallClockSeconds)}`,
  ];
  // Runs from before the shard matrix (S06.5) have build jobs named like the gates; show whatever has steps.
  const matrix = summary.jobs.filter((j) => parseJobName(j.name));
  const shardJobs = matrix.length ? matrix : summary.jobs.filter((j) => j.steps.length > 3);
  if (shardJobs.length) {
    const rows = shardJobs.map((j) => [
      `${j.name}${j.conclusion && j.conclusion !== 'success' ? ` [${j.conclusion}]` : ''}`,
      ...COLUMNS.map(([, pick]) => formatDuration(pick(j))),
    ]);
    for (const l of table(['Job', ...COLUMNS.map(([label]) => label)], rows)) lines.push(`  ${l}`);
  }
  for (const j of summary.jobs) {
    if (steps && shardJobs.includes(j)) {
      lines.push(`  ${j.name} steps: ${j.steps.map((s) => `${s.name} ${formatDuration(s.seconds)}`).join(' · ')}`);
    }
    if (j.e2e?.slowest?.length) {
      const slow = j.e2e.slowest.map((f) => `${f.file} ${formatDuration(f.ms / 1000)}`).join(', ');
      lines.push(
        `  ${j.name} e2e: ${j.e2e.expected ?? '?'} passed, ${j.e2e.unexpected ?? '?'} failed, ${j.e2e.skipped ?? '?'} skipped; slowest ${slow}`,
      );
    }
    if (j.failingStep) {
      lines.push(`  ✘ ${j.name}: failed at "${j.failingStep}"${j.firstError ? ` — ${j.firstError}` : ''}`);
    }
  }
  return lines.join('\n');
}

/** Compact one-line-per-job listing for --failures: only runs that failed, with step and first error. */
export function formatFailures(summaries) {
  const lines = [];
  for (const s of summaries) {
    if (s.conclusion !== 'failure') continue;
    const when = s.createdAt ? s.createdAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '?';
    lines.push(`Run ${s.id}  ${s.event}  ${s.branch}  ${when}`);
    for (const j of s.jobs) {
      if (!j.failingStep) continue;
      lines.push(`  ✘ ${j.name}: "${j.failingStep}"${j.firstError ? ` — ${j.firstError}` : ''}`);
    }
  }
  return lines.length ? lines.join('\n') : 'No failed runs.';
}

/** Median and max of the categories across the shard jobs of the given runs (for the ADR's before/after rows). */
export function aggregate(summaries) {
  const values = {};
  const push = (key, v) => {
    if (v === null || v === undefined) return;
    (values[key] ??= []).push(v);
  };
  for (const s of summaries) {
    if (s.conclusion !== 'success') continue;
    push('wallClock', s.wallClockSeconds);
    for (const j of s.jobs) {
      if (!parseJobName(j.name)) continue;
      const p = parseJobName(j.name);
      push(`queue:${p.target}`, j.queueSeconds);
      push(`total:${p.target}`, j.totalSeconds);
      push(`playwright:${p.target}`, j.categories.playwright);
    }
  }
  const stats = {};
  for (const [key, list] of Object.entries(values)) {
    const sorted = [...list].sort((a, b) => a - b);
    stats[key] = { n: sorted.length, median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] };
  }
  return stats;
}

export function formatAggregate(stats) {
  const keys = Object.keys(stats);
  if (!keys.length) return 'No successful runs to aggregate.';
  const rows = keys.map((k) => [k, stats[k].n, formatDuration(stats[k].median), formatDuration(stats[k].max)]);
  return [
    'Successful runs, by measure (median / max):',
    ...table(['Measure', 'n', 'Median', 'Max'], rows).map((l) => `  ${l}`),
  ].join('\n');
}
