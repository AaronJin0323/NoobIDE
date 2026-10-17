#!/usr/bin/env node
// S28.2 / S28.3 — verify the signatures of the release artifacts (docs/release/signing.md, ADR 0027).
//
//   node scripts/verify-signing.mjs                  verify this OS's artifacts under out/ (see defaultArtifacts)
//   node scripts/verify-signing.mjs <file> [...]     verify the given DMGs (macOS) or .exe files (Windows)
//   node scripts/verify-signing.mjs --status         report which signing route the CI secrets enable (no values)
//   --platform darwin|win32                          override the OS (default: this machine)
//
// macOS, per DMG:  spctl -a -vvv -t install <dmg>  must say "accepted" with source "Notarized Developer ID"
//                  (and the origin must end with "(APPLE_TEAM_ID)"), and
//                  xcrun stapler validate <dmg>     must report "The validate action worked".
// Windows, per exe: signtool verify /pa /v <file>  must report "Successfully verified", no errors, and a timestamp
//                  (an untimestamped signature stops being valid when the certificate expires).
//
// In CI the release workflow passes SIGNING_ENABLED from --status: when it is "false" the script prints one skip
// line and exits 0, so unsigned builds never fail. Exit codes: 0 pass or skipped · 1 a signature check failed ·
// 2 usage error or no artifact found. Pure Node; commands run without a shell and are injected for the unit tests.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DOC = 'docs/release/signing.md';

/** Default runner: no shell, output captured, never throws. */
export function defaultRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error?.message || '') };
}

const output = (r) => `${r.stdout ?? ''}\n${r.stderr ?? ''}`;

/** spctl + stapler on one DMG. Returns { file, ok, checks: [{ name, ok, detail }] }. */
export function verifyMacDmg(file, { run = defaultRun, teamId = '' } = {}) {
  const checks = [];
  const spctl = run('spctl', ['-a', '-vvv', '-t', 'install', file]);
  const text = output(spctl);
  const accepted = spctl.status === 0 && /:\s*accepted\b/.test(text);
  const source = /^\s*source=(.*)$/m.exec(text)?.[1]?.trim() ?? '';
  const origin = /^\s*origin=(.*)$/m.exec(text)?.[1]?.trim() ?? '';
  checks.push({ name: 'spctl accepted', ok: accepted, detail: accepted ? 'accepted' : firstLine(text) });
  const notarized = source === 'Notarized Developer ID';
  checks.push({ name: 'spctl source', ok: notarized, detail: source || 'no source reported' });
  if (teamId) {
    const team = origin.endsWith(`(${teamId})`);
    checks.push({ name: 'spctl origin team', ok: team, detail: origin || 'no origin reported' });
  }
  const stapler = run('xcrun', ['stapler', 'validate', file]);
  const stapled = stapler.status === 0 && /The validate action worked/.test(output(stapler));
  checks.push({
    name: 'stapler validate',
    ok: stapled,
    detail: stapled ? 'ticket stapled' : firstLine(output(stapler)),
  });
  return { file, ok: checks.every((c) => c.ok), checks };
}

/**
 * Delays before each retry when signtool could not open the file at all (ERROR_SHARING_VIOLATION, "The file is being
 * used by another process"): on Windows a freshly written executable is held for a moment by the antivirus scanner or
 * the indexer, exactly as the atomic save's rename is (src/recovery/atomic-file.ts). Only that error is retried — a
 * signature that fails to verify is reported at once — and after the last attempt the error is reported as it is.
 */
export const SHARING_VIOLATION_BACKOFF_MS = [500, 1000, 2000, 4000];
const SHARING_VIOLATION = /SignTool Error: The file is being used by another process/;

/** Blocks the current thread for `ms` (the verifier is synchronous: spawnSync, one file after another). */
function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** signtool verify /pa /v on one file. */
export function verifyWindowsFile(
  file,
  { run = defaultRun, signtool = 'signtool.exe', sleep = defaultSleep, backoffMs = SHARING_VIOLATION_BACKOFF_MS } = {},
) {
  let r = run(signtool, ['verify', '/pa', '/v', file]);
  for (const delay of backoffMs) {
    if (!SHARING_VIOLATION.test(output(r))) break;
    sleep(delay);
    r = run(signtool, ['verify', '/pa', '/v', file]);
  }
  const text = output(r);
  const verified = r.status === 0 && /Successfully verified:/.test(text);
  const errors = /Number of errors:\s*(\d+)/.exec(text)?.[1];
  const timestamped = /The signature is timestamped:/.test(text);
  // The signing chain is printed root first, leaf last, then the timestamp chain: the signer is the last
  // "Issued to" before the timestamp section.
  const chain = text.split(/The signature is timestamped:|Timestamp Verified by:/)[0] ?? '';
  const issuedTo = [...chain.matchAll(/Issued to:\s*(.+)/g)].at(-1)?.[1]?.trim() ?? '';
  const checks = [
    { name: 'signtool verify', ok: verified, detail: verified ? `signer: ${issuedTo || 'unknown'}` : firstLine(text) },
    { name: 'no errors', ok: errors === '0', detail: `errors: ${errors ?? 'not reported'}` },
    { name: 'timestamped', ok: timestamped, detail: timestamped ? 'timestamp present' : 'no timestamp' },
  ];
  return { file, ok: checks.every((c) => c.ok), checks };
}

