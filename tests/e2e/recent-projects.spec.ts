import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, tempRoot } from './launch';
import { makeProject, openProject, projectMenu } from './project';
import { previewInfo, waitForPreviewState } from './preview-helpers';

/**
 * S13.3 end to end: recent projects live in app data (a --user-data-dir with Chinese characters and spaces) and are
 * shown on the welcome screen after reopening the app; a folder that no longer exists is shown as unavailable and
 * can only be removed from the list (nothing on disk is touched); closing a project tears down the preview, its
 * server and the file watcher.
 */
test.describe.configure({ mode: 'serial' });

let tmp: string;
let userData: string;
let a: { tmp: string; root: string };
let b: { tmp: string; root: string };
let app: ElectronApplication | null = null;
let page: Page;

async function start() {
  app = await launchApp({}, { userDataDir: userData });
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
}

async function stop() {
  const current = app;
  app = null;
  await current?.close();
}

const items = () => page.getByTestId('welcome-recent-item');
const watching = () =>
  app?.evaluate(() =>
    (globalThis as unknown as { __noobideTestHooks: { watching(): boolean } }).__noobideTestHooks.watching(),
  );

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(tempRoot(), 'noobide-recent-e2e-'));
  userData = path.join(tmp, '用户 数据');
  a = await makeProject('noobide-recent-a-');
  b = await makeProject('noobide-recent-b-');
});

test.afterAll(async () => {
  await stop().catch(() => undefined);
  for (const dir of [tmp, a.tmp, b.tmp]) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

test('a project opened once is on the welcome screen after reopening the app, and opens from there (S13.3)', async () => {
  await start();
  await openProject(app as ElectronApplication, page, a.root);
  // Closed before quitting, so the next start shows the welcome screen (an open project would be restored, S13.4).
  await projectMenu(page, 'close-project');
  await expect(page.getByTestId('welcome')).toBeVisible();
  await stop();

  await start();
  await expect(items()).toHaveCount(1);
  await expect(items().first()).toContainText('中文 路径 项目');
  await expect(items().first()).toContainText(a.root);
  await expect(page.getByTestId('welcome-recent-missing')).toHaveCount(0);
  await items().first().getByRole('button', { name: '打开' }).click();
  await expect(page.getByTestId('project-name')).toHaveAttribute('title', a.root);
  await page.getByTestId('file-tree').waitFor();
});

test('closing a project stops its preview, server and watcher and shows the welcome screen (S13.3)', async () => {
  expect(await watching()).toBe(true);
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
  const { origin } = await previewInfo(app as ElectronApplication);
  expect(origin).not.toBeNull();

  await projectMenu(page, 'close-project');
  await expect(page.getByTestId('welcome')).toBeVisible();
  await expect(page.getByTestId('project-name')).toHaveText('未打开项目');
  await waitForPreviewState(page, 'stopped');
  const info = await previewInfo(app as ElectronApplication);
  expect(info.previewWebContentsId).toBeNull();
  expect(info.origin).toBeNull();
  expect(
    await fetch(`${origin}/`).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  expect(await watching()).toBe(false);
  // The closed project is still in the recent list.
  await expect(items().first()).toContainText(a.root);
});

test('a missing folder is shown as unavailable and can only be removed from the list (S13.3)', async () => {
  await openProject(app as ElectronApplication, page, b.root);
  await stop();
  await rm(b.root, { recursive: true });

  await start();
  await expect(items()).toHaveCount(2);
  const missing = items().filter({ hasText: b.root });
  await expect(missing.getByTestId('welcome-recent-missing')).toHaveText('找不到文件夹');
  await expect(missing.getByRole('button', { name: '打开' })).toHaveCount(0);
  const available = items().filter({ hasText: a.root });
  await expect(available.getByTestId('welcome-recent-missing')).toHaveCount(0);

  const before = (await readdir(a.root)).sort();
  await missing.getByRole('button', { name: '从列表移除' }).click();
  await expect(items()).toHaveCount(1);
  await expect(items().first()).toContainText(a.root);
  expect((await readdir(a.root)).sort()).toEqual(before);
  await stop();

  // The removal persisted.
  await start();
  await expect(items()).toHaveCount(1);
});
