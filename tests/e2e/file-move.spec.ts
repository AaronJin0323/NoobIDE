import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { makeProject, openFile, openProject, tabOf, treeRow, typeAtEnd } from './project';

/**
 * S52.1 end to end: move files and folders by dragging them in the tree and with the "Move to…" dialog, in a project
 * whose path has Chinese characters and spaces. Open tabs follow the move with their text; a folder cannot be moved
 * into itself; a move made outside NoobIDE is replayed for the open tab.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;

const tab = (relPath: string) => page.locator(`[data-testid="tab"][data-path="${relPath}"]`);

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-move-'));
  await mkdir(path.join(root, '图片 素材'));
  await writeFile(path.join(root, '图片 素材', '说明.txt'), '素材\n');
  await mkdir(path.join(root, '外部 移动')); // an existing folder: the watcher pairs the move into it
  app = await launchApp();
  page = await app.firstWindow();
  await openProject(app, page, root);
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

async function openMenu(relPath: string) {
  await treeRow(page, relPath).click({ button: 'right' });
  await expect(page.getByTestId('tree-menu')).toBeVisible();
}

test('"Move to…" moves an edited open file; its tab follows with the text (S52.1)', async () => {
  await openFile(page, 'style.css');
  await typeAtEnd(page, '/* 移动前的修改 */');
  await openMenu('style.css');
  await page.locator('[data-command="move-to"]').click();
  const dialog = page.getByTestId('move-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox')).toBeFocused();
  // Keyboard only: filter, then Enter on the folder.
  await page.keyboard.type('图片');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(tab('图片 素材/style.css')).toBeVisible();
  await expect(tab('style.css')).toHaveCount(0);
  await expect(tabOf(page, '图片 素材/style.css')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.view-lines')).toContainText('移动前的修改');
  await expect(page.getByTestId('file-op-notice')).toHaveText('已移动到“图片 素材”。');
  await expect.poll(() => readFile(path.join(root, '图片 素材', 'style.css'), 'utf8')).toContain('移动前的修改');
  expect(await readdir(root)).not.toContain('style.css');
});

test('a folder cannot be moved into itself: the dialog shows why (S52.1)', async () => {
  await openMenu('子 文件夹');
  await page.locator('[data-command="move-to"]').click();
  const option = page.locator('[data-testid="move-option"][data-folder="子 文件夹"]');
  await expect(option).toHaveAttribute('aria-disabled', 'true');
  await expect(option).toContainText('不能把文件夹移动到它自己里面');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('move-dialog')).toHaveCount(0);
});

test('Enter pressed before the folder list has loaded still moves, once it loads (S52.1)', async () => {
  await mkdir(path.join(root, '慢 目标'));
  await writeFile(path.join(root, '慢 文件.txt'), '慢\n');
  await expect(treeRow(page, '慢 目标')).toBeVisible();
  await expect(treeRow(page, '慢 文件.txt')).toBeVisible();
  const hooks = (fn: 'holdListings' | 'releaseListings') =>
    app.evaluate((_electron, name) => {
      (
        globalThis as unknown as { __noobideTestHooks: Record<'holdListings' | 'releaseListings', () => void> }
      ).__noobideTestHooks[name]();
    }, fn);
  await openMenu('慢 文件.txt');
  await hooks('holdListings');
  try {
    await page.locator('[data-command="move-to"]').click();
    const dialog = page.getByTestId('move-dialog');
    await expect(dialog.getByRole('combobox')).toBeFocused();
    await page.keyboard.type('慢');
    await page.keyboard.press('Enter');
    // The folders are still being listed: no options yet and nothing moved; the Enter waits for the list.
    await expect(dialog.getByRole('option')).toHaveCount(0);
    expect(await readdir(root)).toContain('慢 文件.txt');
  } finally {
    await hooks('releaseListings');
  }
  await expect(page.getByTestId('move-dialog')).toHaveCount(0);
  await expect.poll(() => readdir(path.join(root, '慢 目标'))).toEqual(['慢 文件.txt']);
});

test('dragging a file onto a folder row moves it there (S52.1)', async () => {
  await openFile(page, 'script.js');
  await treeRow(page, 'script.js').dragTo(treeRow(page, '子 文件夹'));
  await expect.poll(() => readdir(path.join(root, '子 文件夹')).catch(() => [])).toContain('script.js');
  await expect(tab('子 文件夹/script.js')).toBeVisible();
  await expect(tab('script.js')).toHaveCount(0);
});

test('dragging a folder with an open file moves the folder; the tab follows (S52.1)', async () => {
  await openFile(page, '子 文件夹/页面 二.html');
  await treeRow(page, '子 文件夹').dragTo(treeRow(page, '图片 素材'));
  await expect.poll(() => readdir(path.join(root, '图片 素材', '子 文件夹')).catch(() => [])).toContain('页面 二.html');
  await expect(tab('图片 素材/子 文件夹/页面 二.html')).toBeVisible();
  await expect(tab('图片 素材/子 文件夹/script.js')).toBeVisible();
});

test('an existing name is refused and explained; nothing is overwritten (S52.1)', async () => {
  await writeFile(path.join(root, '图片 素材', 'index.html'), '<p>别的</p>\n');
  await treeRow(page, 'index.html').dragTo(treeRow(page, '图片 素材'));
  await expect(page.getByTestId('file-op-error')).toContainText('index.html');
  expect(await readFile(path.join(root, '图片 素材', 'index.html'), 'utf8')).toBe('<p>别的</p>\n');
  expect(await readdir(root)).toContain('index.html');
});

test('a move made outside NoobIDE is replayed for the open tab (S52.1)', async () => {
  await openFile(page, 'index.html');
  // Let the watcher report the files the previous test wrote first: both halves of the move must land in one
  // watcher batch (or within its rename wait) to be paired as a move (S07.3, decision 0007).
  await page.waitForTimeout(1500);
  await rename(path.join(root, 'index.html'), path.join(root, '外部 移动', 'index.html'));
  await expect(tab('外部 移动/index.html')).toBeVisible();
  await expect(tab('index.html')).toHaveCount(0);
});
