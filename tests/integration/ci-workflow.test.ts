// S06.1 — structural checks of .github/workflows/ci.yml (ADR 0021). The repo has no YAML dependency and the
// workflow uses a plain block-style subset, so this test reads it line by line: top-level keys, the indented block
// under a key, and `- name:` steps. Actions themselves only run on GitHub (owner steps: MANUAL-CHECKS.md#S06.1).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(__dirname, '../../.github/workflows/ci.yml');
const text = readFileSync(FILE, 'utf8');
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
  const build = block('build', 2, jobs.start, jobs.start + 1 + jobs.body.length);
  const steps = block('steps', 4, build.start, build.start + 1 + build.body.length).body;
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

describe('ci.yml', () => {
  it('runs on push to main, pull requests and manual dispatch — never pull_request_target', () => {
    const on = block('on', 0).body.map((l) => l.trim());
    expect(on).toEqual(expect.arrayContaining(['push:', 'branches: [main]', 'pull_request:', 'workflow_dispatch:']));
    expect(text).not.toMatch(/pull_request_target/);
  });

  it('grants least privilege: only contents: read, no write scopes, no secrets', () => {
    expect(block('permissions', 0).body.map((l) => l.trim())).toEqual(['contents: read']);
    expect(text).not.toMatch(/:\s*write\b/);
    expect(text).not.toMatch(/write-all/);
    expect(text).not.toMatch(/secrets\./);
  });

  it('builds Windows x64 on windows-latest and Apple Silicon on macos-14, without fail-fast', () => {
    const strategy = block('strategy', 4).body.map((l) => l.trim());
    expect(strategy).toContain('fail-fast: false');
    expect(strategy).toContain('target: [windows-x64, macos-arm64]');
    expect(strategy).toContain('shard: [1, 2]');
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
    expect(block('build', 2).body.map((l) => l.trim())).toContain('runs-on: ${{ matrix.os }}');
  });

  it('runs install, verify, e2e, make and the architecture inspection in that order', () => {
    const runs = steps.filter((s) => s.run).map((s) => s.run);
    const order = [
      'npm ci',
      'npm run verify',
      'npm run test:e2e -- --shard=${{ matrix.shard }}/2',
      'npm run make -- --from-package',
      'node scripts/inspect-arch.mjs',
    ];
    const idx = order.map((cmd) => runs.indexOf(cmd));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    for (const s of steps.filter((x) => order.slice(0, 3).includes(x.run ?? ''))) expect(s.if).toBeUndefined();
    for (const s of steps.filter((x) => order.slice(3).includes(x.run ?? ''))) expect(s.if).toBe('matrix.shard == 1');
  });

  it('runs the fault suite (S26.2) on every matrix job, unconditionally, and uploads its report per target', () => {
    // One `build` job with a windows-x64 + macos-arm64 matrix (checked above): every step runs on both OSs.
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test:faults']).toBe('node scripts/faults.mjs');
    const faults = steps.findIndex((s) => s.run === 'npm run test:faults');
    expect(faults).toBeGreaterThan(steps.findIndex((s) => s.run === 'npm ci'));
    expect(steps[faults]?.if).toBeUndefined();
    const upload = steps.findIndex(
      (s) => s.uses?.startsWith('actions/upload-artifact@') && s.with.path === 'reports/faults/',
    );
    expect(upload).toBeGreaterThan(faults);
    // always(): the report of a failing run is the most useful one.
    expect(steps[upload]?.if).toBe('always()');
    expect(steps[upload]?.with).toMatchObject({
      name: 'fault-suite-${{ matrix.target }}-${{ matrix.shard }}',
      'if-no-files-found': 'error',
    });
  });

  it('checks the runner architecture against the matrix before building', () => {
    const check = steps.find((s) => s.name === 'Check runner architecture');
    expect(check?.env.EXPECTED_ARCH).toBe('${{ matrix.arch }}');
    expect(check?.run).toMatch(/process\.arch !== process\.env\.EXPECTED_ARCH/);
    expect(steps.indexOf(check!)).toBeLessThan(steps.findIndex((s) => s.run === 'npm ci'));
  });

  it('uses Node from .nvmrc with the npm cache and does not persist checkout credentials', () => {
    const node = steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(node?.with).toMatchObject({
      'node-version-file': '.nvmrc',
      cache: 'npm',
      architecture: '${{ matrix.arch }}',
    });
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with['persist-credentials']).toBe('false');
  });

  it('uploads the installers from out/make after make, failing when there are none', () => {
    const makeIdx = steps.findIndex((s) => s.run === 'npm run make -- --from-package');
    const upload = steps.findIndex(
      (s) => s.uses?.startsWith('actions/upload-artifact@') && s.with.path === 'out/make/',
    );
    expect(upload).toBeGreaterThan(makeIdx);
    expect(steps[upload]?.if).toBe('matrix.shard == 1');
    expect(steps[upload]?.with).toMatchObject({
      name: 'noobide-${{ matrix.target }}',
      'if-no-files-found': 'error',
    });
  });

  it('pins every action to a full 40-character commit SHA with a version comment', () => {
    const uses = text.split(/\r?\n/).filter((l) => /^\s*(-\s+)?uses:/.test(l));
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const l of uses) {
      expect(l).toMatch(/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+){0,2}$/);
    }
  });

  it('cancels stale runs and requires every matrix job at the aggregate gate', () => {
    expect(block('concurrency', 0).body.map((l) => l.trim())).toContain('cancel-in-progress: true');
    const gate = block('complete', 2).body.join('\n');
    expect(gate).toContain('if: always()');
    expect(gate).toContain('needs: build');
    expect(gate).toContain('name: ${{ matrix.target }}');
    expect(gate).toContain('target: [windows-x64, macos-arm64]');
    expect(gate).toContain('BUILD_RESULT: ${{ needs.build.result }}');
    expect(gate).toContain("process.env.BUILD_RESULT !== 'success'");
  });

  it('retains per-shard reports even on failure without artifact name collisions', () => {
    const report = steps.find((s) => s.name === 'Upload E2E timing report');
    expect(report?.if).toBe('always()');
    expect(report?.with.path).toBe('reports/e2e/');
    for (const s of steps.filter((s) => s.uses?.startsWith('actions/upload-artifact@'))) {
      expect(s.with.name).toContain('${{ matrix.target }}');
      if (s.if !== 'matrix.shard == 1') expect(s.with.name).toContain('${{ matrix.shard }}');
    }
  });
});
