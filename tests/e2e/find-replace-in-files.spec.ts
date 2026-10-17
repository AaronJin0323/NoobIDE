import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { axeScan } from './a11y-helpers';
import { collectConsoleErrors, makeProject, openProject } from './project';
import { evalInPreview, previewInfo, waitForPreviewState } from './preview-helpers';

/**
 * S51.4 replace in files, end to end: a per-file preview of every change with files and single matches excludable;
 * replacing a class name across three files goes through each file's editor and save pipeline, refreshes the preview
 * once, leaves one local-history version per changed file, and each file can be undone in its editor.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const FILES: Record<string, string> = {
  'index.html':
    '<!doctype html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="utf-8" />\n    <title>卡片</title>\n' +
    '    <link rel="stylesheet" href="style.css" />\n  </head>\n  <body>\n    <div class="card">卡片</div>\n' +
    '    <script src="script.js"></script>\n  </body>\n</html>\n',
  'style.css': '.card {\n  color: #2f5d43;\n}\n',
  'script.js': "document.querySelector('.card').title = 'card';\n",
  '子 文件夹/页面 二.html': '<p class="card">第二页</p>\n',
};
const CHANGED = ['index.html', 'script.js', 'style.css'];

const disk = (relPath: string) => readFile(path.join(root, ...relPath.split('/')), 'utf8');
const panel = () => page.getByTestId('search-panel');
const fileSection = (relPath: string) => panel().locator(`.search-file[data-path="${relPath}"]`);
const tab = (relPath: string) => page.locator(`[data-testid="tab"][data-path="${relPath}"] [role="tab"]`);
const code = async () =>
  ((await page.locator('.monaco-editor .view-lines').first().textContent()) ?? '').replaceAll(' ', ' ');

/** A file's versions in local history, counted in the History window: all of them and those with `reason`. */
async function historyVersions(relPath: string, reason: string): Promise<{ all: number; reason: number }> {
  await page.getByTestId('show-history').click();
  const dialog = page.getByTestId('history-dialog');
  await dialog.getByTestId('history-file').filter({ hasText: relPath }).click();
  await page.getByTestId('history-version').first().waitFor();
  const count = {
    all: await page.getByTestId('history-version').count(),
    reason: await page.locator(`[data-testid="history-version"][data-reason="${reason}"]`).count(),
  };
  await page.getByTestId('history-close').click();
  await expect(dialog).toHaveCount(0);
  return count;
}

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-replace-'));
  for (const [relPath, text] of Object.entries(FILES)) {
    const full = path.join(root, ...relPath.split('/'));
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, text);
  }
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
  await expect.poll(() => evalInPreview<boolean>(app, `document.querySelector('.card') !== null`)).toBe(true);
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('Ctrl/Cmd+Shift+H shows a preview of every change, and files or single matches can be excluded', async () => {
  await page.keyboard.press('ControlOrMeta+Shift+H');
  await expect(panel()).toBeVisible();
  await expect(page.getByTestId('replace-expander')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('search-input')).toBeFocused();
  await page.keyboard.type('card');
  await expect(page.getByTestId('search-status')).toHaveText('5 个结果，在 4 个文件里');
  await page.getByTestId('replace-input').fill('panel');
  // Every match shows its old and new text (struck through / underlined, and named for screen readers).
  await expect(panel().getByTestId('replace-old')).toHaveCount(5);
  await expect(panel().getByTestId('replace-new').first()).toHaveText('替换为：panel');
  await expect(panel().getByTestId('replace-old').first()).toHaveText('原来：card');
  await expect(page.getByTestId('replace-apply')).toHaveText('替换 5 处');

  // Exclude a whole file, and the string 'card' (not the class) in script.js.
  await fileSection('子 文件夹/页面 二.html').getByTestId('replace-include-file').uncheck();
  const scriptHits = fileSection('script.js').getByTestId('replace-include-hit');
  await expect(scriptHits).toHaveCount(2);
  await scriptHits.nth(1).uncheck();
  await expect(page.getByTestId('replace-apply')).toHaveText('替换 3 处');
  await expect(fileSection('子 文件夹/页面 二.html').getByTestId('replace-new')).toHaveCount(0);
  await expect(fileSection('script.js').getByTestId('replace-new')).toHaveCount(1);
  expect(await axeScan(page)).toEqual([]);
});

