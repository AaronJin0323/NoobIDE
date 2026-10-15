// S28.2 / S28.3 — code-signing options for forge.config.ts, built only from environment variables
// (docs/release/signing.md, docs/decisions/0027-code-signing.md).
//
// Credentials live only in the release environment (GitHub "release" environment secrets). The workflow
// .github/workflows/release.yml imports the macOS certificate into a temporary keychain, writes key files to
// $RUNNER_TEMP and sets the variables below; this module never reads files, never logs a value and never stores one.
//
// Every route is all-or-nothing: no variable set → unsigned build (the default for local and CI builds); every
// variable of a route set → signed build; only some set → an error naming the missing variables (a half-configured
// release must not silently ship unsigned).

export type SigningEnv = Readonly<Record<string, string | undefined>>;

/** A variable counts as set only when it has non-whitespace content (GitHub passes absent secrets as ""). */
const has = (env: SigningEnv, name: string): boolean => (env[name] ?? '').trim() !== '';
const get = (env: SigningEnv, name: string): string => (env[name] ?? '').trim();

export class SigningConfigError extends Error {
  override name = 'SigningConfigError';
}

/** Throws when some but not all of `names` are set. Returns true when all are set, false when none are. */
function group(env: SigningEnv, label: string, names: readonly string[]): boolean {
  const missing = names.filter((n) => !has(env, n));
  if (missing.length === 0) return true;
  if (missing.length === names.length) return false;
  throw new SigningConfigError(`${label}: set ${names.join(', ')} together; missing ${missing.join(', ')}`);
}

// ── macOS ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Set by the workflow after importing the Developer ID Application certificate. */
export const MAC_SIGN_VARS = ['APPLE_SIGNING_IDENTITY', 'APPLE_KEYCHAIN_PATH'] as const;
/** Notarisation, preferred route: App Store Connect API key (APPLE_API_KEY_PATH is the .p8 file the workflow wrote). */
export const MAC_NOTARIZE_API_KEY_VARS = ['APPLE_API_KEY_PATH', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'] as const;
/** Notarisation, alternative route: Apple ID + app-specific password. */
/** Notarisation, alternative route: Apple ID + app-specific password (+ APPLE_TEAM_ID, a CI secret required on macOS). */
export const MAC_NOTARIZE_APPLE_ID_VARS = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD'] as const;

/** Hardened runtime entitlements for every signed Mach-O: only what V8 needs (ADR 0027). */
export const MAC_ENTITLEMENTS = 'resources/entitlements.mac.plist';

export interface MacSigning {
  osxSign: {
    identity: string;
    keychain: string;
    optionsForFile: () => { hardenedRuntime: true; entitlements: string };
  };
  osxNotarize:
    | { appleApiKey: string; appleApiKeyId: string; appleApiIssuer: string }
    | { appleId: string; appleIdPassword: string; teamId: string };
  /** Log line without secret values. */
  summary: string;
}

/** undefined → build unsigned (ad-hoc signed, ADR 0023). Throws on a partial configuration. */
export function macSigning(env: SigningEnv): MacSigning | undefined {
  const sign = group(env, 'macOS signing', MAC_SIGN_VARS);
  const apiKey = group(env, 'macOS notarisation (API key)', MAC_NOTARIZE_API_KEY_VARS);
  const appleId = group(env, 'macOS notarisation (Apple ID)', MAC_NOTARIZE_APPLE_ID_VARS);
  if (!sign) {
    if (apiKey || appleId) throw new SigningConfigError('macOS notarisation is configured but signing is not');
    return undefined;
  }
  if (!apiKey && !appleId) {
    throw new SigningConfigError(
      `macOS signing needs notarisation credentials: ${MAC_NOTARIZE_API_KEY_VARS.join(', ')} or ${MAC_NOTARIZE_APPLE_ID_VARS.join(', ')}`,
    );
  }
  if (!apiKey && !has(env, 'APPLE_TEAM_ID')) {
    throw new SigningConfigError('macOS notarisation with an Apple ID needs APPLE_TEAM_ID');
  }
  const identity = get(env, 'APPLE_SIGNING_IDENTITY');
  if (!identity.startsWith('Developer ID Application')) {
    throw new SigningConfigError('APPLE_SIGNING_IDENTITY must be a "Developer ID Application" certificate');
  }
  return {
    osxSign: {
      identity,
      keychain: get(env, 'APPLE_KEYCHAIN_PATH'),
      optionsForFile: () => ({ hardenedRuntime: true, entitlements: MAC_ENTITLEMENTS }),
    },
    osxNotarize: apiKey
      ? {
          appleApiKey: get(env, 'APPLE_API_KEY_PATH'),
          appleApiKeyId: get(env, 'APPLE_API_KEY_ID'),
          appleApiIssuer: get(env, 'APPLE_API_ISSUER'),
        }
      : {
          appleId: get(env, 'APPLE_ID'),
          appleIdPassword: get(env, 'APPLE_APP_SPECIFIC_PASSWORD'),
          teamId: get(env, 'APPLE_TEAM_ID'),
        },
    summary: `macOS signing: Developer ID + hardened runtime, notarisation via ${apiKey ? 'App Store Connect API key' : 'Apple ID'}`,
  };
}

/** Runs a command without a shell; resolves with stdout, rejects on a non-zero exit. */
export type Exec = (file: string, args: readonly string[]) => Promise<{ stdout: string }>;

/**
 * Wraps an execFile-style runner so a failure never echoes the argument list: Node's own error message is
 * "Command failed: <file> <args…>", which would print notarisation credentials into the CI log.
 */
export function quietExec(
  run: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr?: string }>,
): Exec {
  return async (file, args) => {
    try {
      const { stdout } = await run(file, args);
      return { stdout };
    } catch (err) {
      const e = err as { code?: unknown; stderr?: unknown };
      const stderr = typeof e.stderr === 'string' ? e.stderr.trim().slice(0, 2000) : '';
      // Deliberately no `cause`: the original error's message and `cmd` hold the full argument list.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `${file} ${args[0] ?? ''} failed (exit code ${String(e.code ?? 'unknown')})${stderr ? `: ${stderr}` : ''}`,
      );
    }
  };
}

