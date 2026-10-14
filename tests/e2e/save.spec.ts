import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import {
  answerSaveDialog,
  collectConsoleErrors,
  makeProject,
  openFile,
  openProject,
  tabOf,
  typeAtEnd,
} from './project';
import { DOC_END } from './keys';

/**
 * S10 save pipeline end to end: autosave after a typing pause, the failure banner with retry and "save elsewhere",
 * byte-exact CRLF + BOM round trip, the mixed line ending notice, and S10.6 — closing the window or quitting
 * saves first and never drops edits.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const status = () => page.getByTestId('save-status');
const lines = () => page.locator('.monaco-editor .view-lines');
const disk = (relPath: string) => readFile(path.join(root, ...relPath.split('/')), 'utf8');

async function start() {
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
}

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-save-'));
  await writeFile(path.join(root, 'notes.css'), Buffer.from('﻿h1 {\r\n  color: red;\r\n}\r\n', 'utf8'));
  await writeFile(path.join(root, 'mixed.js'), 'let a = 1;\r\nlet b = 2;\nlet c = 3;\r\n');
  await start();
});

test.afterAll(async () => {
  await chmod(path.join(root, 'index.html'), 0o644).catch(() => undefined);
  await app?.close().catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

test('edits are saved automatically after a typing pause, without Ctrl/Cmd+S (S10.2)', async () => {
  await openFile(page, 'index.html');
  await typeAtEnd(page, 'AUTOSAVED');
  await expect.poll(() => disk('index.html')).toContain('AUTOSAVED');
  await expect(status()).toHaveText('已保存');
  await expect(status().locator('svg')).toHaveCount(1);
});

test('a CRLF file with a BOM keeps both, byte for byte, when edited and saved', async () => {
  await openFile(page, 'notes.css');
  await expect(page.getByTestId('mixed-eol')).toHaveCount(0);
  await typeAtEnd(page, 'TYPED');
  await page.keyboard.press('ControlOrMeta+S');
  const expected = Buffer.from('﻿h1 {\r\n  color: red;\r\n}\r\n\r\nTYPED', 'utf8');
  await expect.poll(async () => (await readFile(path.join(root, 'notes.css'))).equals(expected)).toBe(true);
});

test('a file with mixed line endings says what saving will do before anything is written', async () => {
  await openFile(page, 'mixed.js');
  await expect(page.getByTestId('mixed-eol')).toContainText('CRLF');
  expect(await disk('mixed.js')).toBe('let a = 1;\r\nlet b = 2;\nlet c = 3;\r\n');
});

test('a failed save shows the reason with retry and save-elsewhere; the copy keeps the edits (S10.3)', async () => {
  await tabOf(page, 'index.html').click();
  const file = path.join(root, 'index.html');
  const before = await disk('index.html');
  await chmod(file, 0o444);
  await typeAtEnd(page, 'KEEPME');
  await expect(status()).toHaveText('保存失败 — 你的修改还在');
  await expect(status().locator('svg')).toHaveCount(1);
  const banner = page.getByTestId('save-error');
  await expect(banner).toContainText('index.html');
  await expect(banner).toContainText('没有写入权限');
  await expect(banner).toContainText('你的修改还在编辑器里');
  await expect(banner.getByTestId('save-retry')).toHaveText('重试保存');
  await expect(lines()).toContainText('KEEPME');

  // Retrying while the cause persists fails again and still keeps everything.
  await banner.getByTestId('save-retry').click();
  await expect(status()).toHaveText('保存失败 — 你的修改还在');

  const copy = path.join(tmp, '备份 副本.html');
  await answerSaveDialog(app, copy);
  await banner.getByTestId('save-copy').click();
  await expect(page.getByTestId('save-copy-notice')).toContainText(copy);
  expect(await readFile(copy, 'utf8')).toContain('KEEPME');
  // The copy does not pretend the original was saved.
  expect(await disk('index.html')).toBe(before);
  await expect(status()).toHaveText('保存失败 — 你的修改还在');

  await answerSaveDialog(app, null);
  await banner.getByTestId('save-copy').click(); // cancelled: nothing changes
  await expect(status()).toHaveText('保存失败 — 你的修改还在');

  await chmod(file, 0o644);
  await banner.getByTestId('save-retry').click();
  await expect(status()).toHaveText('已保存');
  await expect(page.getByTestId('save-error')).toHaveCount(0);
  expect(await disk('index.html')).toContain('KEEPME');
});

test('closing the window with a failing save keeps the window open and the edits (S10.6)', async () => {
  const file = path.join(root, 'index.html');
  await chmod(file, 0o444);
  await typeAtEnd(page, 'NOTDROPPED');
  await expect(status()).toHaveText('保存失败 — 你的修改还在');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  // The workbench answers "not ok" once the save failed again; the window must still be there afterwards.
  await expect(page.getByTestId('save-error')).toBeVisible();
  await page.waitForTimeout(1500);
  expect(page.isClosed()).toBe(false);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  // The banner made the editor shorter; bring the last line into view before reading it.
  await lines().click();
  await page.keyboard.press(DOC_END);
  await expect(lines()).toContainText('NOTDROPPED');
  // A file that can never be saved must not trap the user: an explicit way out is offered.
  await expect(page.getByTestId('close-discarding')).toBeVisible();
  await chmod(file, 0o644);
});

test('closing the window saves unsaved edits first (S10.6)', async () => {
  await typeAtEnd(page, 'SAVEDONCLOSE');
  expect(consoleErrors).toEqual([]);
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await closed;
  const text = await disk('index.html');
  expect(text).toContain('NOTDROPPED');
  expect(text).toContain('SAVEDONCLOSE');
  await app.close().catch(() => undefined);
});

test('quitting the app saves unsaved edits first (S10.6)', async () => {
  await start();
  await openFile(page, 'style.css');
  await typeAtEnd(page, 'SAVEDONQUIT');
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await exited;
  expect(await disk('style.css')).toContain('SAVEDONQUIT');
});

test('after a refused close, "close without saving" closes the window and leaves the file as it was (S10.6)', async () => {
  await start();
  await openFile(page, 'script.js');
  const file = path.join(root, 'script.js');
  const before = await disk('script.js');
  await chmod(file, 0o444);
  try {
    await typeAtEnd(page, 'CANNOTSAVE');
    await expect(status()).toHaveText('保存失败 — 你的修改还在');
    await expect(page.getByTestId('close-discarding')).toHaveCount(0); // only offered after a refused close
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect(page.getByTestId('close-discarding')).toBeVisible();
    const closed = page.waitForEvent('close');
    await page.getByTestId('close-discarding').click();
    await closed;
    expect(await disk('script.js')).toBe(before);
  } finally {
    await chmod(file, 0o644);
    await app.close().catch(() => undefined);
  }
});
