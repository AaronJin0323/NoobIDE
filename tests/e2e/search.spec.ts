import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { axeScan } from './a11y-helpers';
import { collectConsoleErrors, makeProject, openProject } from './project';

/**
 * S51.3 find in files, end to end: Ctrl/Cmd+Shift+F opens the Search panel in the bottom region; options are toggles
 * named for assistive technology; results are grouped by file and open at their line and column; every state explains
 * itself in zh-CN and en; the whole flow works from the keyboard.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const panel = () => page.getByTestId('search-panel');
const input = () => page.getByTestId('search-input');
const status = () => page.getByTestId('search-status');
const hits = () => page.getByTestId('search-hit');
const cursor = () => page.getByTestId('cursor-position');

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-search-'));
  // 2 100 matches in one file: more than the search lists (2 000), so the truncated state can be shown.
  await writeFile(path.join(root, '笔记 很多.txt'), 'needle\n'.repeat(2100));
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('without a project the panel explains how to start, in both languages', async () => {
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(panel()).toBeVisible();
  await expect(status()).toHaveAttribute('data-kind', 'no-project');
  await expect(status()).toHaveText('打开一个项目文件夹后，就能在它的所有文件里查找。');
  await expect(input()).toHaveCount(0); // nothing to type into yet, and no disabled decoration (S30.3)
  await page.getByTestId('switch-language').click();
  await expect(status()).toHaveText('Open a project folder to search all of its files.');
  await page.getByTestId('switch-language').click();
  await expect(status()).toHaveText('打开一个项目文件夹后，就能在它的所有文件里查找。');
});

test('Ctrl/Cmd+Shift+F opens the Search panel beside Problems; toggles are named, pressed state is not colour alone', async () => {
  await openProject(app, page, root);
  await page.getByTestId('problems-toggle').click();
  await expect(page.getByTestId('problems-panel')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+F');
  // One bottom panel at a time: Search replaces Problems, which stays one click away in the status strip.
  await expect(panel()).toBeVisible();
  await expect(page.getByTestId('problems-panel')).toBeHidden();
  await expect(page.getByTestId('search-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(input()).toBeFocused();
  await expect(status()).toHaveAttribute('data-kind', 'idle');

  const toggle = (option: string) => page.getByTestId(`search-toggle-${option}`);
  await expect(toggle('caseSensitive')).toHaveAccessibleName('区分大小写');
  await expect(toggle('wholeWord')).toHaveAccessibleName('全字匹配');
  await expect(toggle('regex')).toHaveAccessibleName('使用正则表达式');
  for (const option of ['caseSensitive', 'wholeWord', 'regex']) {
    await expect(toggle(option)).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle(option).locator('svg')).toHaveCount(1); // an icon, plus the name above
  }
  await toggle('caseSensitive').click();
  await expect(toggle('caseSensitive')).toHaveAttribute('aria-pressed', 'true');
  // Pressed also draws the selected ring (a shape), not only another colour.
  expect(await toggle('caseSensitive').evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
  await toggle('caseSensitive').click();
  await expect(toggle('caseSensitive')).toHaveAttribute('aria-pressed', 'false');
  expect(await axeScan(page)).toEqual([]);
});

test('results are grouped by file with counts and context; a click opens the file at the line and column', async () => {
  await input().fill('林小雨');
  await expect(status()).toHaveText('2 个结果，在 2 个文件里');
  const files = panel().locator('.search-file');
  await expect(files).toHaveCount(2);
  await expect(files.nth(0)).toHaveAttribute('data-path', 'index.html');
  await expect(files.nth(1)).toHaveAttribute('data-path', 'script.js');
  await expect(files.nth(0).getByTestId('search-file-count')).toHaveText('1 个');
  await expect(hits().nth(0)).toContainText('第 9 行');
  await expect(hits().nth(0)).toContainText('<h1>你好，我是林小雨</h1>');
  await expect(hits().nth(0).locator('mark')).toHaveText('林小雨');
  await hits().nth(1).click();
  await expect(page.locator('[data-testid="tab"][data-path="script.js"] [role="tab"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(cursor()).toHaveText('行 2, 列 19');
  expect(await axeScan(page)).toEqual([]);
});

test('keyboard only: open, type, move through results, open one with Enter', async () => {
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(input()).toBeFocused();
  await page.keyboard.type('林小雨');
  await page.keyboard.press('Enter'); // searches at once
  await expect(status()).toHaveText('2 个结果，在 2 个文件里');
  await page.keyboard.press('ArrowDown');
  await expect(hits().nth(0)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(hits().nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(hits().nth(0)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid="tab"][data-path="index.html"] [role="tab"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(cursor()).toHaveText('行 9, 列 14');
  // The keyboard is in the editor now; Ctrl/Cmd+Shift+F goes back to the query, Escape collapses the panel.
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(input()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel()).toBeHidden();
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(panel()).toBeVisible();
});

test('empty, invalid-regex and truncated states explain themselves in zh-CN and en', async () => {
  await input().fill('没有这个词 zzz');
  await expect(status()).toHaveAttribute('data-kind', 'empty');
  await expect(status()).toHaveText('没有找到“没有这个词 zzz”。检查一下拼写，或者关掉“区分大小写”“全字匹配”再试。');

  await page.getByTestId('search-toggle-regex').click();
  await input().fill('(card');
  await expect(status()).toHaveAttribute('data-kind', 'invalid-regex');
  await expect(status()).toContainText('这个正则表达式写得不对：');
  await expect(status()).toContainText('请关掉“使用正则表达式”');
  await page.getByTestId('switch-language').click();
  await expect(status()).toContainText('This regular expression is not valid: ');
  await page.getByTestId('search-toggle-regex').click();

  await input().fill('没有这个词 zzz');
  await expect(status()).toHaveText(
    'No results for “没有这个词 zzz”. Check the spelling, or turn off “Match case” and “Match whole word” and try again.',
  );
  await input().fill('needle');
  await expect(status()).toHaveText('2000 results in 1 file');
  await expect(page.getByTestId('search-truncated')).toHaveText(
    'Too many results: only the first 2000 are listed. Search for something more specific to see them all.',
  );
  await page.getByTestId('switch-language').click();
  await expect(page.getByTestId('search-truncated')).toHaveText(
    '结果太多，只列出了前 2000 个。把要查找的文字写得更具体一些，就能看到全部。',
  );
  await expect(status()).toHaveText('2000 个结果，在 1 个文件里');
});

test('no console errors', () => {
  expect(consoleErrors).toEqual([]);
});
