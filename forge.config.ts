// Electron Forge configuration (S02.1). Versions and rationale: docs/decisions/0004-stack-versions.md.
//
// Packaging must run on the target OS (PLAN §5): `npm run make` on Windows produces the x64 Squirrel installer,
// on an Apple Silicon Mac the arm64 DMG. Cross-packaging does not count as delivery validation.
import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import type { ForgeConfig, ForgeMakeResult } from '@electron-forge/shared-types';
import { MakerSquirrel, type MakerSquirrelConfig } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { macSigning, quietExec, signNotarizeStapleDmg, windowsSigning } from './signing.config';

/** Owner to confirm the holder name before the first public release (ADR 0012). */
const APP_COPYRIGHT = 'Copyright © 2026 NoobIDE contributors';

/**
 * S28.4 (ADR 0023): the upgrade check packages "the next version" of the same code — NOOBIDE_BUILD_VERSION replaces
 * package.json's version in the packaged app (its package.json, Info.plist / file version, About) and
 * NOOBIDE_OUT_DIR puts it next to the normal build — so vN → vN+1 can be tested without editing package.json.
 * Never set for a release build.
 */
const execFileAsync = promisify(execFile);

/**
 * S28.2 / S28.3 (ADR 0027, docs/release/signing.md): Developer ID signing + notarisation and Windows Authenticode
 * signing, configured only from environment variables that the release workflow sets. Without them both are
 * undefined and the build is unsigned exactly as before; a partial configuration throws here, before packaging.
 */
// Each OS reads only its own route, so the other OS's secrets in the same CI step never trip the partial check.
const mac = process.platform === 'darwin' ? macSigning(process.env) : undefined;
const win = process.platform === 'win32' ? windowsSigning(process.env) : undefined;
for (const s of [mac, win]) if (s) console.log(s.summary);
// Our option subset is checked against @electron/windows-sign at the boundary (its hash enum is not importable).
type WindowsSignOptions = Exclude<NonNullable<NonNullable<ForgeConfig['packagerConfig']>['windowsSign']>, true>;
const windowsSign = win ? (win.windowsSign as unknown as WindowsSignOptions) : undefined;
// electron-winstaller bundles an older @electron/windows-sign (1.x) with its own types; the same options apply.
const squirrelWindowsSign = win
  ? (win.windowsSign as unknown as NonNullable<MakerSquirrelConfig['windowsSign']>)
  : undefined;

const buildVersion = process.env.NOOBIDE_BUILD_VERSION;
if (buildVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(buildVersion)) {
  throw new Error(`NOOBIDE_BUILD_VERSION must look like 1.2.3, got "${buildVersion}"`);
}

/**
 * S28.4 / G3 (ADR 0023): the packager edits Info.plist (name, version, icon, ASAR integrity) after Electron's own
 * ad-hoc signature, which leaves the .app with an invalid signature ("invalid Info.plist") that Gatekeeper refuses
 * once the download quarantine is set. Until Developer ID signing exists (S28.2, owner task H.2) every macOS package
 * is re-signed ad hoc as a whole, the last step after fuses and Info.plist changes. `codesign` ships with macOS.
 */
async function adHocSignMac(outputPaths: readonly string[]): Promise<void> {
  for (const dir of outputPaths) {
    const apps = (await readdir(dir)).filter((name) => name.endsWith('.app'));
    for (const name of apps) {
      await execFileAsync('codesign', ['--force', '--deep', '--sign', '-', path.join(dir, name)]);
    }
  }
}

/**
 * Third-party license notices (release readiness): Vite bundles production dependencies and drops their license
 * comments, so scripts/third-party-notices.mjs writes their license texts from package-lock.json + node_modules into
 * build/ (gitignored) before every package, and extraResource ships it as <resources>/THIRD_PARTY_NOTICES.txt (the
 * About dialog opens it). The script fails the build when a production package has no license text.
 */
const THIRD_PARTY_NOTICES = path.join('build', 'THIRD_PARTY_NOTICES.txt');

