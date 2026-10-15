import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, tempRoot } from './launch';
import { collectConsoleErrors, openProject } from './project';
import { waitForPreviewState } from './preview-helpers';

/**
 * A beginner's 404s, end to end in a project whose path has Chinese characters and spaces:
 * - a misspelled image path is explained with the similarly named file the project has (the app supplies the
 *   project's file list to the explanation rules);
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
