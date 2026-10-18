// S06.1 — structural checks of .github/workflows/ci.yml (ADR 0021). The repo has no YAML dependency and the
// workflow uses a plain block-style subset, so this test reads it line by line: top-level keys, the indented block
// under a key, and `- name:` steps. Actions themselves only run on GitHub (owner steps: MANUAL-CHECKS.md#S06.1).
// S58.1 — the `changes` / `static` / `build` / `complete` jobs, their conditions and the gate rule
// (docs/ci/ci-stability-and-speed-plan.md §4; owner steps: MANUAL-CHECKS.md#S58.1).
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const FILE = path.resolve(ROOT, '.github/workflows/ci.yml');
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
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with: Record<string, string>;
  env: Record<string, string>;
}

/** The job block under `jobs:` (its body lines, trimmed) and the `key: value` pairs at the job's own level. */
function job(name: string): { body: string[]; keys: Record<string, string>; start: number; end: number } {
  const jobs = block('jobs', 0);
  const j = block(name, 2, jobs.start, jobs.start + 1 + jobs.body.length);
  const keys: Record<string, string> = {};
  for (const l of j.body) {
    if (indentOf(l) !== 4) continue;
    const m = /^([\w-]+):\s*(.*)$/.exec(l.trim());
    if (m) keys[m[1]!] = m[2]!;
  }
  return { body: j.body.map((l) => l.trim()), keys, start: j.start, end: j.start + 1 + j.body.length };
}

function parseSteps(jobName: string): Step[] {
  const j = job(jobName);
  const steps = block('steps', 4, j.start, j.end).body;
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
      else if (k === 'id') cur.id = v;
      else if (k === 'uses') cur.uses = v;
      else if (k === 'run') cur.run = v;
      else if (k === 'if') cur.if = v;
    } else if (section) {
      cur[section][k] = v;
    }
  }
  return out;
}

const steps = parseSteps('build');
const changesSteps = parseSteps('changes');
const staticSteps = parseSteps('static');
const gateSteps = parseSteps('complete');

const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
const SETUP_NODE = 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0';
const UPLOAD = 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2';
const BUILD_IF =
  "needs.changes.outputs.kind == 'code' && (github.event_name != 'pull_request' || github.event.pull_request.draft == false)";
const MAIN_ONLY = "matrix.shard == 1 && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')";
const GATE_IF = "always() && !(github.event_name == 'pull_request' && github.event.pull_request.draft == true)";

