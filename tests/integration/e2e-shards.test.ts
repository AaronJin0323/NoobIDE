// S50.2 — deterministic, time-balanced E2E shards (docs/ci/ci-stability-and-speed-plan.md §4 S50.2).
//
// Part 1 unit-tests scripts/e2e-shards.mjs on trimmed copies of the four Playwright reports CI uploaded for run
// 39015143213 (tests/fixtures/e2e-shards). Part 2 proves, against the real `playwright test --list` output on this
// OS, that the manifest's two shards are disjoint and together cover every test, and that tests/e2e/shards.json
// lists every existing spec file exactly once — so a new spec file fails here with its name, never by moving a
// shard boundary.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  balance,
  fileDurations,
  listSpecFiles,
  loadManifest,
  MANIFEST_RELATIVE,
  main,
  parseShard,
  playwrightFilters,
  select,
  validateManifest,
} from '../../scripts/e2e-shards.mjs';
import type { PlaywrightReport, ShardManifest } from '../../scripts/e2e-shards.mjs';

const root = path.resolve(__dirname, '../..');
const fixtureDir = path.join(root, 'tests/fixtures/e2e-shards');
const fixtureNames = readdirSync(fixtureDir)
  .filter((f) => f.endsWith('.json'))
  .sort();
const fixtures = new Map(
  fixtureNames.map((f) => [f, JSON.parse(readFileSync(path.join(fixtureDir, f), 'utf8')) as PlaywrightReport]),
);
const reports = [...fixtures.values()];
const fixture = (name: string): PlaywrightReport => {
  const report = fixtures.get(name);
  if (!report) throw new Error(`missing fixture ${name}`);
  return report;
};

const seconds = (ms: number) => ms / 1000;

describe('scripts/e2e-shards.mjs on the run 39015143213 reports', () => {
  it('sums test durations per spec file from a Playwright JSON report', () => {
    const mac2 = fileDurations(fixture('e2e-report-macos-arm64-2.json'));
    expect(mac2.size).toBe(27);
    // The console-flood measurement file: 116 s on the macOS runner (plan §2).
    expect(seconds(mac2.get('preview-isolation.spec.ts')!)).toBeGreaterThan(100);
    const win1 = fileDurations(fixture('e2e-report-windows-x64-1.json'));
    expect(seconds(win1.get('app-startup-restore.spec.ts')!)).toBeGreaterThan(100);
    // Nested describe blocks are walked, not only top-level file suites.
    const total = [...win1.values()].reduce((a, b) => a + b, 0);
    expect(seconds(total)).toBeGreaterThan(300);
  });

  it('balance puts the longest files first on the emptier shard and keeps the two 2-minute files apart', () => {
    const { manifest, totals } = balance(reports);
    expect(manifest.shards).toBe(2);
    expect(Object.keys(manifest.files)).toHaveLength(59); // PR 17 still had ai-chat-engine.spec.ts
    expect(manifest.files['app-startup-restore.spec.ts']).not.toBe(manifest.files['preview-isolation.spec.ts']);
    // The two shards' summed test time differs by far less than the 60 s acceptance threshold.
    expect(Math.abs(seconds(totals[0] ?? 0) - seconds(totals[1] ?? 0))).toBeLessThan(10);
    expect(manifest.generated_from).toMatch(/shard 1 ≈ \d+ s, shard 2 ≈ \d+ s/);
    // Deterministic: the same reports in another order give the same manifest.
    expect(balance([...reports].reverse()).manifest.files).toEqual(manifest.files);
  });

  it('balance is greedy longest-first on a hand-made example', () => {
    const report = (file: string, duration: number): PlaywrightReport => ({
      suites: [{ title: file, file, specs: [{ file, tests: [{ results: [{ duration }] }] }] }],
    });
    const { manifest, totals } = balance([
      report('a.spec.ts', 100),
      report('b.spec.ts', 60),
      report('c.spec.ts', 50),
      report('d.spec.ts', 40),
      report('e.spec.ts', 10),
    ]);
    // a→1 (100) · b→2 (60) · c→2 (110) · d→1 (140) · e→2 (120)
    expect(manifest.files).toEqual({ 'a.spec.ts': 1, 'b.spec.ts': 2, 'c.spec.ts': 2, 'd.spec.ts': 1, 'e.spec.ts': 2 });
    expect(totals).toEqual([140, 120]);
    expect(balance([report('x.spec.ts', 1)], undefined, { shards: 3 }).totals).toEqual([1, 0, 0]);
  });

  it('balance covers exactly the current spec files: unmeasured ones get the median, vanished ones are dropped', () => {
    const current = ['app-startup-restore.spec.ts', 'preview-isolation.spec.ts', 'brand-new.spec.ts', 'smoke.spec.ts'];
    const { manifest, unmeasured, dropped } = balance(reports, current);
    expect(Object.keys(manifest.files).sort()).toEqual([...current].sort());
    expect(unmeasured).toEqual(['brand-new.spec.ts']);
    expect(dropped).toContain('ai-chat-engine.spec.ts');
    expect(manifest.files['app-startup-restore.spec.ts']).not.toBe(manifest.files['preview-isolation.spec.ts']);
  });

  it('select returns a shard’s files, parks unlisted files in the shard with fewer files and reports stale entries', () => {
    const manifest: ShardManifest = {
      shards: 2,
      files: { 'a.spec.ts': 1, 'b.spec.ts': 1, 'c.spec.ts': 2, 'gone.spec.ts': 2 },
    };
    const existing = ['a.spec.ts', 'b.spec.ts', 'c.spec.ts', 'new.spec.ts'];
    const first = select(manifest, 1, existing);
    const second = select(manifest, 2, existing);
    expect(first.files).toEqual(['a.spec.ts', 'b.spec.ts']);
    // gone.spec.ts does not count: shard 2 has one real file, so the new file lands there.
    expect(second.files).toEqual(['c.spec.ts', 'new.spec.ts']);
    expect(first.unlisted).toEqual(['new.spec.ts']);
    expect(first.stale).toEqual(['gone.spec.ts']);
    expect(first.fallbackShard).toBe(2);
    // Ties go to shard 1.
    expect(select({ shards: 2, files: {} }, 1, ['z.spec.ts']).files).toEqual(['z.spec.ts']);
    expect(select({ shards: 2, files: {} }, 2, ['z.spec.ts']).files).toEqual([]);
    expect(() => select(manifest, 3, existing)).toThrow(/out of range/);
  });

  it('a spec file that is not in the manifest still runs: both shards together cover it', () => {
    // The acceptance scenario: a branch adds a spec file and forgets the manifest. CI must not drop the test.
    const manifest = loadManifest();
    const existing = [...listSpecFiles(), 'splitter-physics.spec.ts'];
    const union = [...select(manifest, 1, existing).files, ...select(manifest, 2, existing).files].sort();
    expect(union).toEqual([...existing].sort());
  });

  it('validates manifests, shard specs and builds anchored Playwright file filters', () => {
    expect(() => validateManifest({ shards: 2, files: { 'a.spec.ts': 3 } })).toThrow(/expected 1\.\.2/);
    expect(() => validateManifest({ shards: 2, files: { 'tests/e2e/a.spec.ts': 1 } })).toThrow(/basename/);
    expect(() => validateManifest({ shards: 0, files: {} })).toThrow(/shards/);
    expect(parseShard('2/2')).toEqual({ current: 2, total: 2 });
    expect(() => parseShard('3/2')).toThrow(/1\.\.M/);
    expect(() => parseShard('1')).toThrow(/N\/M/);
    const filter = playwrightFilters(['preview.spec.ts']).join();
    expect(filter).toBe('tests/e2e/preview\\.spec\\.ts$');
    // Playwright compiles bare arguments with new RegExp(arg, 'gi') against the posix path.
    const re = new RegExp(filter, 'gi');
    expect(re.test('/w/NoobIDE/tests/e2e/preview.spec.ts')).toBe(true);
    re.lastIndex = 0;
    expect(re.test('/w/NoobIDE/tests/e2e/preview-isolation.spec.ts')).toBe(false);
  });

  it('CLI: check passes on the committed manifest and list prints each shard', () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { log: (l: string) => out.push(l), error: (l: string) => err.push(l) };
    expect(main(['check'], io)).toBe(0);
    expect(err).toEqual([]);
    expect(main(['list', '1/2'], io)).toBe(0);
    expect(main(['list', '2/2'], io)).toBe(0);
    expect(main(['list', '1/3'], io)).toBe(2);
    expect(err.at(-1)).toMatch(/defines 2 shards, not 3/);
    expect(main(['nonsense'], io)).toBe(2);
  });
});

