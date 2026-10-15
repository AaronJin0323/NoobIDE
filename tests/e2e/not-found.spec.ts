import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, tempRoot } from './launch';
import { collectConsoleErrors, openFile, openProject, typeAtEnd } from './project';
import { evalInPreview, waitForPreviewState } from './preview-helpers';

/**
 * A beginner's 404s, end to end in a project whose path has Chinese characters and spaces:
 * - a misspelled image path is explained with the similarly named file the project has (the app supplies the
 *   project's file list to the explanation rules);
 * - a link to a page that does not exist shows a localized explanation instead of a raw 404, the toolbar names the
 *   page and offers Back to entry page, and a save while the missing page shows returns to the entry page.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const INDEX =
  '<!doctype html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="utf-8" />\n    <title>我的主页</title>\n  </head>\n' +
  '  <body>\n    <h1 id="title">你好</h1>\n    <img src="images/avatr.svg" alt="头像" />\n' +
  '    <a id="about" href="about.html">关于我</a>\n  </body>\n</html>\n';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>\n';

const toggle = () => page.getByTestId('problems-toggle');
const resourceRow = (text: string) =>
  page.locator('[data-section="resource"]').getByTestId('problem-row').filter({ hasText: text }).first();

async function expand(row: ReturnType<typeof resourceRow>) {
  const summary = row.getByTestId('problem-summary');
  if ((await summary.getAttribute('aria-expanded')) !== 'true') await summary.click();
  await expect(row.getByTestId('problem-card')).toBeVisible();
}

async function startPreview() {
  const state = page.getByTestId('preview-state');
  const consent = page.getByTestId('preview-consent');
  await expect
    .poll(async () => ((await consent.count()) > 0 ? 'consent' : await state.getAttribute('data-state')), {
      timeout: 20_000,
    })
    .toMatch(/^(consent|starting|running)$/);
  if ((await consent.count()) > 0) await page.getByTestId('preview-consent-start').click();
  await waitForPreviewState(page, 'running');
}

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(tempRoot(), 'noobide-404-'));
  root = path.join(tmp, '我的 网页', '个人 主页');
  await mkdir(path.join(root, 'images'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), INDEX);
  await writeFile(path.join(root, 'images', 'avatar.svg'), SVG);
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await startPreview();
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('a misspelled image path names the similar file the project has (images/avatr.svg → avatar.svg)', async () => {
  await expect(toggle()).toContainText(/\d+ 个错误/, { timeout: 30_000 });
  await toggle().click();
  await expect(page.getByTestId('problems-panel')).toBeVisible();
  const row = resourceRow('images/avatr.svg');
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expand(row);
  const card = row.getByTestId('problem-card');
  await expect(card.getByTestId('problem-card-title')).toContainText('图片 images/avatr.svg 没有加载出来（404）');
  await expect(card.getByTestId('problem-causes')).toContainText(
    '文件名可能拼错了：项目里有一个相似的文件 images/avatar.svg。',
  );
  await page.getByTestId('switch-language').click();
  await expect(card.getByTestId('problem-causes')).toContainText(
    'The file name may be misspelled: the project has a similar file, images/avatar.svg.',
  );
  await page.getByTestId('switch-language').click();
  await toggle().click();
  expect(consoleErrors).toEqual([]);
});

const pagePath = () => page.getByTestId('preview-page-path');
const missing = () => page.getByTestId('preview-page-missing');
const backToEntry = () => page.getByTestId('preview-go-to-entry');
const previewTitle = () => evalInPreview<string>(app, 'document.title');

async function clickBrokenLink() {
  await evalInPreview(app, `document.getElementById('about').click(); true`);
  await expect(pagePath()).toHaveText('about.html');
  await expect(missing()).toHaveText('这个页面不存在');
  // The page itself explains, in the interface language (not a raw "404 Not Found").
  await expect.poll(previewTitle).toBe('找不到这个页面');
  expect(await evalInPreview<string>(app, 'document.body.innerText')).toContain('项目里没有 about.html 这个文件');
}

test('a broken link never traps the preview: the page says so, Back to entry page and a save both lead home', async () => {
  await expect(pagePath()).toHaveText('index.html');
  await expect(backToEntry()).toHaveCount(0); // already on the entry page
  await clickBrokenLink();
  // The toolbar offers the way back; it works from the keyboard.
  await expect(backToEntry()).toHaveText('回到入口页面');
  await backToEntry().focus();
  await page.keyboard.press('Enter');
  await expect(pagePath()).toHaveText('index.html');
  await expect(missing()).toHaveCount(0);
  await expect(backToEntry()).toHaveCount(0);
  await expect.poll(previewTitle).toBe('我的主页');

  // Saving a file while the missing page shows: the automatic refresh goes back to the entry page instead of
  // reloading the 404.
  await clickBrokenLink();
  await openFile(page, 'index.html');
  await typeAtEnd(page, '<!-- 保存 -->');
  await page.keyboard.press('ControlOrMeta+S');
  await expect(pagePath()).toHaveText('index.html', { timeout: 20_000 });
  await expect(missing()).toHaveCount(0);
  await expect.poll(previewTitle).toBe('我的主页');

  // The problem card names the missing page and the link to check.
  await toggle().click();
  const row = resourceRow('about.html');
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expand(row);
  const card = row.getByTestId('problem-card');
  await expect(card.getByTestId('problem-card-title')).toContainText('页面 about.html 不存在（404）');
  await expect(card.getByTestId('problem-checks')).toContainText('检查 index.html 里这个链接的 href');

  // In English, the toolbar and the page speak English too.
  await page.getByTestId('switch-language').click();
  await evalInPreview(app, `document.getElementById('about').click(); true`);
  await expect(missing()).toHaveText('This page does not exist');
  await expect.poll(previewTitle).toBe('Page not found');
  await expect(backToEntry()).toHaveText('Back to entry page');
  await backToEntry().click();
  await expect(pagePath()).toHaveText('index.html');
  await page.getByTestId('switch-language').click();
  await toggle().click();
  expect(consoleErrors).toEqual([]);
});
