import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, tempRoot } from './launch';
import { openFile, openProject, treeRow } from './project';
import { evalInPreview, previewInfo, waitForPreviewState } from './preview-helpers';

/**
 * A beginner's project without any `.html` page (the page was saved as `html/home`, no ending) previewed as a bare
 * "404 Not Found". The preview now explains it, offers "rename to home.html" for files that start like a page, and
 * renames only when the user clicks — through the Files panel's path, so an open tab follows.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
const HOME =
  '<!DOCTYPE html>\n<html lang="en">\n<head><title>我的 主页</title></head>\n<body><h1>Home</h1></body>\n</html>\n';

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(tempRoot(), 'noobide-nopage-'));
  root = path.join(tmp, 'DESN 6006');
  await mkdir(path.join(root, 'html'), { recursive: true });
  await mkdir(path.join(root, 'styles'));
  await writeFile(path.join(root, 'html', 'home'), HOME);
  await writeFile(path.join(root, 'html', 'about'), ''); // empty: nothing to suggest
  app = await launchApp();
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

test('a project without any .html page is explained instead of showing 404, and nothing is renamed by itself', async () => {
  const noPage = page.getByTestId('preview-no-page');
  await expect(noPage).toBeVisible();
  await expect(noPage).toContainText('这个项目里还没有网页文件');
  await expect(page.getByTestId('preview-misnamed')).toHaveCount(1);
  await expect(page.getByTestId('preview-misnamed')).toContainText('html/home');
  await expect(page.getByTestId('preview-misnamed-rename')).toHaveText('改名为 home.html');
  // Started anyway (toolbar Start): the server can only answer 404, so the page view stays hidden behind the
  // explanation.
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
  await expect(noPage).toBeVisible();
  await expect.poll(async () => (await previewInfo(app)).viewVisible).toBe(false);
  expect((await readdir(path.join(root, 'html'))).sort()).toEqual(['about', 'home']);
});

test('"rename to home.html" renames on click, an open tab follows, and the preview shows the page', async () => {
  await openFile(page, 'html/home');
  await page.getByTestId('preview-misnamed-rename').click();
  await expect(page.getByTestId('preview-no-page')).toHaveCount(0);
  expect((await readdir(path.join(root, 'html'))).sort()).toEqual(['about', 'home.html']);
  expect(await readFile(path.join(root, 'html', 'home.html'), 'utf8')).toBe(HOME);
  await expect(treeRow(page, 'html/home.html')).toBeVisible();
  await expect(page.locator('[data-testid="tab"].selected')).toHaveAttribute('data-path', 'html/home.html');

  // The running preview starts again on the renamed page.
  await expect.poll(async () => (await previewInfo(app)).status.url).toMatch(/\/html\/home\.html$/);
  await waitForPreviewState(page, 'running');
  await expect.poll(async () => (await previewInfo(app)).viewVisible).toBe(true);
  expect((await previewInfo(app)).status.url).toMatch(/\/html\/home\.html$/);
  expect(await evalInPreview<string>(app, 'document.title')).toBe('我的 主页');
});
