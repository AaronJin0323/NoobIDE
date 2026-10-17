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

test('the two in-window menus derive their items and shortcut hints from the registry (S47.4)', async () => {
  // The project menu next to the project name: close, reveal (a platform label), history, lessons.
  await page.getByTestId('project-menu').click();
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText([
    /^关闭项目$/,
    mac ? /^在访达中显示$/ : /^在文件资源管理器中显示$/,
    /^历史版本…$/,
    /^项目检查点…$/, // S56.2
    /^课程$/,
  ]);
  await expect(page.getByTestId('project-path')).toHaveText(root);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  // The help/more menu at the end of the bar: theme and language choices, then AI, glossary, logs, settings.
  await page.getByTestId('app-menu').click();
  await expect(page.getByRole('menu').getByRole('menuitemradio')).toHaveText([
    /跟随系统的浅色或深色主题$/, // the current choice carries a ✓ (S24.4)
    /^浅色主题$/,
    /^深色主题$/,
    /中文$/,
    /^English$/,
    /宽松密度$/, // S50.4: the density choice (comfortable is the default, checked)
    /^紧凑密度$/,
  ]);
  const items = page.getByRole('menu').getByRole('menuitem');
  await expect(items).toHaveText([
    /^显示或隐藏“问 AI”/, // S33 (with its shortcut hint)
    /^开启或关闭 AI 建议$/, // S32
    /^术语表$/,
    /^打开日志文件夹$/,
    /^AI 设置…$/, // S31.4
  ]);
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
