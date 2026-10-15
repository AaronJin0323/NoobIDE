// S26.2 — scripts/faults.mjs: the per-platform fault suite report CI uploads. The script must fail when a fault test
// fails or is skipped on a platform without a written reason, so "the suite ran on both OS jobs" cannot hide a
// silently skipped case. The CI wiring itself is checked in ci-workflow.test.ts.
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/faults.mjs');

interface Result {
  ok: boolean;
  problems: string[];
  skipped: { name: string; reason: string | null }[];
}
interface FaultsModule {
  FAULT_SUITE: string[];
  SKIP_POLICY: { match: RegExp; platforms: string[]; reason: string }[];
  evaluate(report: unknown, host: { platform: string; isRoot?: boolean }): Result;
  summarize(result: Result, target: string): string;
}
const faults = (await import(pathToFileURL(SCRIPT).href)) as FaultsModule;

const READ_ONLY = 'save faults read-only folder on the real file system (POSIX) → permission-denied, edits kept';
const TCC = 'macOS privacy protection (TCC), simulated opening a project in Documents explains the privacy setting';

function report(tests: [name: string, status: string][]) {
  return {
    testResults: [
      {
        name: path.join(ROOT, 'tests/integration/faults/save-faults.test.ts'),
        status: tests.some(([, s]) => s === 'failed') ? 'failed' : 'passed',
        assertionResults: tests.map(([fullName, status]) => ({ fullName, status })),
      },
    ],
  };
}

describe('fault suite report (S26.2)', () => {
  it('covers every file of the fault suite', () => {
    const dir = path.join(ROOT, 'tests/integration/faults');
    const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(faults.FAULT_SUITE).toContain('tests/integration/faults');
    expect(faults.FAULT_SUITE).toContain('tests/integration/protected-folder.test.ts');
  });

  it('passes when everything ran and passed', () => {
    const r = faults.evaluate(
      report([
        ['a', 'passed'],
        [READ_ONLY, 'passed'],
      ]),
      { platform: 'darwin' },
    );
    expect(r).toMatchObject({ ok: true, problems: [] });
  });

  it('fails on a failed test', () => {
    const r = faults.evaluate(report([['a', 'failed']]), { platform: 'linux' });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/^failed: a/);
  });

  it('fails when no test ran', () => {
    expect(faults.evaluate({ testResults: [] }, { platform: 'win32' }).problems).toEqual(['no fault test ran']);
  });

  it('accepts the documented Windows skips with their reason, and nothing else', () => {
    const win = faults.evaluate(
      report([
        [READ_ONLY, 'skipped'],
        [TCC, 'skipped'],
      ]),
      { platform: 'win32' },
    );
    expect(win.ok).toBe(true);
    expect(win.skipped.every((s) => typeof s.reason === 'string' && s.reason.length > 20)).toBe(true);
    expect(faults.summarize(win, 'win32-x64')).toMatch(/Skipped on this platform[\s\S]*NTFS uses ACLs/);
  });

  it('fails when a test is skipped on a platform its policy does not name (silent skip on macOS)', () => {
    for (const name of [READ_ONLY, TCC]) {
      const mac = faults.evaluate(report([[name, 'skipped']]), { platform: 'darwin' });
      expect(mac.ok).toBe(false);
      expect(mac.problems[0]).toMatch(/skipped without a SKIP_POLICY entry for darwin/);
    }
  });

  it('fails on an unlisted skip or todo anywhere (it.skip / it.todo added to a fault test)', () => {
    for (const status of ['skipped', 'pending', 'todo']) {
      const r = faults.evaluate(report([['save faults ENOSPC', status]]), { platform: 'win32' });
      expect(r.ok).toBe(false);
    }
  });

  it('accepts the POSIX read-only test skipping itself only when the runner is root', () => {
    expect(faults.evaluate(report([[READ_ONLY, 'skipped']]), { platform: 'linux', isRoot: true }).ok).toBe(true);
    expect(faults.evaluate(report([[READ_ONLY, 'skipped']]), { platform: 'linux', isRoot: false }).ok).toBe(false);
  });

  it('every skip policy entry names a platform, a reason and a real test', async () => {
    for (const rule of faults.SKIP_POLICY) {
      expect(rule.platforms.length).toBeGreaterThan(0);
      expect(rule.reason.length).toBeGreaterThan(40);
    }
    // The policy names real tests: a renamed test would otherwise turn its expected skip into a failure on Windows.
    const { readFileSync } = await import('node:fs');
    const src = (f: string) => readFileSync(path.join(ROOT, 'tests/integration', f), 'utf8');
    expect(src('faults/save-faults.test.ts')).toContain('read-only folder on the real file system (POSIX)');
    expect(src('protected-folder.test.ts')).toContain("'macOS privacy protection (TCC), simulated'");
  });
});
