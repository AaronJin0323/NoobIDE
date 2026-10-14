// Electron Forge configuration (S02.1). Versions and rationale: docs/decisions/0004-stack-versions.md.
//
// Packaging must run on the target OS (PLAN §5): `npm run make` on Windows produces the x64 Squirrel installer,
// on an Apple Silicon Mac the arm64 DMG. Cross-packaging does not count as delivery validation.
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

/** Owner to confirm the holder name before the first public release (ADR 0012). */
const APP_COPYRIGHT = 'Copyright © 2026 NoobIDE contributors';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'NoobIDE',
    executableName: 'noobide',
    appBundleId: 'app.noobide.desktop',
    asar: true,
    // S20.1: built-in templates are copied next to app.asar as <resources>/templates (plain files, readable with fs).
    // Resolved at runtime by resolveTemplatesDir() in src/workspace/templates.ts.
    extraResource: ['resources/templates'],
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
    // Signing and notarisation are configured in S28.2/S28.3 with credentials that live only in the release
    // environment.
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