/** The most telling line of a tool's output: its first error / rejection line, else its first line. */
function firstLine(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    lines.find((l) => /^SignTool Error|: rejected|does not have/i.test(l)) ??
    lines.find((l) => /error/i.test(l)) ??
    lines[0] ??
    'no output'
  );
}

/**
 * signtool is not on PATH on GitHub's Windows runners: SIGNTOOL_PATH wins, else the newest Windows 10/11 SDK's x64
 * signtool, else "signtool.exe" from PATH.
 */
export function findSigntool({ env = process.env, fs = { existsSync, readdirSync } } = {}) {
  if ((env.SIGNTOOL_PATH ?? '').trim()) return env.SIGNTOOL_PATH.trim();
  const base = path.win32.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  if (fs.existsSync(base)) {
    const versions = fs
      .readdirSync(base)
      .filter((v) => /^10\.\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => compareVersions(b, a));
    for (const v of versions) {
      const candidate = path.win32.join(base, v, 'x64', 'signtool.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return 'signtool.exe';
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Release artifacts of `npm run make` on this OS (forge.config.ts: DMG maker; Squirrel + packaged app). */
export function defaultArtifacts(platform, { root = ROOT, fs = { existsSync, readdirSync } } = {}) {
  const out = path.join(root, 'out');
  const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => path.join(dir, n)) : []);
  if (platform === 'darwin') {
    return list(path.join(out, 'make')).flatMap((d) =>
      d.endsWith('.dmg') ? [d] : walkDmgs(d, fs).filter((f) => f.endsWith('.dmg')),
    );
  }
  if (platform === 'win32') {
    const setup = list(path.join(out, 'make', 'squirrel.windows', 'x64')).filter((f) => /setup\.exe$/i.test(f));
    const app = path.join(out, 'NoobIDE-win32-x64', 'noobide.exe');
    return [...setup, ...(fs.existsSync(app) ? [app] : [])];
  }
  return [];
}

function walkDmgs(dir, fs) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((n) => {
    const p = path.join(dir, n);
    return n.endsWith('.dmg') ? [p] : walkDmgs(p, fs);
  });
}

/** Secret groups per route, as booleans the workflow passes (HAS_<SECRET>="true"/"false"); never the values. */
export const SECRET_ROUTES = {
  darwin: {
    // The Team ID goes with the certificate: notarytool's Apple ID route needs it and verification checks it.
    certificate: ['APPLE_CERTIFICATE_P12_BASE64', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_TEAM_ID'],
    notarize: {
      'App Store Connect API key': ['APPLE_API_KEY_P8_BASE64', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
      'Apple ID': ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD'],
    },
  },
  win32: {
    routes: {
      'artifact-signing': [
        'AZURE_TENANT_ID',
        'AZURE_CLIENT_ID',
        'AZURE_CLIENT_SECRET',
        'ARTIFACT_SIGNING_ENDPOINT',
        'ARTIFACT_SIGNING_ACCOUNT',
        'ARTIFACT_SIGNING_PROFILE',
      ],
      certificate: ['WINDOWS_CERTIFICATE_PFX_BASE64', 'WINDOWS_CERTIFICATE_PASSWORD'],
    },
  },
};

/**
 * Decides from HAS_<NAME> booleans whether this run signs. Returns { enabled, route, message, error }.
 * All of a group present → enabled; none → skipped (unsigned build, not a failure); some → error.
 */
export function signingStatus(platform, env = process.env) {
  const present = (n) => env[`HAS_${n}`] === 'true';
  const state = (names) => {
    const n = names.filter(present).length;
    return n === 0 ? 'none' : n === names.length ? 'all' : 'some';
  };
  const partial = (label, names) => ({
    enabled: false,
    route: null,
    error: true,
    message: `${label}: some secrets are set but ${names.filter((n) => !present(n)).join(', ')} missing — fix the release environment secrets (${DOC})`,
  });
  const skipped = (what, names) => ({
    enabled: false,
    route: null,
    error: false,
    message: `${what} SKIPPED: secrets ${names.join(', ')} are not set, so this build is unsigned (${DOC})`,
  });

  if (platform === 'darwin') {
    const { certificate, notarize } = SECRET_ROUTES.darwin;
    const cert = state(certificate);
    const routes = Object.entries(notarize).map(([label, names]) => ({ label, names, s: state(names) }));
    if (cert === 'some') return partial('macOS certificate', certificate);
    for (const r of routes) if (r.s === 'some') return partial(`macOS notarisation (${r.label})`, r.names);
    const full = routes.filter((r) => r.s === 'all');
    if (cert === 'none' && full.length === 0) return skipped('macOS signing and notarisation', certificate);
    if (cert === 'none') return partial('macOS certificate', certificate);
    if (full.length === 0) {
      return partial(
        'macOS notarisation',
        routes.flatMap((r) => r.names),
      );
    }
    // The API key wins when both are configured (it is not tied to a person's Apple ID).
    return {
      enabled: true,
      route: full[0].label,
      error: false,
      message: `macOS signing ENABLED: Developer ID certificate, notarisation via ${full[0].label}`,
    };
  }
  if (platform === 'win32') {
    const routes = Object.entries(SECRET_ROUTES.win32.routes).map(([label, names]) => ({
      label,
      names,
      s: state(names),
    }));
    for (const r of routes) if (r.s === 'some') return partial(`Windows ${r.label}`, r.names);
    const full = routes.filter((r) => r.s === 'all');
    if (full.length > 1) {
      return {
        enabled: false,
        route: null,
        error: true,
        message: `Windows: configure one signing route, not both (${DOC})`,
      };
    }
    if (full.length === 0)
      return skipped(
        'Windows signing',
        routes.flatMap((r) => r.names),
      );
    return { enabled: true, route: full[0].label, error: false, message: `Windows signing ENABLED: ${full[0].label}` };
  }
  return { enabled: false, route: null, error: false, message: `signing: nothing to sign on ${platform}` };
}

export function main(argv = process.argv.slice(2), { env = process.env, run = defaultRun, log = console.log } = {}) {
  const args = [...argv];
  let platform = process.platform;
  const pi = args.indexOf('--platform');
  if (pi >= 0) {
    platform = args[pi + 1];
    args.splice(pi, 2);
  }
  if (platform !== 'darwin' && platform !== 'win32') {
    log(`verify-signing: unsupported platform "${platform}" (darwin or win32)`);
    return 2;
  }

  if (args[0] === '--status') {
    const s = signingStatus(platform, env);
    log(s.error ? `::error::${s.message}` : s.enabled ? s.message : `::notice::${s.message}`);
    if (env.GITHUB_OUTPUT) {
      appendFileSync(env.GITHUB_OUTPUT, `enabled=${s.enabled}\nroute=${s.route ?? ''}\n`);
    }
    return s.error ? 1 : 0;
  }

  if (env.SIGNING_ENABLED !== undefined && env.SIGNING_ENABLED !== 'true') {
    log(`::notice::verify-signing SKIPPED: this build is unsigned because no signing secrets are configured (${DOC})`);
    return 0;
  }

  const files = args.length ? args.map((a) => path.resolve(a)) : defaultArtifacts(platform);
  const expected = platform === 'darwin' ? 1 : 2; // a DMG; or Setup.exe + noobide.exe
  if (files.length === 0 || (!args.length && files.length < expected)) {
    log(
      `verify-signing: expected ${platform === 'darwin' ? 'a DMG' : 'Setup.exe and noobide.exe'} under out/ — run npm run make first`,
    );
    return 2;
  }
  const signtool = platform === 'win32' ? findSigntool({ env }) : '';
  const teamId = (env.APPLE_TEAM_ID ?? '').trim();
  const results = files.map((f) =>
    platform === 'darwin' ? verifyMacDmg(f, { run, teamId }) : verifyWindowsFile(f, { run, signtool }),
  );
  for (const r of results) {
    log(`${r.ok ? 'PASS' : 'FAIL'} ${path.relative(ROOT, r.file) || r.file}`);
    for (const c of r.checks) log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  log(
    failed
      ? `verify-signing: ${failed} of ${results.length} artifact(s) FAILED`
      : `verify-signing: ${results.length} artifact(s) signed and verified`,
  );
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
