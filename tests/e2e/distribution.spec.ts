import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, repoRoot } from './launch';
import { packagedExecutable } from './packaged';
import { copyFixture, openProject, previewInfo, waitForPreviewState } from './preview-helpers';

/**
 * S28.1 (docs/decisions/0012-installers-and-app-identity.md): the About dialog shows the version, and the packaged
 * app built by `electron-forge package` (npm run test:e2e packages first) carries the icon and version information.
 */
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };

test('About shows the app version and runtime versions, translated, and closes with Escape', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.locator('.monaco-editor .view-lines').waitFor();
    const electronVersion = await app.evaluate(() => process.versions.electron);
    const appVersion = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
    expect(appVersion).toBe(pkg.version);

    await page.evaluate(() => window.dispatchEvent(new Event('noobide:open-about')));
    const dialog = page.getByTestId('about-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.getByRole('heading')).toHaveText('关于 NoobIDE');
    await expect(page.getByTestId('about-version')).toHaveText(`版本 ${appVersion}`);
    await expect(page.getByTestId('about-runtime')).toContainText(`Electron ${electronVersion}`);
    await expect(page.getByTestId('about-close')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await page.getByTestId('switch-language').click();
    await page.evaluate(() => window.dispatchEvent(new Event('noobide:open-about')));
    await expect(dialog.getByRole('heading')).toHaveText('About NoobIDE');
    await expect(page.getByTestId('about-version')).toHaveText(`Version ${appVersion}`);
    await page.getByTestId('about-close').click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('the native preview view is hidden while About is open, so it cannot cover the dialog', async () => {
  const { tmp, root } = await copyFixture('预览 多文件');
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.locator('.monaco-editor .view-lines').waitFor();
    await openProject(app, page, root);
    await page.getByTestId('preview-start').click();
    await waitForPreviewState(page, 'running');
    await expect.poll(async () => (await previewInfo(app)).viewVisible).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('noobide:open-about')));
    await expect(page.getByTestId('about-dialog')).toBeVisible();
    await expect.poll(async () => (await previewInfo(app)).viewVisible).toBe(false);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await previewInfo(app)).viewVisible).toBe(true);
  } finally {
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

function plistString(plist: string, key: string): string | undefined {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1];
}

test('the packaged macOS app is native, has the icon and the package.json version', async () => {
  test.skip(process.platform !== 'darwin', 'macOS bundle check');
  const exe = packagedExecutable();
  expect(exe, 'packaged app in out/').toBeDefined();
  const contents = path.resolve(path.dirname(exe!), '..');
  const plist = readFileSync(path.join(contents, 'Info.plist'), 'utf8');
  expect(plistString(plist, 'CFBundleShortVersionString')).toBe(pkg.version);
  expect(plistString(plist, 'CFBundleVersion')).toBe(pkg.version);
  expect(plistString(plist, 'CFBundleIdentifier')).toBe('app.noobide.desktop');
  expect(plistString(plist, 'CFBundleName')).toBe('NoobIDE');
  expect(plistString(plist, 'LSApplicationCategoryType')).toBe('public.app-category.developer-tools');
  expect(plistString(plist, 'NSHumanReadableCopyright')).toMatch(/^Copyright © /);
  const iconFile = plistString(plist, 'CFBundleIconFile') ?? '';
  const bundledIcon = readFileSync(
    path.join(contents, 'Resources', iconFile.endsWith('.icns') ? iconFile : `${iconFile}.icns`),
  );
  expect(bundledIcon.equals(readFileSync(path.join(repoRoot, 'resources', 'icons', 'icon.icns')))).toBe(true);
  // PLAN §11 "native architecture": on Apple Silicon the main executable is a 64-bit Mach-O for arm64.
  const header = readFileSync(exe!).subarray(0, 8);
  expect(header.readUInt32LE(0)).toBe(0xfeedfacf);
  if (process.arch === 'arm64') expect(header.readUInt32LE(4)).toBe(0x0100000c);
});

test('the packaged Windows executable carries the version resource', async () => {
  test.skip(process.platform !== 'win32', 'Windows executable check');
  const exe = packagedExecutable();
  expect(exe && existsSync(exe), 'packaged noobide.exe in out/').toBe(true);
  const binary = readFileSync(exe!);
  // VS_VERSION_INFO strings are UTF-16LE: the metadata from forge.config.ts and the package.json version.
  for (const text of ['CompanyName', 'NoobIDE', 'ProductVersion', pkg.version, 'noobide.exe']) {
    expect(binary.indexOf(Buffer.from(text, 'utf16le')), text).toBeGreaterThan(-1);
  }
});
