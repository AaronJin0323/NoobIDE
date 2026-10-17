// S28.2 / S28.3 — structural checks of .github/workflows/release.yml (ADR 0027, docs/release/signing.md).
// The repo has no YAML dependency; like ci-workflow.test.ts this reads the block-style subset line by line. The
// workflow itself only runs on GitHub; the owner's dry run is described in docs/release/signing.md.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { SECRET_ROUTES, verifyWindowsFile, findSigntool } from '../../scripts/verify-signing.mjs';
import { checkReleaseTag } from '../../scripts/check-release-tag.mjs';

const ROOT = path.resolve(__dirname, '../..');
const text = readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
const raw = text.split(/\r?\n/);
const indentOf = (l: string) => l.length - l.trimStart().length;

interface Step {
  name: string;
  if?: string;
  uses?: string;
  run: string;
  shell?: string;
  env: Record<string, string>;
  with: Record<string, string>;
}

/** Steps of jobs.release: `- name:` items at indent 6, keys at 8, env/with entries at 10, `run: |` bodies. */
function parseSteps(): Step[] {
  const start = raw.findIndex((l) => l === '    steps:');
  const steps: Step[] = [];
  let section: 'env' | 'with' | 'run' | null = null;
  for (const l of raw.slice(start + 1)) {
    if (l.trim() === '' || l.trim().startsWith('#')) {
      if (section === 'run' && l.trim() !== '' && indentOf(l) > 8) steps.at(-1)!.run += `${l.trim()}\n`;
      continue;
    }
    const ind = indentOf(l);
    if (ind < 6) break;
    if (ind === 6 && l.trim().startsWith('- ')) {
      steps.push({ name: '', run: '', env: {}, with: {} });
      section = null;
    }
    const cur = steps.at(-1)!;
    if (section === 'run' && ind > 8) {
      cur.run += `${l.trim()}\n`;
      continue;
    }
    const m = /^(?:- )?([\w-]+):\s*(.*)$/.exec(l.trim());
    if (!m) continue;
    const [, k, v] = m as unknown as [string, string, string];
    if (ind <= 8) {
      section = k === 'env' || k === 'with' ? k : k === 'run' && v === '|' ? 'run' : null;
      if (k === 'name') cur.name = v;
      else if (k === 'if') cur.if = v;
      else if (k === 'uses') cur.uses = v;
      else if (k === 'shell') cur.shell = v;
      else if (k === 'run' && v !== '|') cur.run = v;
    } else if (section === 'env' || section === 'with') {
      cur[section][k] = v;
    }
  }
  return steps;
}

const steps = parseSteps();
const step = (name: string) => {
  const s = steps.find((x) => x.name === name);
  if (!s) throw new Error(`step ${name} missing`);
  return s;
};
const ALL_SECRETS = [
  ...SECRET_ROUTES.darwin.certificate,
  ...Object.values(SECRET_ROUTES.darwin.notarize).flat(),
  ...Object.values(SECRET_ROUTES.win32.routes).flat(),
];

