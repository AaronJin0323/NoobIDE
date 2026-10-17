// S50.3 — structural checks of .github/workflows/perf.yml (ADR 0038), in the style of ci-workflow.test.ts: the repo
// has no YAML dependency and the workflow uses a plain block-style subset, so this reads it line by line. The
// workflow itself only runs on GitHub (owner steps: MANUAL-CHECKS.md#S50.3).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const FILE = path.join(ROOT, '.github/workflows/perf.yml');
const text = readFileSync(FILE, 'utf8');
const ciText = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
const indentOf = (l: string) => l.length - l.trimStart().length;

/** Lines of the block under the first `key:` line found at `indent` after line `from` (exclusive of the key line). */
function block(key: string, indent: number, from = 0, until = lines.length): { start: number; body: string[] } {
  const start = lines.findIndex(
    (l, i) => i >= from && i < until && indentOf(l) === indent && l.trim().startsWith(`${key}:`),
  );
  if (start < 0) throw new Error(`key ${key} not found at indent ${indent}`);
  let end = start + 1;
  while (end < until && indentOf(lines[end]!) > indent) end++;
  return { start, body: lines.slice(start + 1, end) };
}

interface Step {
  name: string;
  uses?: string;
  run?: string;
  if?: string;
  with: Record<string, string>;
  env: Record<string, string>;
}

function parseSteps(): Step[] {
  const jobs = block('jobs', 0);
  const job = block('perf', 2, jobs.start, jobs.start + 1 + jobs.body.length);
  const steps = block('steps', 4, job.start, job.start + 1 + job.body.length).body;
  const out: Step[] = [];
  let section: 'with' | 'env' | null = null;
  for (const l of steps) {
    const t = l.trim();
    if (t.startsWith('- ')) {
      out.push({ name: '', with: {}, env: {} });
      section = null;
    }
    const cur = out[out.length - 1]!;
    const kv = t.replace(/^- /, '');
    const m = /^([\w-]+):\s*(.*)$/.exec(kv);
    if (!m) continue;
    const [, k, v] = m as unknown as [string, string, string];
    if (indentOf(l) <= 8 || t.startsWith('- ')) {
      section = k === 'with' || k === 'env' ? k : null;
      if (k === 'name') cur.name = v;
      else if (k === 'uses') cur.uses = v;
      else if (k === 'run') cur.run = v;
      else if (k === 'if') cur.if = v;
    } else if (section) {
      cur[section][k] = v;
    }
  }
  return out;
}

const steps = parseSteps();
const usesOf = (yaml: string) =>
  yaml
    .split(/\r?\n/)
    .filter((l) => /^\s*(-\s+)?uses:/.test(l))
    .map((l) => l.trim().replace(/^-\s+/, ''));

