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
  await page.locator('.monaco-editor .view-lines').waitFor({ state: 'attached' });
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
  // S44.4: grouped by purpose (project, appearance, language, AI, help); toggles say what they will do now.
  await expect(items).toHaveText([
    /^关闭项目$/,
    /^本地历史…$/,
    /^在(访达|文件资源管理器|文件管理器)中显示$/, // S44.4: was the folder button in the top bar
    mac ? /^显示 AI 助手⇧⌘A$/ : /^显示 AI 助手Ctrl\+Shift\+A$/, // S33, with its shortcut hint
    /^开启 AI 代码建议$/, // S32
    /^AI 设置…$/, // S31.4
    /^入门导览$/,
    /^术语表$/,
    /^打开日志文件夹$/,
  ]);
  const choices = page.getByRole('menu').getByRole('menuitemradio');
  await expect(choices).toHaveText([/跟随系统主题$/, /浅色主题$/, /深色主题$/, /简体中文$/, /English（英语）$/]);
  await expect(page.getByRole('menu').getByRole('group', { name: '外观' })).toHaveCount(1);
  await expect(page.getByRole('menu').getByRole('group', { name: '语言 · Language' })).toHaveCount(1);
  await expect(page.getByTestId('menu-language-zh-CN')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  // S44.5: the code font size moved from the editor header to the View menu and the palette, with the same hints.
  await page.getByTestId('open-palette').click();
  await page.getByTestId('palette-input').fill('放大代码字号');
  await expect(page.getByTestId('palette-zoom-in')).toContainText('放大代码字号');
  await expect(page.getByTestId('palette-zoom-in').locator('kbd')).toHaveText(mac ? '⌘+' : 'Ctrl+=');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
});

/** Every item of the open More menu: its title fits on one line at the menu's default width (S44.4). */
const menuTitlesFit = () =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.app-menu-list [role^="menuitem"]')].flatMap((item) => {
      const label = item.querySelector<HTMLElement>('.app-menu-label');
      const wraps = !label || label.scrollWidth > label.clientWidth || label.getClientRects().length !== 1;
      return wraps || item.getBoundingClientRect().height > 36 ? [item.textContent ?? ''] : [];
    }),
  );

test('no More menu title wraps or is cut off, in Chinese and English (S44.4)', async () => {
  await openFile(page, 'index.html'); // the editing commands join the menu
  for (const lang of ['zh-CN', 'en'] as const) {
    await page.getByTestId('app-menu').click();
    await expect(page.getByTestId('menu-ai-explain-code')).toBeVisible();
    expect(await menuTitlesFit()).toEqual([]);
    if (lang === 'zh-CN') {
      await page.getByTestId('menu-language-en').click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    }
  }
  // In English the toggles read "Show …" / "Turn on …", and the menu still has one checked language.
  await expect(page.getByTestId('menu-ai-toggle-chat')).toContainText('Show AI assistant');
  await expect(page.getByTestId('menu-language-en')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('menu-language-zh-CN').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
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
  await expect(page.getByTestId('rail-files')).toHaveAttribute(
    'title',
    mac ? '隐藏文件列表 (⌘B)' : '隐藏文件列表 (Ctrl+B)',
  );
  await page.keyboard.press('ControlOrMeta+B');
  await expect(page.getByTestId('region-files')).toBeHidden();
  // S44.4: the title says what the command will do now.
  await expect(page.getByTestId('rail-files')).toHaveAttribute(
    'title',
    mac ? '显示文件列表 (⌘B)' : '显示文件列表 (Ctrl+B)',
  );
  await page.keyboard.press('ControlOrMeta+B');
  await expect(page.getByTestId('region-files')).toBeVisible();
  await expect(page.getByTestId('problems-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ControlOrMeta+Shift+M');
  await expect(page.getByTestId('problems-toggle')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ControlOrMeta+Shift+M');
  await expect(page.getByTestId('problems-toggle')).toHaveAttribute('aria-expanded', 'false');
  expect(consoleErrors).toEqual([]);
});
