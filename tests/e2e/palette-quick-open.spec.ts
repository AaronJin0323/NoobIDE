import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { axeScan } from './a11y-helpers';
import { collectConsoleErrors, makeProject, openFile, openProject } from './project';

/**
 * S51.5 quick open, end to end: Ctrl/Cmd+P opens the command palette in files mode over the project index; recently
 * opened files come first while the query is empty; ignored and dot files are never offered; Enter opens the file in a
 * tab; typing ">" switches to the commands.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const palette = () => page.getByTestId('command-palette');
const input = () => page.getByTestId('palette-input');
const files = () => page.getByTestId('palette-file');
const tab = (relPath: string) => page.locator(`[data-testid="tab"][data-path="${relPath}"] [role="tab"]`);

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-quick-open-'));
  await writeFile(path.join(root, '.secret.html'), '<p>hidden</p>');
  await mkdir(path.join(root, 'node_modules', 'lib'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'lib', 'index.js'), '');
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('Ctrl/Cmd+P lists recently opened files first; ignored and dot files are never offered', async () => {
  await openFile(page, 'style.css');
  await openFile(page, 'script.js');
  await page.keyboard.press('ControlOrMeta+P');
  await expect(palette()).toHaveAttribute('data-mode', 'files');
  await expect(input()).toBeFocused();
  await expect(input()).toHaveAttribute('placeholder', '输入文件名查找；输入 > 改为搜索命令');
  await expect(files().nth(0)).toHaveAttribute('data-path', 'script.js');
  await expect(files().nth(1)).toHaveAttribute('data-path', 'style.css');
  await expect(files().nth(0)).toContainText('最近打开');
  const listed = await files().evaluateAll((els) => els.map((el) => el.getAttribute('data-path')));
  expect(listed).toEqual(expect.arrayContaining(['index.html', 'README.md', '子 文件夹/页面 二.html']));
  expect(listed.some((p) => p?.startsWith('.') || p?.includes('node_modules'))).toBe(false);
  await expect(page.getByTestId('palette-count')).toHaveText(`找到 ${listed.length} 个文件`);
  expect(await axeScan(page)).toEqual([]);
});

test('fuzzy matching over names and folders with Chinese characters and spaces; Enter opens the file', async () => {
  await page.keyboard.type('页二');
  await expect(files()).toHaveCount(1);
  await expect(files().first()).toHaveAttribute('data-path', '子 文件夹/页面 二.html');
  await expect(files().first()).toContainText('子 文件夹/');
  await page.keyboard.press('Enter');
  await expect(palette()).toHaveCount(0);
  await expect(tab('子 文件夹/页面 二.html')).toHaveAttribute('aria-selected', 'true');

  // An exact file name comes first; nothing matches: the empty state explains.
  await page.keyboard.press('ControlOrMeta+P');
  await page.keyboard.type('index.html');
  await expect(files().first()).toHaveAttribute('data-path', 'index.html');
  await input().fill('不存在的文件 zzz');
  await expect(page.getByTestId('palette-empty')).toContainText('项目里没有这个名字的文件');
  await page.keyboard.press('Escape');
  await expect(palette()).toHaveCount(0);
});

test('typing ">" switches to the commands', async () => {
  await page.keyboard.press('ControlOrMeta+P');
  await page.keyboard.type('>');
  await expect(palette()).toHaveAttribute('data-mode', 'commands');
  await page.keyboard.type('保存');
  await expect(page.getByTestId('palette-save')).toBeVisible();
  // Back to files when the ">" is removed.
  await input().fill('');
  await expect(palette()).toHaveAttribute('data-mode', 'files');
  await page.keyboard.press('Escape');
});

test('Go to File is in the View menu and the command palette', async () => {
  const labels = await app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) => item.label === '视图');
    return view?.submenu?.items.map((item) => item.label) ?? [];
  });
  expect(labels).toContain('按名称打开文件…');
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await expect(palette()).toHaveAttribute('data-mode', 'commands');
  await page.keyboard.type('打开文件');
  await expect(page.getByTestId('palette-quick-open')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('no console errors', () => {
  expect(consoleErrors).toEqual([]);
});