describe('ci.yml', () => {
  it('runs on push to main, pull requests (including ready_for_review) and manual dispatch — never pull_request_target', () => {
    const on = block('on', 0).body.map((l) => l.trim());
    expect(on).toEqual(expect.arrayContaining(['push:', 'branches: [main]', 'pull_request:', 'workflow_dispatch:']));
    // The default pull_request types omit ready_for_review: without it a draft marked ready never runs the matrix.
    expect(on).toContain('types: [opened, synchronize, reopened, ready_for_review]');
    expect(text).not.toMatch(/pull_request_target/);
  });

  it('grants least privilege: only contents: read, no write scopes, no secrets', () => {
    expect(block('permissions', 0).body.map((l) => l.trim())).toEqual(['contents: read']);
    expect(text).not.toMatch(/:\s*write\b/);
    expect(text).not.toMatch(/write-all/);
    expect(text).not.toMatch(/secrets\./);
    // The gate jobs need nothing at all from the token.
    expect(job('complete').keys['permissions']).toBe('{}');
  });

  it('has exactly the four jobs changes, static, build and complete', () => {
    const jobs = block('jobs', 0)
      .body.filter((l) => indentOf(l) === 2)
      .map((l) => l.trim().replace(/:$/, ''));
    expect(jobs).toEqual(['changes', 'static', 'build', 'complete']);
  });

  it('builds Windows x64 on windows-latest and Apple Silicon on macos-14, without fail-fast', () => {
    const b = job('build');
    const strategy = block('strategy', 4, b.start, b.end).body.map((l) => l.trim());
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
    expect(b.keys['runs-on']).toBe('${{ matrix.os }}');
  });

  describe('changes job (S58.1)', () => {
    it('runs on ubuntu with the full history and exposes the classifier result as output kind', () => {
      const c = job('changes');
      expect(c.keys['runs-on']).toBe('ubuntu-latest');
      expect(c.keys['needs']).toBeUndefined();
      expect(c.keys['if']).toBeUndefined();
      expect(c.body).toContain('kind: ${{ steps.classify.outputs.kind }}');
      const checkout = changesSteps.find((s) => s.uses?.startsWith('actions/checkout@'));
      expect(checkout?.uses).toBe(CHECKOUT);
      expect(checkout?.with).toMatchObject({ 'fetch-depth': '0', 'persist-credentials': 'false' });
    });

    it('classifies with the in-repo script against the PR base or the previous head of the push', () => {
      const classify = changesSteps.find((s) => s.run === 'node scripts/ci-changes.mjs');
      expect(classify?.id).toBe('classify');
      expect(classify?.if).toBeUndefined();
      expect(classify?.env).toEqual({
        CI_BASE_SHA: '${{ github.event.pull_request.base.sha }}',
        CI_BEFORE_SHA: '${{ github.event.before }}',
      });
      expect(existsSync(path.join(ROOT, 'scripts/ci-changes.mjs'))).toBe(true);
      // No third-party path-filter action, no Node setup needed (ubuntu-latest ships a Node ≥ 20 runtime).
      expect(changesSteps.filter((s) => s.uses).map((s) => s.uses)).toEqual([CHECKOUT]);
    });
  });

  describe('static job (S58.1)', () => {
    it('runs the platform-independent gates once on ubuntu for every push, unconditionally', () => {
      const s = job('static');
      expect(s.keys['runs-on']).toBe('ubuntu-latest');
      expect(s.keys['needs']).toBeUndefined();
      expect(s.keys['if']).toBeUndefined();
      for (const step of staticSteps) expect(step.if).toBeUndefined();
      const runs = staticSteps.filter((x) => x.run).map((x) => x.run);
      expect(runs).toEqual([
        'npm ci',
        'node harness/session.mjs check',
        'npm run typecheck',
        'npm run lint',
        'npm run format:check',
        'npx vitest run tests/integration/ci-workflow.test.ts tests/integration/ci-changes.test.ts tests/integration/release-workflow.test.ts tests/integration/timing-budgets.test.ts',
      ]);
    });

    it('runs only workflow tests that exist and need no Playwright or Electron binary', () => {
      const vitest = staticSteps.find((x) => x.run?.startsWith('npx vitest run'))!;
      const files = vitest.run!.replace('npx vitest run ', '').split(' ');
      for (const f of files) {
        expect(existsSync(path.join(ROOT, f))).toBe(true);
        const src = readFileSync(path.join(ROOT, f), 'utf8');
        // Real import lines only (this file's own comments mention both names).
        expect(src).not.toMatch(/^import .* from '(@playwright\/test|playwright|electron)';$/m);
      }
      // e2e-shards needs Playwright on the target OS: it stays in `npm test` on the matrix.
      expect(files).not.toContain('tests/integration/e2e-shards.test.ts');
      const install = staticSteps.find((x) => x.run === 'npm ci');
      expect(install?.env.ELECTRON_SKIP_BINARY_DOWNLOAD).toBe('1');
    });

    it('uses the same pinned checkout and setup-node as the matrix, with the npm cache', () => {
      const checkout = staticSteps.find((x) => x.uses?.startsWith('actions/checkout@'));
      expect(checkout?.uses).toBe(CHECKOUT);
      expect(checkout?.with['persist-credentials']).toBe('false');
      const node = staticSteps.find((x) => x.uses?.startsWith('actions/setup-node@'));
      expect(node?.uses).toBe(SETUP_NODE);
      expect(node?.with).toMatchObject({ 'node-version-file': '.nvmrc', cache: 'npm' });
    });
  });

  it('runs the matrix only for code changes on non-draft PRs, pushes to main and workflow_dispatch', () => {
    const b = job('build');
    expect(b.keys['needs']).toBe('[changes]');
    expect(b.keys['if']).toBe(BUILD_IF);
  });

  it('runs install, harness check, tests, e2e, make and the architecture inspection in that order', () => {
    const runs = steps.filter((s) => s.run).map((s) => s.run);
    const order = [
      'npm ci',
      'node harness/session.mjs check',
      'npm test',
      'npm run test:e2e -- --shard=${{ matrix.shard }}/2',
      'npm run make -- --from-package',
      'node scripts/inspect-arch.mjs',
    ];
    const idx = order.map((cmd) => runs.indexOf(cmd));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    for (const s of steps.filter((x) => order.slice(0, 4).includes(x.run ?? ''))) expect(s.if).toBeUndefined();
    for (const s of steps.filter((x) => order.slice(4).includes(x.run ?? ''))) expect(s.if).toBe(MAIN_ONLY);
  });

  it('does not repeat the static gates on the OS jobs', () => {
    // typecheck, lint and format:check are proved once by `static`; `verify` (even --quick) would rerun typecheck.
    const runs = steps.map((s) => s.run ?? '');
    for (const dup of ['npm run verify', 'npm run typecheck', 'npm run lint', 'npm run format:check']) {
      expect(runs.some((r) => r.startsWith(dup))).toBe(false);
    }
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

  it('makes, inspects and uploads installers only on push to main and workflow_dispatch (S58.1)', () => {
    const makeIdx = steps.findIndex((s) => s.run === 'npm run make -- --from-package');
    const inspect = steps.find((s) => s.run === 'node scripts/inspect-arch.mjs');
    const upload = steps.findIndex(
      (s) => s.uses?.startsWith('actions/upload-artifact@') && s.with.path === 'out/make/',
    );
    expect(upload).toBeGreaterThan(makeIdx);
    expect(steps[makeIdx]?.if).toBe(MAIN_ONLY);
    expect(inspect?.if).toBe(MAIN_ONLY);
    expect(steps[upload]?.if).toBe(MAIN_ONLY);
    expect(steps[upload]?.with).toMatchObject({
      name: 'noobide-${{ matrix.target }}',
      'if-no-files-found': 'error',
    });
    // The E2E step still needs the packaged app, so no PR-only skip reaches it.
    expect(steps.find((s) => s.run?.startsWith('npm run test:e2e'))?.if).toBeUndefined();
  });

  it('pins every action to a full 40-character commit SHA with a version comment, reusing the same three pins', () => {
    const uses = text.split(/\r?\n/).filter((l) => /^\s*(-\s+)?uses:/.test(l));
    expect(uses.length).toBeGreaterThanOrEqual(6);
    for (const l of uses) {
      expect(l).toMatch(/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+){0,2}$/);
    }
    const distinct = new Set(
      uses.map((l) =>
        l
          .trim()
          .replace(/^-\s+uses:\s+/, '')
          .replace(/^uses:\s+/, ''),
      ),
    );
    expect([...distinct].sort()).toEqual([CHECKOUT, SETUP_NODE, UPLOAD].sort());
  });

  describe('aggregate gates (S58.1)', () => {
    const gate = job('complete');
    const run = gateSteps[0]!.run!;
    const code = /^node -e "(.*)"$/.exec(run)?.[1];

    it('keep the required check names and depend on changes, static and build', () => {
      expect(block('concurrency', 0).body.map((l) => l.trim())).toContain('cancel-in-progress: true');
      expect(gate.keys['name']).toBe('${{ matrix.target }}');
      expect(gate.keys['needs']).toBe('[changes, static, build]');
      expect(gate.keys['if']).toBe(GATE_IF);
      expect(gate.keys['runs-on']).toBe('ubuntu-latest');
      expect(gate.body).toContain('fail-fast: false');
      expect(gate.body).toContain('target: [windows-x64, macos-arm64]');
      expect(gateSteps).toHaveLength(1);
      expect(gateSteps[0]!.env).toEqual({
        CHANGES_RESULT: '${{ needs.changes.result }}',
        CHANGES_KIND: '${{ needs.changes.outputs.kind }}',
        STATIC_RESULT: '${{ needs.static.result }}',
        BUILD_RESULT: '${{ needs.build.result }}',
      });
      expect(code).toBeDefined();
    });

    // Run the inline expression itself with every combination that matters, so the rule is proved, not read.
    const cases: [string, string, string, string, boolean][] = [
      // changes, kind, static, build → passes?
      ['success', 'code', 'success', 'success', true],
      ['success', 'docs-only', 'success', 'skipped', true],
      ['success', 'code', 'success', 'skipped', false], // draft PR or a skipped matrix on a code change
      ['success', 'code', 'success', 'failure', false],
      ['success', 'code', 'success', 'cancelled', false],
      ['success', 'code', 'failure', 'success', false],
      ['success', 'code', 'cancelled', 'success', false],
      ['success', 'docs-only', 'failure', 'skipped', false],
      ['success', 'docs-only', 'success', 'failure', false],
      ['failure', '', 'success', 'skipped', false],
      ['cancelled', '', 'cancelled', 'skipped', false],
      ['skipped', '', 'success', 'skipped', false],
      ['success', '', 'success', 'skipped', false],
    ];
    it.each(cases)('changes=%s kind=%s static=%s build=%s → pass=%s', (changes, kind, stat, build, pass) => {
      const r = spawnSync(process.execPath, ['-e', code!], {
        encoding: 'utf8',
        env: {
          ...process.env,
          CHANGES_RESULT: changes,
          CHANGES_KIND: kind,
          STATIC_RESULT: stat,
          BUILD_RESULT: build,
        },
      });
      expect(r.status, r.stdout + r.stderr).toBe(pass ? 0 : 1);
    });
  });

  it('retains per-shard reports even on failure without artifact name collisions', () => {
    const report = steps.find((s) => s.name === 'Upload E2E timing report');
    // Also after a failing E2E step, but not when an earlier failure skipped it (no report: a second, misleading error).
    const e2e = steps.find((s) => s.run?.startsWith('npm run test:e2e'));
    expect(e2e?.id).toBe('e2e');
    expect(report?.if).toBe("always() && steps.e2e.outcome != 'skipped'");
    expect(report?.with.path).toBe('reports/e2e/');
    expect(report?.with['if-no-files-found']).toBe('error');
    for (const s of steps.filter((s) => s.uses?.startsWith('actions/upload-artifact@'))) {
      expect(s.with.name).toContain('${{ matrix.target }}');
      if (!s.if?.startsWith('matrix.shard == 1')) expect(s.with.name).toContain('${{ matrix.shard }}');
    }
  });
});
