import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, repoRoot } from './launch';

/**
 * S03.3 / S03.4 end to end: open a project whose path has Chinese characters and spaces, open a file into Monaco,
 * edit and save with Ctrl/Cmd+S, and keep edits when a save fails. The native folder dialog is replaced in main
 * with one that returns the test folder (the dialog itself cannot be driven by Playwright).
 */
// One app and one project for the whole flow; a failure must not restart the app and blur later results.
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
const consoleErrors: string[] = [];

async function answerFolderDialog(folder: string | null) {
  await app.evaluate(({ dialog }, chosen) => {
    const fake = async () => ({ canceled: chosen === null, filePaths: chosen === null ? [] : [chosen] });
    (dialog as unknown as { showOpenDialog: typeof fake }).showOpenDialog = fake;
  }, folder);
}

const status = () => page.getByTestId('save-status');
/** A row of the file tree (S08.1) by its exact name. */
const treeItem = (name: string) => page.getByTestId('file-tree').getByRole('treeitem', { name, exact: true });
const editorText = () => page.locator('.view-lines');

/**
 * Types plain text on a new last line. Markup such as `<!--` would trigger Monaco's asynchronous auto-closing, which
 * edits the buffer again after a save and makes the test race the editor instead of testing saving.
 */
async function typeAtEnd(text: string) {
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
}

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-e2e-'));
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  await mkdir(path.dirname(root), { recursive: true });
  await cp(path.join(repoRoot, 'tests', 'fixtures', '中文 路径 项目'), root, { recursive: true });
  await writeFile(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
  app = await launchApp();
  page = await app.firstWindow();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.locator('.monaco-editor .view-lines').waitFor();
});

test.afterAll(async () => {
  await app?.close();
  await chmod(path.join(root, 'index.html'), 0o644).catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

test('cancelling the folder dialog changes nothing (S03.3)', async () => {
  await answerFolderDialog(null);
  await page.getByTestId('open-folder').click();
  await expect(page.getByTestId('project-name')).toHaveText('未打开项目');
  await expect(page.getByTestId('sample-badge')).toBeVisible();
});

test('opens a folder with Chinese characters and spaces and lists its files (S03.3)', async () => {
  await answerFolderDialog(root);
  await page.getByTestId('open-folder').click();
  await expect(page.getByTestId('project-name')).toHaveText('中文 路径 项目');
  await expect(page.getByTestId('project-path')).toHaveText(root);
  await expect(treeItem('index.html')).toBeVisible();
  await expect(treeItem('子 文件夹')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('sample-badge')).toHaveCount(0);
  await expect(status()).toHaveText('没有打开的文件');
});

test('clicking a file opens it in Monaco (S03.3)', async () => {
  await treeItem('index.html').click();
  await expect(page.getByTestId('editor-tab')).toHaveText('index.html');
  await expect(editorText()).toContainText('你好，我是林小雨');
  await expect(status()).toHaveText('已保存');
  await expect(treeItem('index.html')).toHaveAttribute('aria-current', 'true');
});

test('edits are saved to disk with Ctrl/Cmd+S (S03.4)', async () => {
  await typeAtEnd('第一次保存');
  await expect(status()).toHaveText('未保存');
  await page.keyboard.press('ControlOrMeta+S');
  await expect(status()).toHaveText('已保存');
  expect(await readFile(path.join(root, 'index.html'), 'utf8')).toContain('第一次保存');
});

test('a language switch keeps unsaved edits in the editor', async () => {
  await typeAtEnd('切换语言');
  await page.getByTestId('switch-language').click();
  await expect(status()).toHaveText('Unsaved');
  await expect(editorText()).toContainText('切换语言');
  await page.getByTestId('switch-language').click();
  await expect(status()).toHaveText('未保存');
  await page.keyboard.press('ControlOrMeta+S');
  await expect(status()).toHaveText('已保存');
});

test('a failed save keeps the edits, explains the cause and succeeds after the fix (S03.4)', async () => {
  const file = path.join(root, 'index.html');
  const onDisk = await readFile(file, 'utf8');
  await chmod(file, 0o444);
  await typeAtEnd('只读时的修改');
  await page.keyboard.press('ControlOrMeta+S');
  await expect(status()).toHaveText('保存失败 — 你的修改还在');
  await expect(page.getByTestId('save-error')).toContainText('没有写入权限');
  await expect(page.getByTestId('save-error')).toContainText('你的修改还在编辑器里');
  await expect(editorText()).toContainText('只读时的修改');
  expect(await readFile(file, 'utf8')).toBe(onDisk);

  await chmod(file, 0o644);
  await page.keyboard.press('ControlOrMeta+S');
  await expect(status()).toHaveText('已保存');
  await expect(page.getByTestId('save-error')).toHaveCount(0);
  expect(await readFile(file, 'utf8')).toContain('只读时的修改');
});

test('switching files saves unsaved edits first (no edit is dropped)', async () => {
  await typeAtEnd('切换文件前');
  await treeItem('style.css').click();
  await expect(page.getByTestId('editor-tab')).toHaveText('style.css');
  await expect(editorText()).toContainText('#2f5d43');
  expect(await readFile(path.join(root, 'index.html'), 'utf8')).toContain('切换文件前');
});

test('a nested file with a Chinese name opens and saves (S03.4)', async () => {
  await treeItem('子 文件夹').click();
  await treeItem('页面 二.html').click();
  await expect(editorText()).toContainText('第二页');
  await typeAtEnd('第三页');
  await page.keyboard.press('ControlOrMeta+S');
  await expect(status()).toHaveText('已保存');
  expect(await readFile(path.join(root, '子 文件夹', '页面 二.html'), 'utf8')).toContain('第三页');
});

test('a binary file is refused instead of being opened as text', async () => {
  await treeItem('logo.png').click();
  await expect(page.getByTestId('open-error')).toContainText('不是 UTF-8 文本');
  await expect(status()).toHaveText('没有打开的文件');
});

test('no console errors during the file run', async () => {
  expect(consoleErrors).toEqual([]);
});
