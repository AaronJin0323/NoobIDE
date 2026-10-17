import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { focusEditor, makeProject, openFile, openProject, treeRow } from './project';
import { evalInPreview, replaceEditorText, waitForPreviewState } from './preview-helpers';
import { DOC_END } from './keys';

/**
 * S52.4 end to end: "Add image…" copies a chosen image into the project (the native dialog is replaced in main by
 * one that returns test files outside the project, Chinese paths with spaces on both sides); a taken name is renamed
 * by the user, never overwritten; a program is refused with an explanation. Then the image is inserted into an
 * <img src> with path completion and shows in the preview.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let downloads: string;
const PNG_2X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mNk+M9QzwAEjDAGACCDAv8cI7IoAAAAAElFTkSuQmCC',
  'base64',
);

async function answerOpenDialog(files: string[] | null) {
  await app.evaluate(({ dialog }, chosen) => {
    const fake = async () => ({ canceled: chosen === null, filePaths: chosen ?? [] });
    (dialog as unknown as { showOpenDialog: typeof fake }).showOpenDialog = fake;
  }, files);
}

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-import-'));
  downloads = path.join(tmp, '下载 文件夹', '我的 图片');
  await mkdir(downloads, { recursive: true });
  await writeFile(path.join(downloads, '猫 咪.png'), PNG_2X1);
  await writeFile(path.join(downloads, 'setup.exe'), 'MZ');
  await writeFile(path.join(root, 'index.html'), '<!doctype html>\n<title>t</title>\n<p>首页</p>\n');
  app = await launchApp();
  page = await app.firstWindow();
  await openProject(app, page, root);
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

async function addImageVia(relPath: string) {
  await treeRow(page, relPath).click({ button: 'right' });
  await page.locator('[data-testid="tree-menu"] [data-command="add-image"]').click();
}

test('"Add image…" copies the chosen image into the folder; the original stays (S52.4)', async () => {
  await answerOpenDialog([path.join(downloads, '猫 咪.png')]);
  await addImageVia('index.html'); // a file row: into its folder, the project root
  await expect(treeRow(page, '猫 咪.png')).toBeVisible();
  expect(await readFile(path.join(root, '猫 咪.png'))).toEqual(PNG_2X1);
  expect(await readdir(downloads)).toContain('猫 咪.png');
  await expect(page.getByTestId('file-op-notice')).toContainText('已把 1 项复制到');
});

test('a taken name is renamed by the user, never overwritten; a program is refused and explained (S52.4)', async () => {
  await writeFile(path.join(root, '猫 咪.png'), 'mine');
  await answerOpenDialog([path.join(downloads, '猫 咪.png'), path.join(downloads, 'setup.exe')]);
  await treeRow(page, 'index.html').click({ button: 'right' });
  await page.locator('[data-testid="tree-menu"] [data-command="add-files"]').click();
  const dialog = page.getByTestId('import-name-dialog');
  await expect(dialog).toContainText('猫 咪.png');
  await expect(page.getByTestId('import-name-input')).toHaveValue('猫 咪 copy.png');
  await page.getByTestId('import-name-input').fill('猫 咪 二.png');
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('file-op-failures')).toContainText('setup.exe');
  await expect(page.getByTestId('file-op-failures')).toContainText('.exe');
  expect(await readFile(path.join(root, '猫 咪.png'), 'utf8')).toBe('mine');
  expect(await readFile(path.join(root, '猫 咪 二.png'))).toEqual(PNG_2X1);
  expect(await readdir(root)).not.toContain('setup.exe');
});

test('skipping leaves everything as it was (S52.4)', async () => {
  await answerOpenDialog([path.join(downloads, '猫 咪.png')]);
  await addImageVia('index.html');
  await expect(page.getByTestId('import-name-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('import-name-dialog')).toHaveCount(0);
  expect((await readdir(root)).filter((n) => n.startsWith('猫'))).toEqual(['猫 咪 二.png', '猫 咪.png'].sort());
});

test('the added image is offered by path completion in <img src> and shows in the preview (S52.4)', async () => {
  await openFile(page, 'index.html');
  await replaceEditorText(app, page, '<!doctype html>\n<title>t</title>\n<img src="猫 咪 ');
  await focusEditor(page);
  await page.keyboard.press(DOC_END);
  await expect
    .poll(
      async () => {
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+Space');
        const rows = page.locator('.suggest-widget .monaco-list-row .label-name');
        await rows
          .first()
          .waitFor({ timeout: 2_000 })
          .catch(() => undefined);
        return (await rows.allTextContents()).includes('猫 咪 二.png');
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  await page.locator('.suggest-widget .monaco-list-row', { hasText: '猫 咪 二.png' }).first().click();
  await page.keyboard.type('" alt="猫">');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(path.join(root, 'index.html'), 'utf8')).toContain('猫 咪 二.png');
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
  await expect
    .poll(() => evalInPreview<number>(app, "(document.querySelector('img') || {}).naturalWidth || 0").catch(() => 0))
    .toBe(2);
});
