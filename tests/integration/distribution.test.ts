import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import forgeConfig from '../../forge.config';
import rendererConfig from '../../vite.renderer.config';

/**
 * S28.1: makers, icon and version information (docs/decisions/0012-installers-and-app-identity.md). The packaged
 * artifacts themselves are checked by tests/e2e/distribution.spec.ts after `electron-forge package`.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  version: string;
  productName: string;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  expect(png.toString('ascii', 12, 16)).toBe('IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

interface MakerLike {
  name: string;
  platformsToMakeOn?: string[];
  configOrConfigFetcher?: Record<string, unknown>;
}
const makers = (forgeConfig.makers ?? []) as unknown as MakerLike[];
const maker = (name: string) => makers.find((m) => m.name === name);

describe('installers (S28.1)', () => {
  it('builds a Squirrel.Windows installer on Windows and a DMG on macOS, plus ZIPs', () => {
    expect(maker('squirrel')?.platformsToMakeOn).toEqual(['win32']);
    expect(maker('dmg')?.platformsToMakeOn).toEqual(['darwin']);
    expect(maker('zip')?.platformsToMakeOn).toEqual(expect.arrayContaining(['darwin', 'win32']));
    expect(maker('squirrel')?.configOrConfigFetcher).toMatchObject({ setupExe: 'NoobIDE-Setup.exe' });
  });

  it('gives Squirrel the nuspec fields it requires and the product name for Setup.exe', () => {
    // nuget pack fails with "Authors is required." without them (package.json has no "author"), and Squirrel stamps
    // the nuspec description into Setup.exe's ProductName / FileDescription (found by `npm run make` on Windows).
    const squirrel = maker('squirrel')?.configOrConfigFetcher ?? {};
    expect(squirrel.authors).toEqual(expect.any(String));
    expect((squirrel.authors as string).trim()).not.toBe('');
    expect((squirrel.authors as string).includes('@')).toBe(false);
    expect(squirrel.description).toBe('NoobIDE');
  });

  it('every icon the makers and the packager reference is bundled in the repository', () => {
    const icon = forgeConfig.packagerConfig?.icon;
    expect(icon).toBe('resources/icons/icon');
    for (const ext of ['.icns', '.ico', '.png']) expect(existsSync(path.join(root, `${icon}${ext}`))).toBe(true);
    const setupIcon = maker('squirrel')?.configOrConfigFetcher?.setupIcon as string;
    const dmgIcon = maker('dmg')?.configOrConfigFetcher?.icon as string;
    expect(existsSync(path.join(root, setupIcon))).toBe(true);
    expect(existsSync(path.join(root, dmgIcon))).toBe(true);
  });

  it('carries version information: package.json version, Windows file metadata, macOS category', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/); // Squirrel and Info.plist need semver
    expect(pkg.productName).toBe('NoobIDE');
    const packager = forgeConfig.packagerConfig ?? {};
    // No override: Electron Packager takes the version from package.json, which is also what app.getVersion() reads.
    expect(packager.appVersion).toBeUndefined();
    expect(packager.buildVersion).toBeUndefined();
    expect(packager.appCopyright).toMatch(/^Copyright © \d{4} /);
    expect(packager.appCategoryType).toBe('public.app-category.developer-tools');
    expect(packager.extendInfo).toEqual({ LSMinimumSystemVersion: '13.0' });
    expect(packager.win32metadata).toMatchObject({ ProductName: 'NoobIDE', CompanyName: 'NoobIDE' });
  });

  it('the About dialog is built with the same version', () => {
    expect((rendererConfig as { define?: Record<string, string> }).define?.__NOOBIDE_VERSION__).toBe(
      JSON.stringify(pkg.version),
    );
  });
});

describe('bundled icon files (S28.1)', () => {
  it('icon.png is a 1024×1024 PNG', () => {
    expect(pngSize(readFileSync(path.join(root, 'resources/icons/icon.png')))).toEqual({ width: 1024, height: 1024 });
  });

  it('icon.ico holds PNG images from 16 to 256 px with valid directory entries', () => {
    const ico = readFileSync(path.join(root, 'resources/icons/icon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1); // icon
    const count = ico.readUInt16LE(4);
    const sizes: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const at = 6 + i * 16;
      const declared = ico[at] === 0 ? 256 : (ico[at] as number);
      const length = ico.readUInt32LE(at + 8);
      const offset = ico.readUInt32LE(at + 12);
      expect(offset + length).toBeLessThanOrEqual(ico.length);
      expect(pngSize(ico.subarray(offset, offset + length))).toEqual({ width: declared, height: declared });
      sizes.push(declared);
    }
    expect(sizes).toEqual(expect.arrayContaining([16, 24, 32, 48, 64, 128, 256]));
  });

  it('icon.icns holds PNG images up to 1024 px (512@2x) with consistent lengths', () => {
    const icns = readFileSync(path.join(root, 'resources/icons/icon.icns'));
    expect(icns.toString('ascii', 0, 4)).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const found: Record<string, number> = {};
    for (let at = 8; at < icns.length;) {
      const type = icns.toString('ascii', at, at + 4);
      const length = icns.readUInt32BE(at + 4);
      found[type] = pngSize(icns.subarray(at + 8, at + length)).width;
      at += length;
    }
    expect(found).toMatchObject({ icp4: 16, icp5: 32, ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic14: 512 });
  });
});
