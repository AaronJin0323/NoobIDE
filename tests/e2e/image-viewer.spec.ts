import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { makeProject, openFile, openProject, switchLanguage, treeRow } from './project';

/**
 * S52.6 end to end: png, gif and svg open in an image tab with their pixel and byte size (served by the app
 * protocol's `project` host, never the preview server); an SVG's script never runs; a font keeps the refusal notice;
 * "Copy <img> tag" and "Copy relative path" are relative to the HTML file last shown, in zh-CN and en.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
/** A 1×1 ICO holding the PNG above (Windows Vista+ format, which Chromium decodes). */
const ICO = (() => {
  const header = Buffer.from([0, 0, 1, 0, 1, 0]);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(1, 0); // width
  entry.writeUInt8(1, 1); // height
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(PNG_1X1.length, 8);
  entry.writeUInt32LE(6 + 16, 12);
  return Buffer.concat([header, entry, PNG_1X1]);
})();
const WEBP_1X1 = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
/** A real 1×1 JPEG, encoded by Electron from the PNG once the app runs (see beforeAll). */
let JPG = Buffer.alloc(0);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" onload="top.document.title=\'svg-onload\'">' +
  '<script>top.document.title = "svg-script";</script><rect width="40" height="20" fill="#36c"/></svg>';

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-image-'));
  await mkdir(path.join(root, '图片 素材'));
  await writeFile(path.join(root, '图片 素材', '标志 图.png'), PNG_1X1);
  await writeFile(path.join(root, '动 图.gif'), GIF_1X1);
  await writeFile(path.join(root, '图片 素材', '图标.svg'), SVG);
  await writeFile(path.join(root, 'favicon.ico'), ICO);
  await writeFile(path.join(root, '照片 二.webp'), WEBP_1X1);
  await writeFile(path.join(root, '字体.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0]));
  app = await launchApp();
  JPG = Buffer.from(
    await app.evaluate(
      ({ nativeImage }, png) => [...nativeImage.createFromBuffer(Buffer.from(png)).toJPEG(90)],
      [...PNG_1X1],
    ),
  );
  await writeFile(path.join(root, '照片 一.jpg'), JPG);
  page = await app.firstWindow();
  await openProject(app, page, root);
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

const facts = () => page.getByTestId('image-facts');
const clipboardText = () => app.evaluate(({ clipboard }) => clipboard.readText());

test('a png opens in an image tab with its pixel size and byte size, from the app protocol (S52.6)', async () => {
  await openFile(page, '图片 素材/标志 图.png');
  await expect(page.getByTestId('image-view')).toBeVisible();
  await expect(facts()).toHaveText(`1 × 1 像素 · ${PNG_1X1.length} B`);
  const src = await page.getByTestId('image-preview').getAttribute('src');
  expect(src?.startsWith('noobide://project/')).toBe(true);
  expect(src).not.toMatch(/^https?:/);
  // No code editor for an image tab.
  await expect(page.locator('#editor-surface .monaco-editor')).toHaveCount(0);
});

test('a gif opens too; switching back to a text tab shows the editor again (S52.6)', async () => {
  await openFile(page, '动 图.gif');
  await expect(facts()).toContainText('1 × 1 像素');
  await openFile(page, 'index.html');
  await expect(page.locator('#editor-surface .monaco-editor')).toBeVisible();
  await expect(page.getByTestId('image-view')).toHaveCount(0);
});

test('an SVG is shown as an image: its script and onload never run (S52.6)', async () => {
  const title = await page.title();
  await openFile(page, '图片 素材/图标.svg');
  await expect(facts()).toContainText('40 × 20 像素');
  await page.waitForTimeout(300);
  expect(await page.title()).toBe(title);
});

test('jpg, webp and ico open in the image tab as well, with their byte size (S52.6)', async () => {
  for (const [name, bytes] of [
    ['照片 一.jpg', JPG.length],
    ['照片 二.webp', WEBP_1X1.length],
    ['favicon.ico', ICO.length],
  ] as const) {
    await openFile(page, name);
    await expect(page.getByTestId('image-view')).toBeVisible();
    await expect(facts()).toHaveText(`1 × 1 像素 · ${bytes} B`);
    // Not a text file in another encoding: no read-only or line-ending notice above the picture.
    await expect(page.getByTestId('read-only-notice')).toHaveCount(0);
  }
  await expect(facts()).toHaveText(`1 × 1 像素 · ${ICO.length} B`);
});

test('fonts and other binaries keep the refusal notice (S52.6)', async () => {
  await treeRow(page, '字体.woff2').click();
  await expect(page.getByTestId('open-error')).toContainText('字体.woff2');
  await expect(page.getByTestId('open-error')).toContainText('不是 UTF-8 文本');
  // No tab opens for it (the tab shown before stays, as for any file that cannot be opened).
  await expect(page.locator('[data-testid="tab"][data-path="字体.woff2"]')).toHaveCount(0);
});

test('"Copy <img> tag" and "Copy relative path" are relative to the HTML file last shown (S52.6)', async () => {
  await openFile(page, '子 文件夹/页面 二.html');
  await openFile(page, '图片 素材/标志 图.png');
  await expect(page.getByTestId('image-view')).toContainText('页面 二.html');
  await page.getByTestId('image-copy-tag').click();
  await expect.poll(clipboardText).toBe('<img src="../图片%20素材/标志%20图.png" alt="标志 图">');
  await expect(page.getByTestId('image-copy-status')).toContainText('已复制');
  await page.getByTestId('image-copy-path').click();
  await expect.poll(clipboardText).toBe('../图片%20素材/标志%20图.png');
});

test('the image tab follows the interface language (en) (S52.6)', async () => {
  await switchLanguage(page); // S47.4: through the help menu
  await expect(page.getByTestId('image-copy-tag')).toHaveText('Copy <img> tag');
  await expect(page.getByTestId('image-copy-path')).toHaveText('Copy relative path');
  await expect(facts()).toContainText('1 × 1 pixels');
  await switchLanguage(page); // S47.4: through the help menu
  await expect(page.getByTestId('image-copy-tag')).toHaveText('复制 <img> 标签');
});

test('an image changed or moved outside NoobIDE is shown as it is now (S52.6)', async () => {
  await openFile(page, '图片 素材/标志 图.png');
  await writeFile(path.join(root, '图片 素材', '标志 图.png'), Buffer.concat([PNG_1X1, Buffer.alloc(10)]));
  await expect(facts()).toContainText(`${PNG_1X1.length + 10} B`);
  await rename(path.join(root, '动 图.gif'), path.join(root, '图片 素材', '动 图.gif'));
  await expect(page.locator('[data-testid="tab"][data-path="图片 素材/动 图.gif"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="tab"][data-path="动 图.gif"]')).toHaveCount(0);
});
