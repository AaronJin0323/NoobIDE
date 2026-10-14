import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { collectConsoleErrors, makeProject, openFile, openProject, tabOf, treeRow, typeAtEnd } from './project';

/**
 * S24.1 command registry, end to end: the platform's shortcuts run registry commands wherever the focus is, the
 * in-window menu and the tooltips show the hints in the platform's notation (⌘S on macOS, Ctrl+S on Windows).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];
let mac: boolean;

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-commands-'));
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  mac = (await page.evaluate(() => window.noobide?.platform)) === 'mac';
  await openProject(app, page, root);
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('the command menu derives its items and shortcut hints from the registry', async () => {
  await page.getByTestId('app-menu').click();
  const items = page.getByRole('menu').getByRole('menuitem');
  await expect(items).toHaveText([/^关闭项目$/, /^本地历史…$/, /^打开日志文件夹$/]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByTestId('zoom-in')).toHaveAttribute(
    'title',
    mac ? '放大代码字号 (⌘+)' : '放大代码字号 (Ctrl+=)',
  );
});

test('⌘S / Ctrl+S saves even when the focus is outside the editor', async () => {
  await openFile(page, 'index.html');
  await typeAtEnd(page, 'saved by shortcut');
  await expect(page.getByTestId('save-status')).toHaveAttribute('title', mac ? '保存 (⌘S)' : '保存 (Ctrl+S)');
  await treeRow(page, 'style.css').focus();
  await page.keyboard.press('ControlOrMeta+S');
  await expect.poll(() => readFile(path.join(root, 'index.html'), 'utf8')).toContain('saved by shortcut');
  // The other platform's modifier is not a shortcut here.
  await page.keyboard.press(mac ? 'Control+S' : 'Meta+S');
});

test('Ctrl+Tab switches tabs and ⌘W / Ctrl+W closes the active one', async () => {
  await openFile(page, 'style.css');
  await page.keyboard.press('Control+Tab');
  await expect(tabOf(page, 'index.html')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+Shift+Tab');
  await expect(tabOf(page, 'style.css')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ControlOrMeta+W');
  await expect(tabOf(page, 'style.css')).toHaveCount(0);
  await expect(tabOf(page, 'index.html')).toHaveAttribute('aria-selected', 'true');
});

test('⌘B / Ctrl+B toggles the files and ⌘⇧M / Ctrl+Shift+M the problems panel', async () => {
  await page.keyboard.press('ControlOrMeta+B');
  await expect(page.getByTestId('region-files')).toBeHidden();
  await page.keyboard.press('ControlOrMeta+B');
  await expect(page.getByTestId('region-files')).toBeVisible();
  await expect(page.getByTestId('problems-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ControlOrMeta+Shift+M');
  await expect(page.getByTestId('problems-toggle')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ControlOrMeta+Shift+M');
  await expect(page.getByTestId('problems-toggle')).toHaveAttribute('aria-expanded', 'false');
  expect(consoleErrors).toEqual([]);
});
