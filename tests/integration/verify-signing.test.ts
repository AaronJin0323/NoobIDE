// S28.2 / S28.3 — scripts/verify-signing.mjs with mocked spctl / stapler / signtool output (ADR 0027).
// The command outputs below are the shapes those tools print; real runs happen in .github/workflows/release.yml.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultArtifacts,
  findSigntool,
  main,
  SHARING_VIOLATION_BACKOFF_MS,
  signingStatus,
  verifyMacDmg,
  verifyWindowsFile,
  type Run,
  type RunResult,
} from '../../scripts/verify-signing.mjs';

const DMG = '/build/out/make/NoobIDE-0.1.0-arm64.dmg';
const EXE = 'D:\\a\\out\\make\\squirrel.windows\\x64\\NoobIDE-Setup.exe';

const ok = (stdout: string, stderr = ''): RunResult => ({ status: 0, stdout, stderr });
const fail = (status: number, stdout: string, stderr = ''): RunResult => ({ status, stdout, stderr });

const SPCTL_NOTARIZED = ok(
  '',
  `${DMG}: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Aaron Jin (ABCDE12345)\n`,
);
const SPCTL_UNNOTARIZED = fail(
  3,
  '',
  `${DMG}: rejected\nsource=Unnotarized Developer ID\norigin=Developer ID Application: Aaron Jin (ABCDE12345)\n`,
);
const SPCTL_UNSIGNED = fail(3, '', `${DMG}: rejected\nsource=no usable signature\n`);
const STAPLER_OK = ok(`Processing: ${DMG}\nThe validate action worked!\n`);
const STAPLER_MISSING = fail(65, `Processing: ${DMG}\n${DMG} does not have a ticket stapled to it.\n`);

const SIGNTOOL_OK = ok(`Verifying: ${EXE}

Signature Index: 0 (Primary Signature)
Hash of file (sha256): 0F1E2D3C

Signing Certificate Chain:
    Issued to: Microsoft Identity Verification Root Certificate Authority 2020
    Issued by: Microsoft Identity Verification Root Certificate Authority 2020
    Issued to: Microsoft ID Verified CS EOC CA 01
    Issued by: Microsoft Identity Verification Root Certificate Authority 2020
    Issued to: Aaron Jin
    Issued by: Microsoft ID Verified CS EOC CA 01

The signature is timestamped: Thu Oct 15 10:00:00 2026
Timestamp Verified by:
    Issued to: Microsoft Public RSA Timestamping CA 2020

Successfully verified: ${EXE}

Number of files successfully Verified: 1
Number of warnings: 0
Number of errors: 0
`);
const SIGNTOOL_NO_TIMESTAMP = ok(`Verifying: ${EXE}
Signing Certificate Chain:
    Issued to: Aaron Jin
File is not timestamped.

Successfully verified: ${EXE}

Number of files successfully Verified: 1
Number of warnings: 0
Number of errors: 0
`);
const SIGNTOOL_UNSIGNED = fail(
  1,
  `Verifying: ${EXE}\n\nNumber of files successfully Verified: 0\nNumber of warnings: 0\nNumber of errors: 1\n`,
  'SignTool Error: No signature found.\n',
);

/** A mock runner keyed by command; records every call. */
function mock(responses: Record<string, RunResult>) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: Run = (cmd, args) => {
    calls.push({ cmd, args });
    const key = cmd === 'xcrun' ? `xcrun ${args[0]}` : cmd.toLowerCase().endsWith('signtool.exe') ? 'signtool' : cmd;
    const r = responses[key];
    if (!r) throw new Error(`unexpected command ${cmd}`);
    return r;
  };
  return { run, calls };
}

