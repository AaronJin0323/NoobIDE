import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { makeProject, openProject, treeRow } from './project';
import { evalInPreview, previewInfo, waitForPreviewState } from './preview-helpers';

/**
 * S13.2 end to end, project path with Chinese characters and spaces: "Set as entry page" writes only
 * `.noobide/project.json` (relative path, version, nothing else), the preview opens that page, and after the user
 * deletes `.noobide` the project is an ordinary website that previews from index.html again.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
const ENTRY = '子 文件夹/页面 二.html';

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-config-e2e-'));
  app = await launchApp();
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

test('"set as entry page" stores a relative entry in .noobide/project.json only (S13.2)', async () => {
  const before = (await readdir(root)).sort();
  await treeRow(page, '子 文件夹').click();
  await treeRow(page, ENTRY).click({ button: 'right' });
  const menu = page.getByTestId('tree-menu');
  await menu.getByRole('menuitem', { name: '设为入口页面' }).click();
  await expect(page.getByTestId('entry-notice')).toContainText(ENTRY);
  await expect(page.getByTestId('entry-notice')).toHaveAttribute('data-state', 'set');

  const raw = await readFile(path.join(root, '.noobide', 'project.json'), 'utf8');
  expect(JSON.parse(raw)).toEqual({ version: 1, entry: ENTRY });
  expect(raw).not.toContain(root);
  expect((await readdir(root)).sort()).toEqual([...before, '.noobide'].sort());
  expect(await readdir(path.join(root, '.noobide'))).toEqual(['project.json']);
  // CSS files are not pages: the command is not offered.
  await page.getByTestId('entry-notice-dismiss').click();
  await treeRow(page, 'style.css').click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: '设为入口页面' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('the preview opens the entry page; without .noobide it opens index.html (S13.2)', async () => {
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
  const encoded = ENTRY.split('/').map(encodeURIComponent).join('/');
  expect((await previewInfo(app)).status.url).toMatch(
    new RegExp(`/${encoded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  );
  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');

  await rm(path.join(root, '.noobide'), { recursive: true });
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
  const info = await previewInfo(app);
  expect(info.status.url).toBe(`${info.origin}/`);
  expect(await evalInPreview<string>(app, 'document.title')).toBe('我的 主页');
  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');
});

test('a folder without index.html previews its first page instead of 404', async () => {
  // The user's page is not called index.html (e.g. a folder with only "主页.html" and a stylesheet).
  await rm(path.join(root, 'index.html'));
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
  const info = await previewInfo(app);
  expect(info.status.url).not.toBe(`${info.origin}/`);
  expect(await evalInPreview<string>(app, 'document.body.innerText')).not.toContain('Not Found');
  expect(await evalInPreview<string>(app, "document.contentType + ' ' + location.pathname")).toMatch(
    /^text\/html .*\.html$/,
  );
  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');
});
