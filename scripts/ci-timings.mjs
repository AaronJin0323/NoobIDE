#!/usr/bin/env node
// S58.6 — where does CI time go? (docs/ci/ci-stability-and-speed-plan.md §2–§3, ADR 0037)
//
//   node scripts/ci-timings.mjs                 last 20 runs of the CI workflow: per job the queue delay, each
//                                               step's duration, the Playwright time from the e2e-report artifact
//                                               and, for failed runs, the failing step and the first error line
//   node scripts/ci-timings.mjs --runs 5        fewer runs
//   node scripts/ci-timings.mjs --failures      only failed runs: failing step + first error line per job
//   node scripts/ci-timings.mjs --json          machine-readable summaries (same data) on stdout
//   node scripts/ci-timings.mjs --run <id>      one run by id (any number of --run)
//   --no-artifacts    skip downloading e2e-report artifacts (faster; no Playwright column)
//   --no-steps        omit the per-step lines
//   --repo o/r        another repository (default: the one gh infers from this checkout)
//   --workflow NAME   another workflow (default: CI)
//   --save DIR        also write everything fetched as a fixture tree (tests/fixtures/ci layout)
//
// Pure Node, no dependency beyond the GitHub CLI (`gh`, authenticated). Everything that parses or formats lives in
// scripts/ci-timings-parse.mjs so tests can run it on saved fixtures without network.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aggregate,
  e2eReportArtifactName,
  excerptLog,
  formatAggregate,
  formatFailures,
  formatRun,
  parseJobName,
  summarizeRun,
} from './ci-timings-parse.mjs';

const RUN_FIELDS = 'databaseId,name,displayTitle,url,createdAt,updatedAt,status,conclusion,headBranch,event';
const VIEW_FIELDS = `${RUN_FIELDS},jobs`;