describe('verifyMacDmg', () => {
  it('passes a notarised, stapled DMG and runs exactly spctl -a -vvv -t install and stapler validate', () => {
    const m = mock({ spctl: SPCTL_NOTARIZED, 'xcrun stapler': STAPLER_OK });
    const r = verifyMacDmg(DMG, { run: m.run, teamId: 'ABCDE12345' });
    expect(r.ok).toBe(true);
    expect(m.calls).toEqual([
      { cmd: 'spctl', args: ['-a', '-vvv', '-t', 'install', DMG] },
      { cmd: 'xcrun', args: ['stapler', 'validate', DMG] },
    ]);
    expect(r.checks.map((c) => c.name)).toEqual([
      'spctl accepted',
      'spctl source',
      'spctl origin team',
      'stapler validate',
    ]);
  });

  it('fails a signed but not notarised DMG', () => {
    const r = verifyMacDmg(DMG, { run: mock({ spctl: SPCTL_UNNOTARIZED, 'xcrun stapler': STAPLER_MISSING }).run });
    expect(r.ok).toBe(false);
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      'spctl accepted',
      'spctl source',
      'stapler validate',
    ]);
  });

  it('fails an unsigned DMG and a DMG without a stapled ticket', () => {
    expect(verifyMacDmg(DMG, { run: mock({ spctl: SPCTL_UNSIGNED, 'xcrun stapler': STAPLER_OK }).run }).ok).toBe(false);
    const r = verifyMacDmg(DMG, { run: mock({ spctl: SPCTL_NOTARIZED, 'xcrun stapler': STAPLER_MISSING }).run });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => !c.ok)?.name).toBe('stapler validate');
  });

  it('fails when the DMG is signed by another team', () => {
    const r = verifyMacDmg(DMG, {
      run: mock({ spctl: SPCTL_NOTARIZED, 'xcrun stapler': STAPLER_OK }).run,
      teamId: 'ZZZZZ99999',
    });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => !c.ok)?.name).toBe('spctl origin team');
  });

  it('does not accept "accepted" when spctl exits non-zero', () => {
    const odd = fail(1, '', `${DMG}: accepted\nsource=Notarized Developer ID\n`);
    expect(verifyMacDmg(DMG, { run: mock({ spctl: odd, 'xcrun stapler': STAPLER_OK }).run }).ok).toBe(false);
  });
});

