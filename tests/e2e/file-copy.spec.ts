import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { makeProject, openProject, treeRow } from './project';

/**
 * S52.2 end to end: Copy/Paste and Duplicate from the context menu, the tree keys (Ctrl/Cmd+C/V/D) and the command
 * palette, in a project whose path has Chinese characters and spaces. Copies are byte-identical; a taken name gets
 * a copy name and nothing is overwritten.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-copy-'));
  await mkdir(path.join(root, '目标 文件夹'));
  await writeFile(path.join(root, '图 一.png'), BYTES);
  app = await launchApp();
  page = await app.firstWindow();
  await openProject(app, page, root);
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

async function menu(relPath: string, command: string) {
  await treeRow(page, relPath).click({ button: 'right' });
  await page.locator(`[data-testid="tree-menu"] [data-command="${command}"]`).click();
}

test('paste with nothing copied explains how to copy (S52.2)', async () => {
  await treeRow(page, '目标 文件夹').click();
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.getByTestId('file-op-error')).toContainText('还没有复制任何文件');
});

test('Duplicate from the context menu makes "name copy.ext" with the same bytes (S52.2)', async () => {
  await menu('图 一.png', 'duplicate');
  await expect(treeRow(page, '图 一 copy.png')).toBeVisible();
  expect(await readFile(path.join(root, '图 一 copy.png'))).toEqual(BYTES);
  await expect(page.getByTestId('file-op-notice')).toHaveText('已创建“图 一 copy.png”。');
  await menu('图 一.png', 'duplicate');
  await expect(treeRow(page, '图 一 copy 2.png')).toBeVisible();
});

test('Copy and Paste from the context menu copy into a folder (S52.2)', async () => {
  await menu('style.css', 'copy');
  await menu('目标 文件夹', 'paste');
  const original = await readFile(path.join(root, 'style.css'));
  await expect
    .poll(() => readFile(path.join(root, '目标 文件夹', 'style.css')).catch(() => Buffer.alloc(0)))
    .toEqual(original);
});

test('the tree keys: Ctrl/Cmd+C on a folder, Ctrl/Cmd+V twice, Ctrl/Cmd+D (S52.2)', async () => {
  await treeRow(page, '子 文件夹').click();
  await page.keyboard.press('ControlOrMeta+c');
  await expect(page.getByTestId('file-op-notice')).toContainText('子 文件夹');
  await treeRow(page, '目标 文件夹').click();
  await page.keyboard.press('ControlOrMeta+v');
  await expect
    .poll(() => readdir(path.join(root, '目标 文件夹', '子 文件夹')).catch(() => []))
    .toEqual(['页面 二.html']);
  // Pasting again into the same folder never overwrites: the copy gets a copy name. (The selection moved to the
  // new copy, and a paste on a folder goes into it, so the target folder is chosen again.)
  await treeRow(page, '目标 文件夹').click();
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(() => readdir(path.join(root, '目标 文件夹')).catch(() => [])).toContain('子 文件夹 copy');
  await treeRow(page, 'index.html').click();
  await page.keyboard.press('ControlOrMeta+d');
  await expect.poll(() => readdir(root)).toContain('index copy.html');
});

test('the palette duplicates the selected file (S52.2)', async () => {
  await treeRow(page, 'script.js').click();
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await page.getByTestId('palette-input').fill('创建副本');
  await page.getByTestId('palette-files-duplicate').click();
  const original = await readFile(path.join(root, 'script.js'), 'utf8');
  await expect.poll(() => readFile(path.join(root, 'script copy.js'), 'utf8').catch(() => '')).toBe(original);
});

test('the palette copies the selected file and pastes it into the selected folder (S52.2)', async () => {
  const run = async (query: string, id: string) => {
    await page.keyboard.press('ControlOrMeta+Shift+P');
    await page.getByTestId('palette-input').fill(query);
    await page.getByTestId(`palette-${id}`).click();
  };
  await treeRow(page, '图 一.png').click();
  await run('复制选中', 'files-copy');
  await expect(page.getByTestId('file-op-notice')).toContainText('图 一.png');
  await treeRow(page, '目标 文件夹').click();
  await run('粘贴文件', 'files-paste');
  await expect
    .poll(() => readFile(path.join(root, '目标 文件夹', '图 一.png')).catch(() => Buffer.alloc(0)))
    .toEqual(BYTES);
});