export function parseArgs(argv) {
  const opts = {
    runs: 20,
    failures: false,
    json: false,
    artifacts: true,
    steps: true,
    repo: null,
    workflow: 'CI',
    runIds: [],
    save: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--runs') opts.runs = Number(next());
    else if (a.startsWith('--runs=')) opts.runs = Number(a.slice(7));
    else if (a === '--failures') opts.failures = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--no-artifacts') opts.artifacts = false;
    else if (a === '--no-steps') opts.steps = false;
    else if (a === '--repo') opts.repo = next();
    else if (a === '--workflow') opts.workflow = next();
    else if (a === '--run') opts.runIds.push(String(next()));
    else if (a === '--save') opts.save = next();
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error('--runs needs a positive integer');
  return opts;
}

// ---- gh wrappers (thin; nothing below parses) ------------------------------------------------------------------

function gh(args, { repo, allowFailure = false } = {}) {
  const full = repo ? [...args, '--repo', repo] : args;
  const r = spawnSync('gh', full, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`gh could not be started (${r.error.message}); is the GitHub CLI installed?`);
  if (r.status !== 0) {
    if (allowFailure) return null;
    throw new Error(`gh ${full.join(' ')} failed:\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

/** A source backed by the GitHub CLI. */
export function ghSource({ repo = null, workflow = 'CI', artifacts = true } = {}) {
  return {
    listRuns(n) {
      return JSON.parse(
        gh(['run', 'list', '--workflow', workflow, '--limit', String(n), '--json', RUN_FIELDS], { repo }),
      );
    },
    viewRun(id) {
      return JSON.parse(gh(['run', 'view', String(id), '--json', VIEW_FIELDS], { repo }));
    },
    /** artifact name → parsed results.json for every e2e-report-* artifact of the run that still exists. */
    e2eReports(id, run) {
      if (!artifacts) return {};
      const wanted = new Set((run?.jobs ?? []).map((j) => e2eReportArtifactName(j.name)).filter(Boolean));
      if (!wanted.size) return {};
      const repoPath = repo ? `repos/${repo}` : 'repos/{owner}/{repo}';
      const listed = gh(['api', `${repoPath}/actions/runs/${id}/artifacts`, '--paginate'], {
        repo: null,
        allowFailure: true,
      });
      if (!listed) return {};
      const available = JSON.parse(listed).artifacts ?? [];
      const out = {};
      for (const a of available) {
        if (!wanted.has(a.name) || a.expired) continue;
        const dir = mkdtempSync(path.join(os.tmpdir(), 'noobide-ci-timings-'));
        try {
          if (gh(['run', 'download', String(id), '-n', a.name, '-D', dir], { repo, allowFailure: true }) === null)
            continue;
          const file = path.join(dir, 'results.json');
          if (existsSync(file)) out[a.name] = JSON.parse(readFileSync(file, 'utf8'));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      return out;
    },
    logFailed(id) {
      return gh(['run', 'view', String(id), '--log-failed'], { repo, allowFailure: true });
    },
  };
}

/**
 * A source backed by a fixture tree (what --save writes):
 *   <dir>/runs.json                          the run list
 *   <dir>/runs/<id>/run.json                 `gh run view --json` output
 *   <dir>/runs/<id>/e2e-report-<t>-<n>.json  the artifact's results.json (trimmed is fine)
 *   <dir>/runs/<id>/log-failed.txt           `gh run view --log-failed` output (excerpt is fine)
 */
export function fixtureSource(dir) {
  const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
  const runDir = (id) => path.join(dir, 'runs', String(id));
  return {
    listRuns(n) {
      const list = read(path.join(dir, 'runs.json'));
      if (list) return JSON.parse(list).slice(0, n);
      return readdirSync(path.join(dir, 'runs'))
        .map((id) => JSON.parse(read(path.join(runDir(id), 'run.json'))))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, n);
    },
    viewRun(id) {
      const text = read(path.join(runDir(id), 'run.json'));
      if (!text) throw new Error(`no fixture for run ${id} under ${dir}`);
      return JSON.parse(text);
    },
    e2eReports(id) {
      const out = {};
      if (!existsSync(runDir(id))) return out;
      for (const f of readdirSync(runDir(id))) {
        if (f.startsWith('e2e-report-') && f.endsWith('.json'))
          out[f.slice(0, -5)] = JSON.parse(read(path.join(runDir(id), f)));
      }
      return out;
    },
    logFailed(id) {
      return read(path.join(runDir(id), 'log-failed.txt'));
    },
  };
}

// ---- orchestration -----------------------------------------------------------------------------------------------

/** Fetch and summarize the runs the options select. Returns summaries, newest first. */
export function collect(source, opts, { onFetched } = {}) {
  const runs = opts.runIds.length ? opts.runIds.map((id) => ({ databaseId: id })) : source.listRuns(opts.runs);
  const summaries = [];
  for (const listed of runs) {
    const run = source.viewRun(listed.databaseId);
    const failed = run.conclusion === 'failure' || run.jobs?.some((j) => j.conclusion === 'failure');
    const reports = opts.failures ? {} : source.e2eReports(run.databaseId, run);
    const log = failed ? source.logFailed(run.databaseId) : null;
    onFetched?.({ run, reports, log });
    summaries.push(summarizeRun(run, reports, log));
  }
  return summaries;
}

/** Keep only what the parser reads: file names, statuses and durations (a few KB instead of 75). */
export function trimPlaywrightReport(results) {
  const trimSuite = (s) => {
    const out = { file: s.file };
    if (s.specs?.length) {
      out.specs = s.specs.map((spec) => ({
        tests: (spec.tests ?? []).map((t) => ({
          results: (t.results ?? []).map((r) => ({ status: r.status, duration: r.duration })),
        })),
      }));
    }
    if (s.suites?.length) out.suites = s.suites.map(trimSuite);
    return out;
  };
  return {
    config: { shard: results.config?.shard ?? null },
    stats: results.stats,
    suites: (results.suites ?? []).map(trimSuite),
  };
}

/** The run fields the parser reads (drops per-job urls, ids and step numbers). */
export function trimRun(run) {
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  return {
    ...pick(run, [
      'databaseId',
      'name',
      'displayTitle',
      'url',
      'createdAt',
      'updatedAt',
      'status',
      'conclusion',
      'headBranch',
      'event',
    ]),
    jobs: (run.jobs ?? []).map((j) => ({
      ...pick(j, ['name', 'status', 'conclusion', 'startedAt', 'completedAt']),
      steps: (j.steps ?? []).map((s) => pick(s, ['name', 'status', 'conclusion', 'startedAt', 'completedAt'])),
    })),
  };
}

function compactJson(value) {
  // One suite per line keeps the fixture diffable without pretty-printing every duration onto its own line.
  if (Array.isArray(value.suites)) {
    const { suites, ...rest } = value;
    const head = JSON.stringify(rest).slice(1, -1);
    return `{${head},\n"suites":[\n${suites.map((s) => JSON.stringify(s)).join(',\n')}\n]}\n`;
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

function saveFixture(dir, { run, reports, log }, list) {
  const runDir = path.join(dir, 'runs', String(run.databaseId));
  mkdirSync(runDir, { recursive: true });
  if (list) writeFileSync(path.join(dir, 'runs.json'), `${JSON.stringify(list, null, 2)}\n`);
  writeFileSync(path.join(runDir, 'run.json'), compactJson(trimRun(run)));
  for (const [name, results] of Object.entries(reports)) {
    writeFileSync(path.join(runDir, `${name}.json`), compactJson(trimPlaywrightReport(results)));
  }
  if (log) writeFileSync(path.join(runDir, 'log-failed.txt'), `${excerptLog(log)}\n`);
}

export function report(summaries, opts) {
  if (opts.json) return JSON.stringify(summaries, null, 2);
  if (opts.failures) return formatFailures(summaries);
  const parts = summaries.map((s) => formatRun(s, { steps: opts.steps }));
  parts.push(formatAggregate(aggregate(summaries)));
  const queued = summaries.flatMap((s) => s.jobs.filter((j) => parseJobName(j.name) && j.queueSeconds > 60));
  if (queued.length) parts.push(`${queued.length} job(s) queued for more than a minute (plan §2: macOS concurrency).`);
  return parts.join('\n\n');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (opts.help) {
    console.log(
      readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n')
        .slice(1, 17)
        .map((l) => l.replace(/^\/\/ ?/, ''))
        .join('\n'),
    );
    return;
  }
  const source = ghSource({ repo: opts.repo, workflow: opts.workflow, artifacts: opts.artifacts });
  let list = null;
  const original = source.listRuns;
  source.listRuns = (n) => (list = original(n));
  const summaries = collect(source, opts, {
    onFetched: (fetched) => {
      if (opts.save) saveFixture(opts.save, fetched, list);
      if (!opts.json) process.stderr.write(`fetched run ${fetched.run.databaseId}\n`);
    },
  });
  console.log(report(summaries, opts));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