describe('verifyWindowsFile', () => {
  const SIGNTOOL = 'C:\\Kits\\signtool.exe';

  it('passes a signed, timestamped file, runs signtool verify /pa /v and names the leaf signer', () => {
    const m = mock({ signtool: SIGNTOOL_OK });
    const r = verifyWindowsFile(EXE, { run: m.run, signtool: SIGNTOOL });
    expect(r.ok).toBe(true);
    expect(m.calls).toEqual([{ cmd: SIGNTOOL, args: ['verify', '/pa', '/v', EXE] }]);
    expect(r.checks[0]?.detail).toBe('signer: Aaron Jin');
  });

  it('fails an unsigned file', () => {
    const r = verifyWindowsFile(EXE, { run: mock({ signtool: SIGNTOOL_UNSIGNED }).run, signtool: SIGNTOOL });
    expect(r.ok).toBe(false);
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['signtool verify', 'no errors', 'timestamped']);
  });

  it('fails a signature without a timestamp (it would expire with the certificate)', () => {
    const r = verifyWindowsFile(EXE, { run: mock({ signtool: SIGNTOOL_NO_TIMESTAMP }).run, signtool: SIGNTOOL });
    expect(r.ok).toBe(false);
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['timestamped']);
  });

  // A file the antivirus or indexer still holds (hosted Windows run 39033368439 hit it on electron.exe): signtool could
  // not open it at all, which says nothing about its signature, so the verifier waits and asks again — bounded.
  const SIGNTOOL_BUSY = fail(
    1,
    `Verifying: ${EXE}\n\nNumber of files successfully Verified: 0\nNumber of warnings: 0\nNumber of errors: 1\n`,
    'SignTool Error: The file is being used by another process.\n',
  );

  it('retries a sharing violation with the backoff delays and then passes the real result', () => {
    const answers = [SIGNTOOL_BUSY, SIGNTOOL_BUSY, SIGNTOOL_OK];
    const calls: string[][] = [];
    const slept: number[] = [];
    const run: Run = (_cmd, args) => {
      calls.push(args);
      return answers[Math.min(calls.length, answers.length) - 1]!;
    };
    const r = verifyWindowsFile(EXE, {
      run,
      signtool: SIGNTOOL,
      sleep: (ms) => slept.push(ms),
      backoffMs: [5, 10, 20],
    });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([5, 10]);
  });

  it('gives up after the last backoff delay and reports the sharing violation as it is', () => {
    const slept: number[] = [];
    const m = mock({ signtool: SIGNTOOL_BUSY });
    const r = verifyWindowsFile(EXE, {
      run: m.run,
      signtool: SIGNTOOL,
      sleep: (ms) => slept.push(ms),
      backoffMs: [5, 10],
    });
    expect(r.ok).toBe(false);
    expect(m.calls).toHaveLength(3);
    expect(slept).toEqual([5, 10]);
    expect(r.checks[0]?.detail).toBe('SignTool Error: The file is being used by another process.');
  });

  it('never retries a verdict: an unsigned file is reported after one run', () => {
    const slept: number[] = [];
    const m = mock({ signtool: SIGNTOOL_UNSIGNED });
    const r = verifyWindowsFile(EXE, { run: m.run, signtool: SIGNTOOL, sleep: (ms) => slept.push(ms) });
    expect(r.ok).toBe(false);
    expect(m.calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it('the default backoff is bounded (a few seconds in all)', () => {
    const total = SHARING_VIOLATION_BACKOFF_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(10_000);
  });
});

describe('findSigntool', () => {
  const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  it('prefers SIGNTOOL_PATH, then the newest SDK x64 signtool, then PATH', () => {
    expect(findSigntool({ env: { SIGNTOOL_PATH: 'X:\\signtool.exe' } })).toBe('X:\\signtool.exe');
    const files = new Set([
      kits,
      `${kits}\\10.0.19041.0\\x64\\signtool.exe`,
      `${kits}\\10.0.26100.0\\x64\\signtool.exe`,
      `${kits}\\10.0.9999.0\\x64\\signtool.exe`,
    ]);
    const fs = {
      existsSync: (p: string) => files.has(p),
      readdirSync: () => ['10.0.19041.0', '10.0.9999.0', '10.0.26100.0', 'x64'],
    };
    expect(findSigntool({ env: {}, fs })).toBe(`${kits}\\10.0.26100.0\\x64\\signtool.exe`);
    expect(findSigntool({ env: {}, fs: { existsSync: () => false, readdirSync: () => [] } })).toBe('signtool.exe');
  });
});

describe('signingStatus', () => {
  const yes = (...names: string[]) => Object.fromEntries(names.map((n) => [`HAS_${n}`, 'true']));
  const no = (...names: string[]) => Object.fromEntries(names.map((n) => [`HAS_${n}`, 'false']));
  const CERT = ['APPLE_CERTIFICATE_P12_BASE64', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_TEAM_ID'];
  const API = ['APPLE_API_KEY_P8_BASE64', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
  const APPLE_ID = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD'];
  const AZURE = [
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
    'ARTIFACT_SIGNING_ENDPOINT',
    'ARTIFACT_SIGNING_ACCOUNT',
    'ARTIFACT_SIGNING_PROFILE',
  ];
  const PFX = ['WINDOWS_CERTIFICATE_PFX_BASE64', 'WINDOWS_CERTIFICATE_PASSWORD'];

  it('skips (not an error) when no secret is set', () => {
    for (const p of ['darwin', 'win32']) {
      const s = signingStatus(p, { ...no(...CERT, ...API, ...APPLE_ID, ...AZURE, ...PFX) });
      expect(s).toMatchObject({ enabled: false, error: false });
      expect(s.message).toMatch(/SKIPPED.*unsigned.*docs\/release\/signing\.md/);
    }
    expect(signingStatus('darwin', {}).error).toBe(false);
  });

  it('enables macOS with a certificate and either notarisation route; the API key wins', () => {
    expect(signingStatus('darwin', yes(...CERT, ...APPLE_ID))).toMatchObject({ enabled: true, route: 'Apple ID' });
    expect(signingStatus('darwin', yes(...CERT, ...API, ...APPLE_ID))).toMatchObject({
      enabled: true,
      route: 'App Store Connect API key',
    });
  });

  it('errors on a half-configured route, naming only the missing secrets', () => {
    const s = signingStatus('darwin', yes(...CERT, 'APPLE_ID'));
    expect(s).toMatchObject({ enabled: false, error: true });
    expect(s.message).toContain('but APPLE_APP_SPECIFIC_PASSWORD missing');
    const t = signingStatus('darwin', yes('APPLE_CERTIFICATE_P12_BASE64', 'APPLE_CERTIFICATE_PASSWORD', ...API));
    expect(t.message).toContain('but APPLE_TEAM_ID missing');
    expect(signingStatus('darwin', yes(...CERT)).error).toBe(true); // signing without notarisation
    expect(signingStatus('darwin', yes(...API)).error).toBe(true); // notarisation without a certificate
    expect(signingStatus('win32', yes('AZURE_TENANT_ID')).error).toBe(true);
  });

  it('enables exactly one Windows route', () => {
    expect(signingStatus('win32', yes(...AZURE))).toMatchObject({ enabled: true, route: 'artifact-signing' });
    expect(signingStatus('win32', yes(...PFX))).toMatchObject({ enabled: true, route: 'certificate' });
    expect(signingStatus('win32', yes(...AZURE, ...PFX)).error).toBe(true);
  });
});

describe('main', () => {
  it('--status writes enabled/route to GITHUB_OUTPUT and never prints a value', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'noobide-sign-'));
    try {
      const out = path.join(dir, 'out.txt');
      writeFileSync(out, '');
      const lines: string[] = [];
      const code = main(['--status', '--platform', 'win32'], {
        env: {
          GITHUB_OUTPUT: out,
          HAS_WINDOWS_CERTIFICATE_PFX_BASE64: 'true',
          HAS_WINDOWS_CERTIFICATE_PASSWORD: 'true',
        },
        log: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe('enabled=true\nroute=certificate\n');
      expect(lines).toEqual(['Windows signing ENABLED: certificate']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips with one log line and exit 0 when the workflow says signing is off', () => {
    const lines: string[] = [];
    const run: Run = () => {
      throw new Error('must not run a command');
    };
    expect(main(['--platform', 'darwin'], { env: { SIGNING_ENABLED: 'false' }, run, log: (l) => lines.push(l) })).toBe(
      0,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^::notice::verify-signing SKIPPED/);
  });

  it('exits 1 when an artifact fails and 0 when all pass', () => {
    const log = () => {};
    const good = mock({ signtool: SIGNTOOL_OK }).run;
    const bad = mock({ signtool: SIGNTOOL_UNSIGNED }).run;
    const env = { SIGNING_ENABLED: 'true', SIGNTOOL_PATH: 'C:\\signtool.exe' };
    expect(main(['--platform', 'win32', 'a.exe', 'b.exe'], { env, run: good, log })).toBe(0);
    expect(main(['--platform', 'win32', 'a.exe'], { env, run: bad, log })).toBe(1);
  });

  it('exits 2 for an unknown platform', () => {
    expect(main(['--platform', 'linux'], { env: {}, log: () => {} })).toBe(2);
  });
});

describe('defaultArtifacts', () => {
  it('finds the DMG on macOS and Setup.exe + noobide.exe on Windows', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'noobide-art-'));
    try {
      mkdirSync(path.join(root, 'out', 'make', 'squirrel.windows', 'x64'), { recursive: true });
      mkdirSync(path.join(root, 'out', 'NoobIDE-win32-x64'), { recursive: true });
      writeFileSync(path.join(root, 'out', 'make', 'squirrel.windows', 'x64', 'NoobIDE-Setup.exe'), '');
      writeFileSync(path.join(root, 'out', 'make', 'squirrel.windows', 'x64', 'noobide-0.1.0-full.nupkg'), '');
      writeFileSync(path.join(root, 'out', 'NoobIDE-win32-x64', 'noobide.exe'), '');
      mkdirSync(path.join(root, 'out', 'make', 'dmg', 'arm64'), { recursive: true });
      writeFileSync(path.join(root, 'out', 'make', 'dmg', 'arm64', 'NoobIDE-0.1.0-arm64.dmg'), '');
      expect(defaultArtifacts('win32', { root }).map((f) => path.basename(f))).toEqual([
        'NoobIDE-Setup.exe',
        'noobide.exe',
      ]);
      expect(defaultArtifacts('darwin', { root }).map((f) => path.basename(f))).toEqual(['NoobIDE-0.1.0-arm64.dmg']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