// ── Part 2: the real Playwright test list on this OS ───────────────────────────────────────────────────────────────

interface Suite {
  suites?: Suite[];
  specs?: { id: string; file: string }[];
}

function collect(suite: Suite): string[] {
  return [...(suite.specs ?? []).map((s) => `${s.file}:${s.id}`), ...(suite.suites ?? []).flatMap(collect)];
}

/** `playwright test --list --reporter=json` for the whole suite or for the given positional file filters. */
function list(filters: string[] = []): string[] {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'noobide-shard-list-'));
  const report = path.join(temporary, 'report.json');
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'node_modules/@playwright/test/cli.js'),
        'test',
        '-c',
        'tests/e2e/playwright.config.ts',
        '--list',
        '--reporter=json',
        ...filters,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: report },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return collect(JSON.parse(readFileSync(report, 'utf8')) as Suite);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

describe(`${MANIFEST_RELATIVE} against the real Playwright test list`, () => {
  it('lists every existing spec file exactly once', () => {
    const manifest = loadManifest();
    const { unlisted, stale } = select(manifest, 1, listSpecFiles());
    expect(unlisted, `add ${unlisted.join(', ')} to ${MANIFEST_RELATIVE}`).toEqual([]);
    expect(stale, `remove ${stale.join(', ')} from ${MANIFEST_RELATIVE} (no such spec file)`).toEqual([]);
    expect(Object.keys(manifest.files).sort()).toEqual(listSpecFiles());
  });

  it('the two manifest shards cover every E2E test on this OS exactly once', () => {
    const manifest = loadManifest();
    const specFiles = listSpecFiles();
    const all = list();
    const first = list(playwrightFilters(select(manifest, 1, specFiles).files));
    const second = list(playwrightFilters(select(manifest, 2, specFiles).files));
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(all.length).toBeGreaterThan(100); // the whole suite was really listed (≈327 tests)
    expect(new Set([...first, ...second]).size).toBe(first.length + second.length);
    expect([...first, ...second].sort()).toEqual(all.sort());
  }, 360_000);
});
