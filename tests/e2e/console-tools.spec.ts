import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { makeProject, openProject } from './project';
import { evalInPreview, waitForPreviewState } from './preview-helpers';

/**
 * S49.4 end to end: the page console follows new output while the reader has not moved it, stays where the reader
 * scrolled to when new lines arrive (Jump to latest shows the number of new lines and brings the end back), filters
 * lines by a case-insensitive search (Chinese too), copies one line or every shown line to the clipboard, and keeps
 * its 200-line window.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>console</title>
<h1>console</h1>
<script>
  for (let i = 1; i <= 60; i += 1) console.log('line ' + i);
  console.log('Hello WORLD');
  console.warn('按钮被点击了');
</script>
`;

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-console-'));
  await writeFile(path.join(root, 'index.html'), PAGE);
  app = await launchApp();
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
  await expect(lines()).toHaveCount(62, { timeout: 20_000 });
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

const consoleView = () => page.getByTestId('preview-console');
const lines = () => consoleView().locator('li.preview-console-line');
const scroller = () => page.getByTestId('console-scroller');
const distanceFromEnd = () => scroller().evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop));
const clipboard = () => app.evaluate(({ clipboard: c }) => c.readText());

test('the list follows new output while it is pinned', async () => {
  await expect.poll(distanceFromEnd).toBeLessThanOrEqual(2);
  await evalInPreview(app, `console.log('pinned follow'); 1`);
  await expect(lines().last()).toContainText('pinned follow');
  await expect.poll(distanceFromEnd).toBeLessThanOrEqual(2);
  await expect(page.getByTestId('console-jump')).toHaveCount(0);
});

test('a reader who scrolled up stays put; Jump to latest counts the new lines and returns to the end', async () => {
  await scroller().hover();
  await page.mouse.wheel(0, -2000);
  await expect.poll(() => scroller().evaluate((el) => el.scrollTop)).toBeLessThan(50);
  await evalInPreview(app, `for (let i = 1; i <= 5; i += 1) console.log('late ' + i); 1`);
  await expect(lines().last()).toContainText('late 5');
  const jump = page.getByTestId('console-jump');
  await expect(jump).toBeVisible();
  await expect(page.getByTestId('console-jump-count')).toHaveText('5 行新输出');
  expect(await scroller().evaluate((el) => el.scrollTop)).toBeLessThan(50); // never yanked
  await jump.click();
  await expect.poll(distanceFromEnd).toBeLessThanOrEqual(2);
  await expect(jump).toHaveCount(0);
});

test('search filters the lines ignoring case, Chinese included, and says when nothing matches', async () => {
  const search = page.getByTestId('console-search');
  await search.fill('hello world');
  await expect(lines()).toHaveCount(1);
  await expect(lines().first()).toContainText('Hello WORLD');
  await search.fill('点击');
  await expect(lines()).toHaveCount(1);
  await expect(lines().first()).toHaveAttribute('data-level', 'warning');
  await search.fill('LATE');
  await expect(lines()).toHaveCount(5);
  await search.fill('不存在的输出');
  await expect(lines()).toHaveCount(0);
  await expect(consoleView()).toContainText('没有包含“不存在的输出”的输出。');
  await search.fill('');
  await expect(lines()).toHaveCount(68);
});

test('Copy line copies the words shown; Copy all visible copies every shown line', async () => {
  const row = lines().filter({ hasText: 'Hello WORLD' });
  await row.hover();
  await row.getByTestId('console-copy-line').click();
  await expect(page.getByTestId('console-copy-status')).toHaveText('已复制 1 行');
  await expect.poll(clipboard).toMatch(/^信息\s+Hello WORLD/);

  await page.getByTestId('console-search').fill('late');
  await page.getByTestId('console-copy-all').click();
  await expect(page.getByTestId('console-copy-status')).toHaveText('已复制 5 行');
  const copied = (await clipboard()).split('\n');
  expect(copied).toHaveLength(5);
  expect(copied[0]).toContain('late 1');
  expect(copied[4]).toContain('late 5');

  // The copy buttons are one tab stop; the arrows move between the lines.
  const buttons = lines().getByTestId('console-copy-line');
  await buttons.first().focus();
  await page.keyboard.press('ArrowDown');
  expect(await buttons.nth(1).evaluate((el) => el === document.activeElement)).toBe(true);
  expect(await buttons.evaluateAll((all) => all.filter((b) => (b as HTMLElement).tabIndex === 0).length)).toBe(1);
  await page.getByTestId('console-search').fill('');
});

test('the 200-line window is unchanged', async () => {
  // In batches under the page's own rate limit (decision 0016), so every line reaches the console.
  for (let batch = 0; batch < 3; batch += 1) {
    await evalInPreview(app, `for (let i = 1; i <= 50; i += 1) console.log('bulk ${batch}-' + i); 1`);
    await expect(lines().last()).toContainText(`bulk ${batch}-50`, { timeout: 20_000 });
  }
  await expect(lines()).toHaveCount(200);
  await page.getByTestId('console-search').fill('bulk');
  await expect(lines()).toHaveCount(150);
  await page.getByTestId('console-search').fill('');
  await expect(lines()).toHaveCount(200);
});

test('on a narrow pane the tools stay compact: Copy all visible shows its icon and keeps its name', async () => {
  const toolbar = page.getByTestId('console-head');
  const copyAll = page.getByTestId('console-copy-all');
  const clipped = () => copyAll.locator('.cq-label').evaluate((el) => el.getBoundingClientRect().width <= 1);
  const width = (px: string) =>
    toolbar.evaluate((el, w) => {
      (el as HTMLElement).style.width = w;
    }, px);
  await width('600px');
  expect(await clipped()).toBe(false);
  await width('400px');
  expect(await clipped()).toBe(true);
  await expect(copyAll).toHaveAccessibleName('复制显示的全部');
  await toolbar.evaluate((el) => {
    (el as HTMLElement).style.width = '';
  });
});
