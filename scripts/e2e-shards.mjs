#!/usr/bin/env node
// S50.2 — deterministic, time-balanced E2E shards (docs/ci/ci-stability-and-speed-plan.md §4 S50.2).
//
// Playwright's own `--shard=N/M` splits the suite by *test count in file order*, so adding one spec file (or a
// platform skipping a test) moves the boundary and can put the two 2-minute files on the same shard. Instead,
// tests/e2e/shards.json names the shard of every spec file and scripts/e2e.mjs passes that shard's files to
// Playwright as positional file filters.
//
//   node scripts/e2e-shards.mjs balance <results.json | dir | glob> …   rewrite tests/e2e/shards.json from the
//                                                                      Playwright JSON reports CI uploads
//                                                                      (reports/e2e/results.json per shard)
//   node scripts/e2e-shards.mjs list N/M                               print the spec files of shard N
//   node scripts/e2e-shards.mjs check                                  exit 1 unless the manifest lists every
//                                                                      existing spec file exactly once
//
// `balance` sums each file's test durations over every report given (two OSes × two shards means every file is
// counted on both OSes), then assigns files longest-first to the emptier shard. Spec files with no measurement
// (new since the reports) get the median measured duration; files that no longer exist are dropped.
// Pure Node, no dependencies; the functions below are unit-tested in tests/integration/e2e-shards.test.ts.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const E2E_DIR = path.join(ROOT, 'tests', 'e2e');
export const MANIFEST_PATH = path.join(E2E_DIR, 'shards.json');
export const MANIFEST_RELATIVE = 'tests/e2e/shards.json';
const DEFAULT_SHARDS = 2;

/** Spec file basenames (`*.spec.ts`) in a directory, sorted so output is stable. */
export function listSpecFiles(dir = E2E_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.spec.ts'))
    .sort();
}

/** Parse `N/M` (1-based shard N of M). Throws on anything else. */
export function parseShard(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(String(spec).trim());
  if (!m) throw new Error(`invalid shard "${spec}": expected N/M, e.g. 1/2`);
  const current = Number(m[1]);
  const total = Number(m[2]);
  if (total < 1 || current < 1 || current > total) throw new Error(`invalid shard "${spec}": N must be in 1..M`);
  return { current, total };
}

/** Validate a parsed manifest and return it. */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('shards.json: not an object');
  const { shards, files } = manifest;
  if (!Number.isInteger(shards) || shards < 1) throw new Error('shards.json: "shards" must be a positive integer');
  if (!files || typeof files !== 'object' || Array.isArray(files))
    throw new Error('shards.json: "files" must be an object');
  for (const [file, shard] of Object.entries(files)) {
    if (!file.endsWith('.spec.ts')) throw new Error(`shards.json: "${file}" is not a *.spec.ts basename`);
    if (file !== path.basename(file)) throw new Error(`shards.json: "${file}" must be a basename, not a path`);
    if (!Number.isInteger(shard) || shard < 1 || shard > shards)
      throw new Error(`shards.json: "${file}" is assigned to shard ${shard}, expected 1..${shards}`);
  }
  return manifest;
}

export function loadManifest(file = MANIFEST_PATH) {
  return validateManifest(JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * Sum the test-result durations (ms) of a Playwright JSON report per spec file basename.
 * Works on the full `results.json` and on the trimmed fixtures (suite tree → specs → tests → results).
 */
export function fileDurations(report) {
  const totals = new Map();
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const file = path.basename(String(spec.file ?? suite.file ?? ''));
      if (!file) continue;
      let ms = 0;
      for (const test of spec.tests ?? []) for (const r of test.results ?? []) ms += Number(r.duration) || 0;
      totals.set(file, (totals.get(file) ?? 0) + ms);
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report?.suites ?? []) walk(suite);
  return totals;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Build a manifest from one or more parsed Playwright reports.
 * - durations are summed per file across all reports;
 * - files longest-first go to the shard with the smallest total so far (ties → the lowest shard number);
 * - `specFiles` (when given) is the set of files the manifest must cover: files absent from the reports get the
 *   median measured duration (`unmeasured`), files present only in the reports are dropped (`dropped`).
 * Returns `{ manifest, totals, unmeasured, dropped }`; `totals[i]` is the estimated ms of shard i+1.
 */
export function balance(reports, specFiles, { shards = DEFAULT_SHARDS, generatedFrom } = {}) {
  if (!Number.isInteger(shards) || shards < 1) throw new Error('shards must be a positive integer');
  const measured = new Map();
  for (const report of reports) {
    for (const [file, ms] of fileDurations(report)) measured.set(file, (measured.get(file) ?? 0) + ms);
  }
  const wanted = specFiles ? [...new Set(specFiles)] : [...measured.keys()];
  const fallback = median([...measured.values()]);
  const unmeasured = wanted.filter((f) => !measured.has(f)).sort();
  const dropped = [...measured.keys()].filter((f) => !wanted.includes(f)).sort();
  const durations = wanted.map((file) => ({ file, ms: measured.get(file) ?? fallback }));
  // Longest first; equal durations by name so the result does not depend on report order.
  durations.sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file));

  const totals = new Array(shards).fill(0);
  const assignment = {};
  for (const { file, ms } of durations) {
    let target = 0;
    for (let i = 1; i < shards; i++) if (totals[i] < totals[target]) target = i;
    totals[target] += ms;
    assignment[file] = target + 1;
  }
  const files = {};
  for (const file of Object.keys(assignment).sort()) files[file] = assignment[file];
  const estimate = totals.map((ms, i) => `shard ${i + 1} ≈ ${Math.round(ms / 1000)} s`).join(', ');
  const note = `${generatedFrom ?? 'node scripts/e2e-shards.mjs balance'}; summed test time over the reports: ${estimate}`;
  return { manifest: { shards, generated_from: note, files }, totals, unmeasured, dropped };
}