describe('perf.yml', () => {
  it('runs on push to main, nightly and manual dispatch — never for pull requests, so it cannot be a required check', () => {
    const on = block('on', 0).body.map((l) => l.trim());
    expect(on).toEqual(expect.arrayContaining(['push:', 'branches: [main]', 'schedule:', 'workflow_dispatch:']));
    expect(on.some((l) => /^- cron: '\d+ \d+ \* \* \*'$/.test(l))).toBe(true);
    expect(text).not.toMatch(/pull_request/);
  });

  it('grants least privilege: only contents: read, no write scopes, no secrets', () => {
    expect(block('permissions', 0).body.map((l) => l.trim())).toEqual(['contents: read']);
    expect(text).not.toMatch(/:\s*write\b/);
    expect(text).not.toMatch(/write-all/);
    expect(text).not.toMatch(/secrets\./);
  });

  it('measures Windows x64 on windows-latest and Apple Silicon on macos-14, without fail-fast', () => {
    const strategy = block('strategy', 4).body.map((l) => l.trim());
    expect(strategy).toContain('fail-fast: false');
    expect(strategy).toContain('target: [windows-x64, macos-arm64]');
    const include = strategy.slice(strategy.indexOf('include:') + 1).join('\n');
    expect(include).toBe(
      [
        '- target: windows-x64',
        'os: windows-latest',
        'arch: x64',
        '- target: macos-arm64',
        'os: macos-14',
        'arch: arm64',
      ].join('\n'),
    );
    expect(block('perf', 2).body.map((l) => l.trim())).toContain('runs-on: ${{ matrix.os }}');
  });

  it('installs, runs test:perf and uploads reports/perf per target, even when the budgets fail', () => {
    const runs = steps.filter((s) => s.run).map((s) => s.run);
    const order = ['npm ci', 'npm run test:perf'];
    const idx = order.map((cmd) => runs.indexOf(cmd));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    for (const s of steps.filter((x) => order.includes(x.run ?? ''))) expect(s.if).toBeUndefined();
    const perf = steps.findIndex((s) => s.run === 'npm run test:perf');
    const upload = steps.findIndex(
      (s) => s.uses?.startsWith('actions/upload-artifact@') && s.with.path === 'reports/perf/',
    );
    expect(upload).toBeGreaterThan(perf);
    expect(steps[upload]?.if).toBe('always()');
    expect(steps[upload]?.with).toMatchObject({
      name: 'perf-report-${{ matrix.target }}',
      'if-no-files-found': 'error',
    });
    // The report is written by the budget helper, which the perf project's global setup resets per run.
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test:perf']).toBe('vitest run --config vitest.perf.config.ts');
  });

  it('checks the runner architecture against the matrix and uses Node from .nvmrc with the npm cache', () => {
    const check = steps.find((s) => s.name === 'Check runner architecture');
    expect(check?.env.EXPECTED_ARCH).toBe('${{ matrix.arch }}');
    expect(check?.run).toMatch(/process\.arch !== process\.env\.EXPECTED_ARCH/);
    expect(steps.indexOf(check!)).toBeLessThan(steps.findIndex((s) => s.run === 'npm ci'));
    const node = steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(node?.with).toMatchObject({
      'node-version-file': '.nvmrc',
      cache: 'npm',
      architecture: '${{ matrix.arch }}',
    });
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with['persist-credentials']).toBe('false');
  });

  it('pins every action to the same full commit SHA as ci.yml', () => {
    const uses = usesOf(text);
    expect(uses.length).toBeGreaterThanOrEqual(3);
    const ci = new Set(usesOf(ciText));
    for (const u of uses) {
      expect(u).toMatch(/^uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+){0,2}$/);
      expect(ci.has(u), `${u} is not pinned the same way in ci.yml`).toBe(true);
    }
  });

  it('skips the Electron download because no perf test imports electron', () => {
    const install = steps.find((s) => s.run === 'npm ci');
    expect(install?.env.ELECTRON_SKIP_BINARY_DOWNLOAD).toBe('1');
    const perfDir = path.join(ROOT, 'tests/perf');
    for (const f of readdirSync(perfDir).filter((f) => f.endsWith('.ts'))) {
      expect(readFileSync(path.join(perfDir, f), 'utf8'), f).not.toMatch(/from 'electron'/);
    }
  });

  it('keeps the perf project out of the default test run (ci.yml runs npm test without a budget assertion)', () => {
    const perfConfig = readFileSync(path.join(ROOT, 'vitest.perf.config.ts'), 'utf8');
    expect(perfConfig).toContain("include: ['tests/perf/**/*.perf.test.ts']");
    expect(perfConfig).toContain('fileParallelism: false');
    const defaultConfig = readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf8');
    expect(defaultConfig).toContain("'**/*.perf.test.ts'");
    expect(defaultConfig).toContain("'tests/perf/**'");
    expect(ciText).not.toMatch(/test:perf/);
    expect(ciText).toMatch(/npm run verify|npm test/);
  });
});