const config: ForgeConfig = {
  ...(process.env.NOOBIDE_OUT_DIR ? { outDir: process.env.NOOBIDE_OUT_DIR } : {}),
  hooks: {
    prePackage: async () => {
      // Forge runs from the project folder; extraResource resolves the same relative path.
      const script = path.resolve('scripts', 'third-party-notices.mjs');
      const { stdout } = await execFileAsync(process.execPath, [script, path.resolve(THIRD_PARTY_NOTICES)]);
      process.stdout.write(stdout);
    },
    ...(buildVersion
      ? {
          // Runs on the copied, pruned app before app.asar is made (after the Vite plugin rewrote package.json):
          // app.getVersion() reads this package.json.
          packageAfterPrune: async (_config: unknown, buildPath: string) => {
            const file = path.join(buildPath, 'package.json');
            const pkg = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
            await writeFile(file, `${JSON.stringify({ ...pkg, version: buildVersion }, null, 2)}\n`);
          },
        }
      : {}),
    postPackage: async (_config, result) => {
      // With Developer ID signing the packager has already signed (last, after fuses and Info.plist) and notarised
      // the app; an ad-hoc re-sign would replace that signature.
      if (!mac && (result.platform === 'darwin' || result.platform === 'mas')) await adHocSignMac(result.outputPaths);
    },
    ...(mac
      ? {
          postMake: async (_config: unknown, results: ForgeMakeResult[]) => {
            const exec = quietExec((file, args) => execFileAsync(file, [...args], { maxBuffer: 16 * 1024 * 1024 }));
            for (const dmg of results.flatMap((r) => r.artifacts).filter((a) => a.endsWith('.dmg'))) {
              await signNotarizeStapleDmg(dmg, mac, exec);
            }
            return results;
          },
        }
      : {}),
  },
  packagerConfig: {
    ...(buildVersion ? { appVersion: buildVersion, buildVersion } : {}),
    name: 'NoobIDE',
    executableName: 'noobide',
    appBundleId: 'app.noobide.desktop',
    asar: true,
    // S20.1: built-in templates are copied next to app.asar as <resources>/templates (plain files, readable with fs).
    // Resolved at runtime by resolveTemplatesDir() in src/workspace/templates.ts.
    // Release readiness: third-party license notices as <resources>/THIRD_PARTY_NOTICES.txt (written in prePackage).
    extraResource: ['resources/templates', THIRD_PARTY_NOTICES],
    // S28.1 (docs/decisions/0012-installers-and-app-identity.md): icon and version information. The packager picks
    // icon.icns on macOS and icon.ico on Windows (placeholder artwork from scripts/make-icons.mjs). The version is
    // package.json "version" (CFBundleShortVersionString / FileVersion / ProductVersion; About shows the same).
    icon: 'resources/icons/icon',
    appCopyright: APP_COPYRIGHT,
    appCategoryType: 'public.app-category.developer-tools',
    win32metadata: {
      CompanyName: 'NoobIDE',
      ProductName: 'NoobIDE',
      FileDescription: 'NoobIDE',
      InternalName: 'noobide',
      OriginalFilename: 'noobide.exe',
    },
    // S28.2/S28.3: credentials live only in the release environment (signing.config.ts).
    ...(mac ? { osxSign: mac.osxSign, osxNotarize: mac.osxNotarize } : {}),
    ...(windowsSign ? { windowsSign } : {}),
  },
  rebuildConfig: {},
  makers: [
    // Windows: Squirrel.Windows per-user installer (no admin rights, manual upgrade by running a newer Setup.exe).
    // `iconUrl` (the Programs and Features icon) must be a public https URL fetched at install time; it stays the
    // Electron default until a release download host exists (ADR 0012).
    new MakerSquirrel(
      {
        name: 'NoobIDE',
        setupExe: 'NoobIDE-Setup.exe',
        setupIcon: 'resources/icons/icon.ico',
        copyright: APP_COPYRIGHT,
        // Signs Setup.exe and the Squirrel stubs with the same route as the app (S28.3).
        ...(squirrelWindowsSign ? { windowsSign: squirrelWindowsSign } : {}),
        // NuGet (nuspec) requires Authors; package.json has no "author", so `make` failed with "Authors is
        // required." on Windows. Also shown as the publisher in Settings → Apps.
        authors: 'NoobIDE contributors',
        owners: 'NoobIDE contributors',
        // Squirrel stamps the nuspec description into Setup.exe's ProductName / FileDescription (what SmartScreen
        // and File Explorer show); without this they read package.json's long description.
        description: 'NoobIDE',
      },
      ['win32'],
    ),
    // macOS: DMG for the architecture it is built on (arm64 on an Apple Silicon Mac; PLAN §5 forbids cross-packaging
    // as delivery validation).
    new MakerDMG({ format: 'ULFO', icon: 'resources/icons/icon.icns' }, ['darwin']),
    new MakerZIP({}, ['darwin', 'win32', 'linux']),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    // Fuses flip Electron features off at package time (Electron security checklist).
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      // The workbench is served from the privileged noobide:// scheme, never file:// (src/main/app-protocol.ts).
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};

export default config;
