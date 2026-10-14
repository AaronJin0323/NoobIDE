import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchApp } from './launch';

/**
 * S24.4 end to end: the light / dark / system theme and the code font zoom are saved in the app settings and come
 * back after a restart; the choice is made from the in-window menu (a radio group with a check mark) or the native
 * View menu.
 */
let tmp: string;
let userData: string;

test.beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-theme-e2e-'));
  userData = path.join(tmp, '用户 数据');
});

test.afterEach(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

async function start() {
  const app = await launchApp({}, { userDataDir: userData });
  const page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  return { app, page };
}

const settingsFile = async () =>
  JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8').catch(() => '{}')) as Record<string, unknown>;

const nativeChecked = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.checked, id);

test('the theme choice and the code zoom persist across a restart (S24.4)', async () => {
  let { app, page } = await start();
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme-choice', 'system');
  // Following the system: the scheme is the system's.
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveAttribute('data-theme', 'dark');

  // The in-window menu offers the theme as a radio group; the current choice has a check mark, not only a colour.
  await page.getByTestId('app-menu').click();
  const system = page.getByTestId('menu-theme-system');
  await expect(system).toHaveAttribute('role', 'menuitemradio');
  await expect(system).toHaveAttribute('aria-checked', 'true');
  await expect(system).toContainText('✓');
  await page.getByTestId('menu-theme-light').click();
  await expect(html).toHaveAttribute('data-theme', 'light'); // even though the system is dark
  await expect(html).toHaveAttribute('data-theme-choice', 'light');
  await page.getByTestId('app-menu').click();
  await expect(page.getByTestId('menu-theme-light')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('menu-theme-system')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('menu-theme-system')).not.toContainText('✓');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await nativeChecked(app, 'theme-light')) === true).toBe(true);

  await page.keyboard.press('ControlOrMeta+=');
  await page.keyboard.press('ControlOrMeta+=');
  await expect(page.getByTestId('zoom-reset')).toHaveText('18');
  await expect.poll(settingsFile).toMatchObject({ theme: 'light', editorFontSize: 18 });
  await app.close();

  ({ app, page } = await start());
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('zoom-reset')).toHaveText('18');
  await expect.poll(async () => (await nativeChecked(app, 'theme-light')) === true).toBe(true);

  // The native View menu changes it too.
  await app.evaluate(({ Menu }) => (Menu.getApplicationMenu()?.getMenuItemById('theme-dark')?.click as () => void)());
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(settingsFile).toMatchObject({ theme: 'dark', editorFontSize: 18 });
  await app.close();
});