test('apply goes through each file’s save pipeline, refreshes the preview once, one history version per file', async () => {
  // Count the preview's page loads from here on (main process side).
  const { previewWebContentsId } = await previewInfo(app);
  await app.evaluate(({ webContents }, id) => {
    const g = globalThis as unknown as { __s51Loads: number };
    g.__s51Loads = 0;
    webContents.fromId(id as number)?.on('did-finish-load', () => (g.__s51Loads += 1));
  }, previewWebContentsId);

  await page.getByTestId('replace-apply').click();
  await expect(page.getByTestId('replace-applied')).toHaveText(
    '已在 3 个文件里替换。每个文件都能在它的编辑器里撤销（Ctrl/Cmd+Z）。',
  );
  await expect(page.getByTestId('replace-failed')).toHaveCount(0);
  expect(await disk('index.html')).toBe(FILES['index.html']?.replace('class="card"', 'class="panel"'));
  expect(await disk('style.css')).toBe('.panel {\n  color: #2f5d43;\n}\n');
  expect(await disk('script.js')).toBe("document.querySelector('.panel').title = 'card';\n");
  expect(await disk('子 文件夹/页面 二.html')).toBe(FILES['子 文件夹/页面 二.html']);
  // Each file was opened in a tab and saved there.
  for (const relPath of CHANGED) await expect(tab(relPath)).toBeVisible();

  // The preview reloaded exactly once, after the last file.
  await expect.poll(() => evalInPreview<boolean>(app, `document.querySelector('.panel') !== null`)).toBe(true);
  await page.waitForTimeout(1500);
  expect(await app.evaluate(() => (globalThis as unknown as { __s51Loads: number }).__s51Loads)).toBe(1);

  // The search ran again: only what was left out is still found.
  await expect(page.getByTestId('search-status')).toHaveText('2 个结果，在 2 个文件里');

  for (const relPath of CHANGED) {
    await tab(relPath).click();
    // One save: the original kept "before save" and exactly one version of the replaced text.
    expect(await historyVersions(relPath, 'after-save')).toEqual({ all: 2, reason: 1 });
  }
});

test('each file can be undone in its editor', async () => {
  for (const relPath of CHANGED) {
    await tab(relPath).click();
    await page.locator('.monaco-editor .view-lines').first().click();
    await expect.poll(code).toContain('panel');
    await page.keyboard.press('ControlOrMeta+Z');
    await expect.poll(code).not.toContain('panel');
    await page.keyboard.press('ControlOrMeta+S');
    await expect.poll(() => disk(relPath)).toBe(FILES[relPath]);
  }
});

test('a file changed on disk after the search is refused with an explanation, never overwritten', async () => {
  await page.keyboard.press('ControlOrMeta+Shift+H');
  await page.getByTestId('search-input').fill('#2f5d43');
  await expect(page.getByTestId('search-status')).toHaveText('1 个结果，在 1 个文件里');
  await page.getByTestId('replace-input').fill('#336699');
  const external = '.card {\n  color: #2f5d43;\n  margin: 0;\n}\n';
  await writeFile(path.join(root, 'style.css'), external);
  // The open, unedited tab follows the disk (S11); the search's list is now older than the file.
  await tab('style.css').click();
  await expect.poll(code).toContain('margin: 0;');
  await page.getByTestId('replace-apply').click();
  const failed = page.getByTestId('replace-failed');
  await expect(failed).toHaveCount(1);
  await expect(failed).toHaveAttribute('data-path', 'style.css');
  await expect(failed).toHaveAttribute('data-reason', 'changed-since-search');
  await expect(failed).toContainText('查找之后这个文件改过了');
  await expect(page.getByTestId('replace-summary')).toBeFocused();
  expect(await disk('style.css')).toBe(external);
});

test('no console errors', () => {
  expect(consoleErrors).toEqual([]);
});
