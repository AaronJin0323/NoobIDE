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

const config: ForgeConfig = {
  packagerConfig: {
    name: 'NoobIDE',
    executableName: 'noobide',
    appBundleId: 'app.noobide.desktop',
    asar: true,
    // Signing and notarisation are configured in S28 with credentials that live only in the release environment.
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({ name: 'NoobIDE', setupExe: 'NoobIDE-Setup.exe' }, ['win32']),
    new MakerDMG({ format: 'ULFO' }, ['darwin']),
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