/**
 * The spec files of shard `shard` (1-based) according to `manifest`, given every existing spec file.
 * A file missing from the manifest runs in the shard with the fewest assigned files (ties → shard 1) and is
 * reported in `unlisted`; a manifest entry without a file is reported in `stale` and never selected.
 */
export function select(manifest, shard, allSpecFiles) {
  validateManifest(manifest);
  if (!Number.isInteger(shard) || shard < 1 || shard > manifest.shards)
    throw new Error(`shard ${shard} is out of range 1..${manifest.shards}`);
  const existing = new Set(allSpecFiles);
  const counts = new Array(manifest.shards).fill(0);
  const stale = [];
  for (const [file, s] of Object.entries(manifest.files)) {
    if (existing.has(file)) counts[s - 1]++;
    else stale.push(file);
  }
  const unlisted = [...existing].filter((f) => !Object.hasOwn(manifest.files, f)).sort();
  let lighter = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] < counts[lighter]) lighter = i;
  const files = [...existing].filter((f) => (manifest.files[f] ?? lighter + 1) === shard).sort();
  return { files, unlisted, stale: stale.sort(), fallbackShard: lighter + 1 };
}

/**
 * Positional Playwright filters for the given spec basenames: anchored regexes over the posix path, so
 * `preview.spec.ts` can never also match `preview-isolation.spec.ts` (Playwright compiles bare arguments with
 * `new RegExp(arg, 'gi')` and tests them against the file path).
 */
export function playwrightFilters(files, dir = 'tests/e2e') {
  return files.map((f) => `${dir}/${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

function expandReportArgs(args) {
  const out = [];
  for (const arg of args) {
    if (arg.includes('*')) {
      const dir = path.dirname(arg);
      const re = new RegExp(
        `^${path
          .basename(arg)
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')}$`,
      );
      if (existsSync(dir)) for (const f of readdirSync(dir).sort()) if (re.test(f)) out.push(path.join(dir, f));
    } else if (existsSync(arg) && statSync(arg).isDirectory()) {
      for (const f of readdirSync(arg).sort()) if (f.endsWith('.json')) out.push(path.join(arg, f));
    } else {
      out.push(arg);
    }
  }
  return out;
}

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const [command, ...rest] = argv;
  if (command === 'balance') {
    const files = expandReportArgs(rest);
    if (!files.length) {
      error('usage: node scripts/e2e-shards.mjs balance <results.json | dir | glob> …');
      return 2;
    }
    const reports = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
    const date = new Date().toISOString().slice(0, 10);
    const sources = files.map((f) => path.relative(ROOT, path.resolve(f)).split(path.sep).join('/')).join(', ');
    const { manifest, totals, unmeasured, dropped } = balance(reports, listSpecFiles(), {
      shards: existsSync(MANIFEST_PATH) ? loadManifest().shards : DEFAULT_SHARDS,
      generatedFrom: `node scripts/e2e-shards.mjs balance ${sources} (${date})`,
    });
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
    log(`wrote ${MANIFEST_RELATIVE}: ${Object.keys(manifest.files).length} spec files on ${manifest.shards} shards`);
    totals.forEach((ms, i) =>
      log(
        `  shard ${i + 1}: ${Object.values(manifest.files).filter((s) => s === i + 1).length} files, ≈ ${Math.round(ms / 1000)} s summed test time`,
      ),
    );
    if (unmeasured.length) log(`  no timing data (median used): ${unmeasured.join(', ')}`);
    if (dropped.length) log(`  dropped (no such spec file any more): ${dropped.join(', ')}`);
    return 0;
  }
  if (command === 'list') {
    const { current, total } = parseShard(rest[0] ?? '');
    const manifest = loadManifest();
    if (total !== manifest.shards) {
      error(`${MANIFEST_RELATIVE} defines ${manifest.shards} shards, not ${total}`);
      return 2;
    }
    const { files, unlisted, stale, fallbackShard } = select(manifest, current, listSpecFiles());
    for (const f of files) log(f);
    for (const f of unlisted)
      error(`warning: add ${f} to ${MANIFEST_RELATIVE} (running it in shard ${fallbackShard} meanwhile)`);
    for (const f of stale) error(`warning: remove ${f} from ${MANIFEST_RELATIVE} (no such spec file)`);
    return 0;
  }
  if (command === 'check') {
    const manifest = loadManifest();
    const { unlisted, stale } = select(manifest, 1, listSpecFiles());
    for (const f of unlisted) error(`add ${f} to ${MANIFEST_RELATIVE}`);
    for (const f of stale) error(`remove ${f} from ${MANIFEST_RELATIVE} (no such spec file)`);
    if (unlisted.length || stale.length) return 1;
    log(`${MANIFEST_RELATIVE} lists all ${Object.keys(manifest.files).length} spec files exactly once`);
    return 0;
  }
  error('usage: node scripts/e2e-shards.mjs balance <reports…> | list N/M | check');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
