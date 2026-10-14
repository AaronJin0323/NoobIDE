import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';

/**
 * S07.4 end to end: other encodings open read-only with a notice and are never written; the line-ending style of an
 * existing file survives an edit and a save; a binary file is not opened in the editor.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
const GBK = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a]); // 你好\n in GBK

async function openFile(name: string) {
  await page.getByTestId('region-files').getByText(name, { exact: true }).click();
}

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-e2e-enc-'));
  root = path.join(tmp, '编码 测试');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'gbk.txt'), GBK);
  await writeFile(path.join(root, 'crlf.html'), '<p>一</p>\r\n<p>二</p>\r\n');
  await writeFile(path.join(root, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  app = await launchApp();
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  await app.evaluate(({ dialog }, chosen) => {
    const fake = async () => ({ canceled: false, filePaths: [chosen] });
    (dialog as unknown as { showOpenDialog: typeof fake }).showOpenDialog = fake;
  }, root);
  await page.getByTestId('open-folder').click();
  await expect(page.getByTestId('project-name')).toHaveText('编码 测试');
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('a GBK file opens read-only with a notice naming the encoding, and is never written', async () => {
  await openFile('gbk.txt');
  await expect(page.locator('.view-lines')).toContainText('你好');
  await expect(page.getByTestId('read-only-notice')).toContainText('gb18030');
  await expect(page.getByTestId('read-only-notice')).toContainText('只能查看');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('改动');
  await page.keyboard.press('ControlOrMeta+S');
  await expect(page.locator('.view-lines')).not.toContainText('改动');
  await expect(page.getByTestId('save-status')).toHaveText('无改动');
  expect(await readFile(path.join(root, 'gbk.txt'))).toEqual(GBK);
});

test('an edited CRLF file keeps CRLF on every line after saving', async () => {
  await openFile('crlf.html');
  await expect(page.getByTestId('read-only-notice')).toHaveCount(0);
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('三');
  await page.keyboard.press('Enter');
  await page.keyboard.type('四');
  await page.keyboard.press('ControlOrMeta+S');
  await expect(page.getByTestId('save-status')).toHaveText('已保存');
  expect(await readFile(path.join(root, 'crlf.html'), 'utf8')).toBe('<p>一</p>\r\n<p>二</p>\r\n三\r\n四');
});

test('a binary file is not opened in the editor', async () => {
  await openFile('photo.jpg');
  await expect(page.getByTestId('open-error')).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveText('没有打开的文件');
});