/** notarytool credential arguments. They go to execFile (no shell) and are never logged. */
export function notarytoolCredentialArgs(n: MacSigning['osxNotarize']): string[] {
  return 'appleApiKey' in n
    ? ['--key', n.appleApiKey, '--key-id', n.appleApiKeyId, '--issuer', n.appleApiIssuer]
    : ['--apple-id', n.appleId, '--password', n.appleIdPassword, '--team-id', n.teamId];
}

/**
 * The packager signs and notarises the .app; the DMG the maker builds around it is a separate download that
 * Gatekeeper assesses on its own (`spctl -t install`). So the DMG is signed, notarised and stapled here, after make.
 * Errors carry notarytool's submission id and status but never credentials.
 */
export async function signNotarizeStapleDmg(dmg: string, mac: MacSigning, exec: Exec): Promise<void> {
  await exec('codesign', [
    '--force',
    '--sign',
    mac.osxSign.identity,
    '--keychain',
    mac.osxSign.keychain,
    '--timestamp',
    dmg,
  ]);
  const { stdout } = await exec('xcrun', [
    'notarytool',
    'submit',
    dmg,
    ...notarytoolCredentialArgs(mac.osxNotarize),
    '--wait',
    '--output-format',
    'json',
  ]);
  let result: { id?: string; status?: string };
  try {
    result = JSON.parse(stdout) as { id?: string; status?: string };
  } catch {
    throw new Error('notarytool returned no JSON result for the DMG');
  }
  if (result.status !== 'Accepted') {
    throw new Error(
      `DMG notarisation ${result.status ?? 'failed'} (submission ${result.id ?? 'unknown'}); ` +
        'see `xcrun notarytool log <id>` (docs/release/signing.md)',
    );
  }
  await exec('xcrun', ['stapler', 'staple', dmg]);
}

// ── Windows ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Azure Artifact Signing (formerly Trusted Signing). AZURE_* are read by the dlib itself (EnvironmentCredential). */
export const WIN_ARTIFACT_SIGNING_VARS = [
  'SIGNTOOL_PATH',
  'ARTIFACT_SIGNING_DLIB',
  'ARTIFACT_SIGNING_METADATA',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
] as const;
/** Classic signtool with a certificate file (WINDOWS_CERTIFICATE_FILE is the .pfx the workflow wrote). */
export const WIN_CERTIFICATE_VARS = [
  'SIGNTOOL_PATH',
  'WINDOWS_CERTIFICATE_FILE',
  'WINDOWS_CERTIFICATE_PASSWORD',
] as const;

export const ARTIFACT_SIGNING_TIMESTAMP = 'http://timestamp.acs.microsoft.com';
export const DEFAULT_TIMESTAMP = 'http://timestamp.digicert.com';

/** The subset of @electron/windows-sign options we use; passed to the packager and to Squirrel. */
export interface WindowsSigning {
  windowsSign: {
    signToolPath: string;
    hashes: ['sha256'];
    description: string;
    timestampServer: string;
    certificateFile?: string;
    certificatePassword?: string;
    /** Never /tr, /td or /fd: electron-winstaller's older @electron/windows-sign always adds them itself. */
    signWithParams?: string[];
  };
  summary: string;
}

/** undefined → unsigned build. Throws on a partial configuration or when both routes are configured. */
export function windowsSigning(env: SigningEnv): WindowsSigning | undefined {
  // SIGNTOOL_PATH alone (the workflow may always locate it) does not select a route.
  const withoutTool = (vars: readonly string[]) => vars.filter((v) => v !== 'SIGNTOOL_PATH');
  const artifact = group(env, 'Windows Artifact Signing', withoutTool(WIN_ARTIFACT_SIGNING_VARS));
  const cert = group(env, 'Windows certificate signing', withoutTool(WIN_CERTIFICATE_VARS));
  if (artifact && cert) throw new SigningConfigError('Windows: configure Artifact Signing or a certificate, not both');
  if (!artifact && !cert) return undefined;
  if (!has(env, 'SIGNTOOL_PATH')) throw new SigningConfigError('Windows signing needs SIGNTOOL_PATH (signtool.exe)');
  const base = { signToolPath: get(env, 'SIGNTOOL_PATH'), hashes: ['sha256'] as ['sha256'], description: 'NoobIDE' };
  if (artifact) {
    return {
      windowsSign: {
        ...base,
        timestampServer: ARTIFACT_SIGNING_TIMESTAMP,
        signWithParams: ['/dlib', get(env, 'ARTIFACT_SIGNING_DLIB'), '/dmdf', get(env, 'ARTIFACT_SIGNING_METADATA')],
      },
      summary: 'Windows signing: Azure Artifact Signing via signtool',
    };
  }
  return {
    windowsSign: {
      ...base,
      timestampServer: has(env, 'WINDOWS_TIMESTAMP_SERVER') ? get(env, 'WINDOWS_TIMESTAMP_SERVER') : DEFAULT_TIMESTAMP,
      certificateFile: get(env, 'WINDOWS_CERTIFICATE_FILE'),
      certificatePassword: get(env, 'WINDOWS_CERTIFICATE_PASSWORD'),
    },
    summary: 'Windows signing: signtool with a code-signing certificate',
  };
}