describe('release.yml', () => {
  it('runs on version tags and manual dispatch only, with read-only permissions, in the "release" environment', () => {
    const on = raw.slice(raw.indexOf('on:') + 1, raw.indexOf('permissions:')).map((l) => l.trim());
    expect(on.filter(Boolean)).toEqual(['push:', "tags: ['v*']", 'workflow_dispatch:']);
    expect(text).not.toMatch(/pull_request/);
    const perms = raw.slice(raw.indexOf('permissions:') + 1, raw.indexOf('permissions:') + 3).map((l) => l.trim());
    expect(perms).toEqual(['contents: read', '']);
    expect(text.split('\n  deliver:')[0]).not.toMatch(/:\s*write\b|write-all/);
    expect(raw).toContain('    environment: release');
  });

  it('builds the same two targets as CI on their own OS', () => {
    const i = raw.indexOf('        include:');
    expect(raw.slice(i + 1, i + 7).map((l) => l.trim())).toEqual([
      '- target: windows-x64',
      'os: windows-latest',
      'arch: x64',
      '- target: macos-arm64',
      'os: macos-14',
      'arch: arm64',
    ]);
  });

  it('orders verify → signing status → import/prepare → make → arch → verify signatures → upload → cleanup', () => {
    const order = [
      'Checkout',
      'Check tag matches package.json version',
      'Install dependencies',
      'Verify (harness, typecheck, lint, format, unit and integration tests)',
      'End-to-end tests (Playwright + Electron)',
      'Signing status',
      'Import macOS signing certificate',
      'Prepare Windows signing',
      'Make installers',
      'Inspect binary architectures',
      'Verify signatures',
      'Upload installers',
      'Remove signing material',
    ];
    const idx = order.map((n) => steps.findIndex((s) => s.name === n));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(steps.at(-1)?.name).toBe('Remove signing material');
  });

  it('checks the tag against package.json version right after checkout, before anything is built', () => {
    const s = step('Check tag matches package.json version');
    expect(steps.indexOf(s)).toBe(steps.findIndex((x) => x.name === 'Checkout') + 1);
    expect(steps.indexOf(s)).toBeLessThan(steps.findIndex((x) => x.name === 'Make installers'));
    expect(s.if).toBeUndefined();
    expect(s.run).toBe('node scripts/check-release-tag.mjs');
    // The ref reaches the script only through env, never interpolated into the run line.
    expect(s.env).toEqual({ REF_TYPE: '${{ github.ref_type }}', REF_NAME: '${{ github.ref_name }}' });
  });

  it('the tag check passes only for v + package.json version on tag builds', () => {
    const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(checkReleaseTag({ refType: 'tag', refName: `v${version}`, version }).ok).toBe(true);
    expect(checkReleaseTag({ refType: 'tag', refName: 'v1.0.0', version: '0.0.0' }).ok).toBe(false);
    expect(checkReleaseTag({ refType: 'tag', refName: '1.0.0', version: '1.0.0' }).ok).toBe(false);
    expect(checkReleaseTag({ refType: 'tag', refName: 'v1.0.0-rc', version: '1.0.0' }).ok).toBe(false);
    expect(checkReleaseTag({ refType: 'tag', refName: 'v1.0.0', version: '' }).ok).toBe(false);
    // A manual dry run on a branch (docs/release/signing.md) is not a release build.
    expect(checkReleaseTag({ refType: 'branch', refName: 'main', version: '0.0.0' }).ok).toBe(true);
    // The CLI as the workflow runs it.
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, [path.join(ROOT, 'scripts/check-release-tag.mjs')], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
      });
    const bad = run({ REF_TYPE: 'tag', REF_NAME: 'v999.0.0' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/::error::check-release-tag: tag "v999\.0\.0" does not match/);
    expect(run({ REF_TYPE: 'tag', REF_NAME: `v${version}` }).status).toBe(0);
    const dispatch = run({ REF_TYPE: 'branch', REF_NAME: 'main' });
    expect(dispatch.status).toBe(0);
    expect(dispatch.stdout).toMatch(/^::notice::/);
  });

  it('signing status sees only booleans for every secret of every route', () => {
    const s = step('Signing status');
    expect(s.run).toBe('node scripts/verify-signing.mjs --status');
    expect(Object.keys(s.env).sort()).toEqual(ALL_SECRETS.map((n) => `HAS_${n}`).sort());
    for (const [k, v] of Object.entries(s.env)) expect(v).toBe(`\${{ secrets.${k.slice(4)} != '' }}`);
  });

  it('credential steps run only when signing is enabled on their OS; make and verification always run', () => {
    expect(step('Import macOS signing certificate').if).toBe(
      "runner.os == 'macOS' && steps.signing.outputs.enabled == 'true'",
    );
    expect(step('Prepare Windows signing').if).toBe(
      "runner.os == 'Windows' && steps.signing.outputs.enabled == 'true'",
    );
    for (const n of ['Make installers', 'Inspect binary architectures', 'Verify signatures', 'Upload installers']) {
      expect(step(n).if).toBeUndefined();
    }
    expect(step('Make installers').run).toBe('npm run make');
    expect(step('Verify signatures').run).toBe('node scripts/verify-signing.mjs');
    expect(step('Verify signatures').env.SIGNING_ENABLED).toBe('${{ steps.signing.outputs.enabled }}');
    expect(step('Remove signing material').if).toBe('always()');
  });

  it('secrets appear only as step env values, never in a run script, and only names the docs list', () => {
    const doc = readFileSync(path.join(ROOT, 'docs/release/signing.md'), 'utf8');
    const used = new Set<string>();
    for (const s of steps) {
      expect(s.run).not.toMatch(/secrets\./);
      expect(s.run).not.toMatch(/set -x|Set-PSDebug|DEBUG=/);
      for (const v of Object.values(s.env)) for (const m of v.matchAll(/secrets\.(\w+)/g)) used.add(m[1]!);
      for (const v of Object.values(s.with)) expect(v).not.toMatch(/secrets\./);
    }
    expect([...used].sort()).toEqual([...ALL_SECRETS].sort());
    for (const n of used) expect(doc).toContain(`\`${n}\``);
    // Only the documented steps receive secret values.
    const withSecrets = steps.filter((s) => Object.values(s.env).some((v) => /secrets\.\w+ }}$/.test(v)));
    expect(withSecrets.map((s) => s.name)).toEqual([
      'Import macOS signing certificate',
      'Prepare Windows signing',
      'Make installers',
      'Verify signatures',
    ]);
  });

  it('keeps key material in RUNNER_TEMP, a random-password temporary keychain, and removes it', () => {
    const mac = step('Import macOS signing certificate').run;
    expect(mac).toMatch(/openssl rand -base64 32/);
    expect(mac).toMatch(/::add-mask::\$keychain_password/);
    expect(mac).toMatch(/rm -f "\$RUNNER_TEMP\/noobide-signing\.p12"/);
    expect(mac).toMatch(/Developer ID Application/);
    const cleanup = step('Remove signing material').run;
    for (const f of ['noobide-signing.keychain-db', 'AuthKey.p8', 'noobide-signing.p12', 'noobide-signing.pfx']) {
      expect(cleanup).toContain(f);
    }
    const win = step('Prepare Windows signing').run;
    expect(win).toMatch(/Get-AuthenticodeSignature/);
    expect(win).toMatch(/Microsoft\.ArtifactSigning\.Client\/\$env:ARTIFACT_SIGNING_CLIENT_VERSION/);
  });

  it('pins every action to a full commit SHA with a version comment', () => {
    const uses = raw.filter((l) => /^\s*(-\s+)?uses:/.test(l));
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const l of uses) expect(l).toMatch(/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+){0,2}$/);
  });

  it('delivers tags only after both builds pass, with write permission confined to delivery', () => {
    const delivery = text.split('\n  deliver:')[1]!;
    expect(delivery).toContain('needs: release');
    expect(delivery).toContain("if: github.ref_type == 'tag'");
    expect(delivery).not.toContain('always()');
    expect(delivery).toContain('contents: write');
    expect(delivery).toContain('actions: read');
    expect(delivery).toContain('RUN_ID: ${{ github.run_id }}');
    expect(delivery).toContain('gh run download "$RUN_ID"');
    expect(delivery).toContain('node scripts/deliver-release.mjs');
    expect(delivery).not.toContain('secrets.');
    expect(step('End-to-end tests (Playwright + Electron)').if).toBeUndefined();
    expect(step('End-to-end tests (Playwright + Electron)').run).toBe('npm run test:e2e');
  });

  it('the bash blocks parse (bash -n)', () => {
    const bash = os.platform() === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
    if (!existsSync(bash)) return;
    for (const s of steps.filter((x) => x.shell === 'bash')) {
      // The parser trims indentation, which bash does not need; bash -n reads the script from stdin.
      const r = spawnSync(bash, ['-n'], { input: s.run, encoding: 'utf8' });
      expect(r.status, `${s.name}: ${r.stderr}`).toBe(0);
    }
  });
});

// Real signtool on a Windows machine with the SDK (the dev machine; CI runners have it too): a Microsoft-signed
// binary passes and an unsigned one fails, so the output parsing is checked against the real tool, not only mocks.
const signtool = os.platform() === 'win32' ? findSigntool() : '';
// signtool builds and checks the certificate chains (revocation data may be fetched over the network) and the runner may
// be descheduled: 18 s was seen on a hosted Windows runner (run 39033368439). A correctness check, not a speed check.
describe.runIf(signtool !== '' && existsSync(signtool))(
  'verify-signing against the real signtool',
  { timeout: 60_000 },
  () => {
    it('passes signtool.exe itself (Microsoft-signed, timestamped)', () => {
      const r = verifyWindowsFile(signtool, { signtool });
      expect(r.ok, JSON.stringify(r.checks)).toBe(true);
    });
    it('fails an unsigned PE file', () => {
      const unsigned = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
      if (!existsSync(unsigned)) return;
      const r = verifyWindowsFile(unsigned, { signtool });
      if (r.checks[0]?.ok) return; // a future Electron may ship a signed electron.exe; nothing to assert then
      expect(r.ok).toBe(false);
      expect(r.checks[0]?.detail).toMatch(/SignTool Error: No signature found/);
    });
  },
);
