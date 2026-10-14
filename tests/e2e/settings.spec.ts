import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './launch';

/**
 * S13.1 end to end: settings live in the app-data directory (here a fresh --user-data-dir whose path has Chinese
 * characters and spaces), survive a restart, and a corrupt settings file is backed up and reset with a notice.
 */
let tmp: string;
let userData: string;

test.beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-settings-e2e-'));
  userData = path.join(tmp, '用户 数据');
});

test.afterEach(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

async function start() {
  const app = await launchApp({}, { userDataDir: userData });
  const page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  return { app, page };
}

test('the interface language and code zoom persist across a restart (S13.1)', async () => {
  let { app, page } = await start();
  await expect(page.getByTestId('project-name')).toHaveText('未打开项目');
  await page.getByTestId('switch-language').click();
  await expect(page.getByTestId('project-name')).toHaveText('No project open');
  await page.getByTestId('zoom-in').click();
  await expect(page.getByTestId('zoom-reset')).toHaveText('17');
  await expect
    .poll(async () => JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8').catch(() => '{}')))
    .toMatchObject({ version: 1, locale: 'en', editorFontSize: 17 });
  await app.close();

  ({ app, page } = await start());
  await expect(page.getByTestId('project-name')).toHaveText('No project open');
  await expect(page.getByTestId('zoom-reset')).toHaveText('17');
  await expect(page.getByTestId('settings-notice')).toHaveCount(0);
  await app.close();
});

test('a corrupt settings file is backed up, reset to defaults and explained (S13.1)', async () => {
  // A first run creates the app-data folder; then the file is damaged as by a crash or a bad manual edit.
  const first = await start();
  await first.app.close();
  await writeFile(path.join(userData, 'settings.json'), '{"locale": "en", ');

  const { app, page } = await start();
  const notice = page.getByTestId('settings-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('设置文件已损坏');
  await expect(page.getByTestId('project-name')).toHaveText('未打开项目'); // defaults: zh-CN
  const names = await readdir(userData);
  const backup = names.find((n) => n.startsWith('settings.corrupt-') && n.endsWith('.json'));
  expect(backup).toBeDefined();
  await expect(notice).toContainText(backup ?? '');
  expect(await readFile(path.join(userData, backup ?? ''), 'utf8')).toBe('{"locale": "en", ');
  expect(JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8'))).toMatchObject({
    version: 1,
    locale: 'zh-CN',
  });
  await page.getByTestId('settings-notice-dismiss').click();
  await expect(notice).toHaveCount(0);
  await app.close();
});
