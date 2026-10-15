// S28.2 / S28.3 — signing.config.ts: forge signing options come only from the environment, all-or-nothing per
// route, and the DMG notarisation never echoes credentials (ADR 0027).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ARTIFACT_SIGNING_TIMESTAMP,
  MAC_ENTITLEMENTS,
  SigningConfigError,
  macSigning,
  notarytoolCredentialArgs,
  quietExec,
  signNotarizeStapleDmg,
  windowsSigning,
  type Exec,
} from '../../signing.config';

const ROOT = path.resolve(__dirname, '../..');
const SIGN = {
  APPLE_SIGNING_IDENTITY: 'Developer ID Application: Aaron Jin (ABCDE12345)',
  APPLE_KEYCHAIN_PATH: '/tmp/k',
};
const API = { APPLE_API_KEY_PATH: '/tmp/AuthKey.p8', APPLE_API_KEY_ID: 'KEY123', APPLE_API_ISSUER: 'issuer-uuid' };
const APPLE_ID = { APPLE_ID: 'dev@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh', APPLE_TEAM_ID: 'ABCDE12345' };

describe('macSigning', () => {
  it('is off without variables, and empty strings (absent GitHub secrets) count as absent', () => {
    expect(macSigning({})).toBeUndefined();
    expect(macSigning({ APPLE_SIGNING_IDENTITY: '', APPLE_ID: ' ', APPLE_API_KEY_ID: '' })).toBeUndefined();
  });

  it('signs with hardened runtime and the minimal entitlements, notarising via API key or Apple ID', () => {
    const viaKey = macSigning({ ...SIGN, ...API });
    expect(viaKey?.osxSign.identity).toBe(SIGN.APPLE_SIGNING_IDENTITY);
    expect(viaKey?.osxSign.keychain).toBe('/tmp/k');
    expect(viaKey?.osxSign.optionsForFile()).toEqual({ hardenedRuntime: true, entitlements: MAC_ENTITLEMENTS });
    expect(viaKey?.osxNotarize).toEqual({
      appleApiKey: '/tmp/AuthKey.p8',
      appleApiKeyId: 'KEY123',
      appleApiIssuer: 'issuer-uuid',
    });
    expect(macSigning({ ...SIGN, ...APPLE_ID })?.osxNotarize).toEqual({
      appleId: 'dev@example.com',
      appleIdPassword: 'abcd-efgh',
      teamId: 'ABCDE12345',
    });
    // The API key wins when both are set.
    expect(macSigning({ ...SIGN, ...API, ...APPLE_ID })?.osxNotarize).toHaveProperty('appleApiKey');
  });

  it('throws on partial configurations instead of shipping a half-signed build', () => {
    expect(() => macSigning({ ...SIGN })).toThrow(SigningConfigError);
    expect(() => macSigning({ ...API })).toThrow(/notarisation is configured but signing is not/);
    expect(() => macSigning({ ...SIGN, APPLE_ID: 'x' })).toThrow(/missing APPLE_APP_SPECIFIC_PASSWORD/);
    expect(() => macSigning({ ...SIGN, ...APPLE_ID, APPLE_TEAM_ID: '' })).toThrow(/needs APPLE_TEAM_ID/);
    expect(macSigning({ ...SIGN, ...API, APPLE_TEAM_ID: '' })).toBeDefined(); // the API key route needs no team id
    expect(() => macSigning({ ...SIGN, ...API, APPLE_SIGNING_IDENTITY: 'Apple Development: Aaron Jin (X)' })).toThrow(
      /Developer ID Application/,
    );
  });

  it('the summary names the route but no value', () => {
    const s = macSigning({ ...SIGN, ...APPLE_ID })!.summary;
    for (const v of Object.values({ ...SIGN, ...APPLE_ID })) expect(s).not.toContain(v);
  });

  it('the entitlements file grants JIT only', () => {
    const plist = readFileSync(path.join(ROOT, MAC_ENTITLEMENTS), 'utf8');
    expect([...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual(['com.apple.security.cs.allow-jit']);
  });
});

describe('windowsSigning', () => {
  const AZ = {
    ARTIFACT_SIGNING_DLIB: 'C:\\t\\Azure.CodeSigning.Dlib.dll',
    ARTIFACT_SIGNING_METADATA: 'C:\\t\\metadata.json',
    AZURE_TENANT_ID: 't',
    AZURE_CLIENT_ID: 'c',
    AZURE_CLIENT_SECRET: 's',
  };
  const PFX = { WINDOWS_CERTIFICATE_FILE: 'C:\\t\\cert.pfx', WINDOWS_CERTIFICATE_PASSWORD: 'pw' };
  const TOOL = { SIGNTOOL_PATH: 'C:\\Kits\\signtool.exe' };

  it('is off without variables, even when the workflow located signtool', () => {
    expect(windowsSigning({})).toBeUndefined();
    expect(windowsSigning(TOOL)).toBeUndefined();
  });

  it('Artifact Signing: sha256 only, the dlib + metadata, Microsoft timestamp, no duplicate /tr /td /fd', () => {
    const w = windowsSigning({ ...TOOL, ...AZ })!.windowsSign;
    expect(w).toMatchObject({
      signToolPath: TOOL.SIGNTOOL_PATH,
      hashes: ['sha256'],
      timestampServer: ARTIFACT_SIGNING_TIMESTAMP,
    });
    expect(w.signWithParams).toEqual(['/dlib', AZ.ARTIFACT_SIGNING_DLIB, '/dmdf', AZ.ARTIFACT_SIGNING_METADATA]);
    expect(w.certificatePassword).toBeUndefined();
  });

  it('certificate route uses the file and password; the Azure secret is never put into signtool arguments', () => {
    const w = windowsSigning({ ...TOOL, ...PFX })!.windowsSign;
    expect(w).toMatchObject({ certificateFile: PFX.WINDOWS_CERTIFICATE_FILE, certificatePassword: 'pw' });
    expect(JSON.stringify(windowsSigning({ ...TOOL, ...AZ }))).not.toContain('"s"');
  });

  it('throws on partial, double or tool-less configurations', () => {
    expect(() => windowsSigning({ ...TOOL, AZURE_TENANT_ID: 't' })).toThrow(SigningConfigError);
    expect(() => windowsSigning({ ...TOOL, ...AZ, ...PFX })).toThrow(/not both/);
    expect(() => windowsSigning({ ...PFX })).toThrow(/SIGNTOOL_PATH/);
  });
});

describe('DMG sign, notarise, staple', () => {
  const mac = macSigning({ ...SIGN, ...APPLE_ID })!;

  it('signs with the identity and keychain, submits with --wait, then staples', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (file, args) => {
      calls.push([file, ...args]);
      return { stdout: args[0] === 'notarytool' ? '{"id":"abc","status":"Accepted"}' : '' };
    };
    await signNotarizeStapleDmg('/o/NoobIDE.dmg', mac, exec);
    expect(calls.map((c) => c.slice(0, 2))).toEqual([
      ['codesign', '--force'],
      ['xcrun', 'notarytool'],
      ['xcrun', 'stapler'],
    ]);
    expect(calls[0]).toEqual(
      expect.arrayContaining(['--sign', SIGN.APPLE_SIGNING_IDENTITY, '--keychain', '/tmp/k', '--timestamp']),
    );
    expect(calls[1]).toEqual(expect.arrayContaining(['submit', '/o/NoobIDE.dmg', '--wait', '--team-id', 'ABCDE12345']));
    expect(calls[2]).toEqual(['xcrun', 'stapler', 'staple', '/o/NoobIDE.dmg']);
  });

  it('fails on a rejected submission with its id, and does not staple', async () => {
    const calls: string[] = [];
    const exec: Exec = async (file, args) => {
      calls.push(`${file} ${args[0]}`);
      return { stdout: args[0] === 'notarytool' ? '{"id":"sub-1","status":"Invalid"}' : '' };
    };
    await expect(signNotarizeStapleDmg('/o/x.dmg', mac, exec)).rejects.toThrow(/Invalid \(submission sub-1\)/);
    expect(calls).not.toContain('xcrun stapler');
  });

  it('API-key credentials map to --key/--key-id/--issuer', () => {
    expect(notarytoolCredentialArgs(macSigning({ ...SIGN, ...API })!.osxNotarize)).toEqual([
      '--key',
      '/tmp/AuthKey.p8',
      '--key-id',
      'KEY123',
      '--issuer',
      'issuer-uuid',
    ]);
  });

  it('quietExec never echoes arguments (passwords) when a command fails', async () => {
    const exec = quietExec(async () => {
      throw Object.assign(new Error('Command failed: xcrun notarytool submit --password abcd-efgh'), {
        code: 69,
        stderr: 'Error: HTTP status code: 401. Unable to authenticate.',
      });
    });
    const err = (await exec('xcrun', ['notarytool', '--password', 'abcd-efgh']).catch((e: Error) => e)) as Error;
    expect(err.message).toBe(
      'xcrun notarytool failed (exit code 69): Error: HTTP status code: 401. Unable to authenticate.',
    );
    expect(err.message).not.toContain('abcd-efgh');
  });
});

describe('repository holds no signing material', () => {
  it('.gitignore excludes certificate, key and keychain files', () => {
    const ignore = readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
    expect(ignore).toEqual(expect.arrayContaining(['*.p12', '*.pfx', '*.p8', '*.keychain-db']));
  });
});
