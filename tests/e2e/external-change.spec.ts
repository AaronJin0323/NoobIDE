import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { collectConsoleErrors, makeProject, openFile, openProject, tabOf, typeAtEnd } from './project';

/**
 * S11.1–S11.3 end to end, project path with Chinese characters and spaces: a file changed by another program is
 * reloaded when the buffer has no edits, becomes a conflict (Monaco diff, explicit choice, nothing automatic) when it
 * has, and a file deleted on disk keeps its text in a tab marked deleted with a way to save it again.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const status = () => page.getByTestId('save-status');
const lines = () => page.locator('.monaco-editor .view-lines').first();
const file = (relPath: string) => path.join(root, ...relPath.split('/'));
const disk = (relPath: string) => readFile(file(relPath), 'utf8');

/** Banners make the editor shorter; bring the last line into view before reading the visible lines. */
async function showEnd() {
  await lines().click();
  await page.keyboard.press('ControlOrMeta+End');
}

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-external-'));
  const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
  await writeFile(file('lines.txt'), `${body}\n`);
  await mkdir(file('恢复 文件夹'));
  await writeFile(file('恢复 文件夹/retry.txt'), 'RECREATE-CONTENT\n');
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
});

test.afterAll(async () => {
  // A conflict or deleted tab (if a test failed midway) refuses a normal close by design: end the app directly.
  await app?.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
  await app?.close().catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

test('our own saves are never mistaken for external edits (S11.1)', async () => {
  await openFile(page, 'index.html');
  await typeAtEnd(page, 'OWNSAVE');
  await expect.poll(() => disk('index.html')).toContain('OWNSAVE');
  await expect(status()).toHaveAttribute('data-state', 'saved');
  // Well past the watcher's debounce and the re-read: no reload notice, no conflict.
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('disk-reloaded')).toHaveCount(0);
  await expect(page.getByTestId('conflict-banner')).toHaveCount(0);
  await expect(status()).toHaveAttribute('data-state', 'saved');
});

test('a clean buffer reloads silently with a notice and keeps the cursor (S11.1)', async () => {
  await openFile(page, 'lines.txt');
  await lines().click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await expect(page.getByTestId('cursor-position')).toContainText('3');
  const cursorBefore = await page.getByTestId('cursor-position').textContent();
  const external = (await disk('lines.txt')).replace('line 10', 'line 10 CHANGED ELSEWHERE');
  await writeFile(file('lines.txt'), external);

  await expect(page.getByTestId('disk-reloaded')).toBeVisible();
  await expect(page.getByTestId('disk-reloaded')).toContainText('lines.txt');
  await expect(lines()).toContainText('CHANGED ELSEWHERE');
  await expect(page.getByTestId('cursor-position')).toHaveText(cursorBefore ?? '');
  await expect(tabOf(page, 'lines.txt')).not.toContainText('未保存');
  // Reloading never writes: the other program's bytes stay exactly as they were.
  await page.waitForTimeout(1500);
  expect(await disk('lines.txt')).toBe(external);

  await page.getByTestId('disk-reloaded-dismiss').click();
  await expect(page.getByTestId('disk-reloaded')).toHaveCount(0);
});

test('unsaved edits + an external change → conflict with a Monaco diff; "use disk" only on request (S11.2)', async () => {
  await tabOf(page, 'index.html').click();
  await typeAtEnd(page, 'MINE-ONE');
  // Within the autosave pause: whichever notices first (watcher or the check before write), nothing is overwritten.
  await writeFile(file('index.html'), '<p>THEIRS-ONE</p>\n');

  const banner = page.getByTestId('conflict-banner');
  await expect(banner).toBeVisible();
  await expect(status()).toHaveAttribute('data-state', 'conflict');
  await expect(tabOf(page, 'index.html')).toContainText('有冲突');
  await expect(banner).toContainText('index.html');
  // Never automatic: the external version stays on disk, the edits stay in the editor.
  await page.waitForTimeout(2000);
  expect(await disk('index.html')).toBe('<p>THEIRS-ONE</p>\n');
  await showEnd();
  await expect(lines()).toContainText('MINE-ONE');

  await banner.getByTestId('conflict-compare').click();
  const diff = page.getByTestId('conflict-diff');
  await expect(diff.locator('.monaco-diff-editor')).toBeVisible();
  await expect(diff.locator('.monaco-diff-editor')).toContainText('THEIRS-ONE');
  await expect(diff.locator('.monaco-diff-editor')).toContainText('MINE-ONE');
  await expect(page.getByTestId('conflict-summary')).toContainText('新增');

  await banner.getByTestId('conflict-take-disk').click();
  await expect(page.getByTestId('conflict-banner')).toHaveCount(0);
  await expect(page.getByTestId('conflict-diff')).toHaveCount(0);
  await expect(lines()).toContainText('THEIRS-ONE');
  await expect(lines()).not.toContainText('MINE-ONE');
  // Nothing unsaved is left (the file was saved earlier in this run, so the status reads "saved").
  await expect(status()).toHaveAttribute('data-state', /^(clean|saved)$/);
  await page.waitForTimeout(1500);
  expect(await disk('index.html')).toBe('<p>THEIRS-ONE</p>\n');
});

test('"keep mine" writes the editor version over the compared disk version (S11.2)', async () => {
  await typeAtEnd(page, 'MINE-TWO');
  await writeFile(file('index.html'), '<p>THEIRS-TWO</p>\n');
  const banner = page.getByTestId('conflict-banner');
  await expect(banner).toBeVisible();
  await expect(banner.getByTestId('conflict-keep-mine')).toBeEnabled();
  expect(await disk('index.html')).toBe('<p>THEIRS-TWO</p>\n');

  await banner.getByTestId('conflict-keep-mine').click();
  await expect(page.getByTestId('conflict-banner')).toHaveCount(0);
  await expect.poll(() => disk('index.html')).toContain('MINE-TWO');
  expect(await disk('index.html')).not.toContain('THEIRS-TWO');
  await expect(status()).toHaveAttribute('data-state', 'saved');
});

test('deleting a conflicted file closes its comparison and lets the user save the retained edits again', async () => {
  await typeAtEnd(page, 'CONFLICT-THEN-DELETED');
  await writeFile(file('index.html'), '<p>OBSOLETE-DISK-VERSION</p>\n');
  const conflict = page.getByTestId('conflict-banner');
  await expect(conflict).toBeVisible();
  await conflict.getByTestId('conflict-compare').click();
  await expect(page.getByTestId('conflict-diff')).toBeVisible();

  await rm(file('index.html'));
  const deleted = page.getByTestId('deleted-banner');
  await expect(deleted).toBeVisible();
  await expect(status()).toHaveAttribute('data-state', 'deleted');
  await expect(conflict).toHaveCount(0);
  await expect(page.getByTestId('conflict-diff')).toHaveCount(0);
  await showEnd();
  await expect(lines()).toContainText('CONFLICT-THEN-DELETED');
  await page.waitForTimeout(1500);
  await expect(readFile(file('index.html'))).rejects.toThrow();

  await deleted.getByTestId('deleted-resave').click();
  await expect.poll(() => disk('index.html').catch(() => '')).toContain('CONFLICT-THEN-DELETED');
  await expect(status()).toHaveAttribute('data-state', 'saved');
  await expect(deleted).toHaveCount(0);
});

test('a new disk version replaces the comparison while the retained edits still await a choice', async () => {
  await typeAtEnd(page, 'RETAIN-UNTIL-CHOICE');
  await writeFile(file('index.html'), '<p>FIRST-COMPARISON</p>\n');
  const banner = page.getByTestId('conflict-banner');
  await expect(banner).toBeVisible();
  await banner.getByTestId('conflict-compare').click();
  const diff = page.getByTestId('conflict-diff');
  await expect(diff).toContainText('FIRST-COMPARISON');
  await writeFile(file('index.html'), '<p>LATEST-COMPARISON</p>\n');
  await expect(diff).toContainText('LATEST-COMPARISON');
  await expect(diff).toContainText('RETAIN-UNTIL-CHOICE');
  expect(await disk('index.html')).toBe('<p>LATEST-COMPARISON</p>\n');
  await banner.getByTestId('conflict-take-disk').click();
  await expect(diff).toHaveCount(0);
  await expect(lines()).toContainText('LATEST-COMPARISON');
  await expect(lines()).not.toContainText('RETAIN-UNTIL-CHOICE');
  await expect(status()).toHaveAttribute('data-state', /^(clean|saved)$/);
});

test('a file deleted on disk keeps its text, is marked deleted and can be saved again (S11.3)', async () => {
  await openFile(page, 'style.css');
  await typeAtEnd(page, '/* KEPT */');
  await expect.poll(() => disk('style.css')).toContain('KEPT');
  await typeAtEnd(page, '/* UNSAVED */');
  await rm(file('style.css'));

  const banner = page.getByTestId('deleted-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('style.css');
  await expect(status()).toHaveAttribute('data-state', 'deleted');
  await expect(tabOf(page, 'style.css')).toContainText('已删除');
  await showEnd();
  await expect(lines()).toContainText('UNSAVED');
  // Autosave stops: nothing re-creates the file behind the user's back.
  await page.waitForTimeout(2000);
  await expect(readFile(file('style.css'))).rejects.toThrow();

  // Closing asks first; cancelling keeps everything.
  await page.locator('[data-testid="tab"][data-path="style.css"] [data-testid="tab-close"]').click();
  await expect(banner.getByTestId('deleted-close-confirm')).toBeVisible();
  await banner.getByRole('button', { name: '取消' }).click();
  await expect(tabOf(page, 'style.css')).toBeVisible();

  await banner.getByTestId('deleted-resave').click();
  await expect(page.getByTestId('deleted-banner')).toHaveCount(0);
  await expect.poll(() => disk('style.css').catch(() => '')).toContain('UNSAVED');
  expect(await disk('style.css')).toContain('KEPT');
  await expect(status()).toHaveAttribute('data-state', 'saved');
});

test('failed re-creation explains the missing folder and succeeds after the folder is restored', async () => {
  await openFile(page, '恢复 文件夹/retry.txt');
  await rm(file('恢复 文件夹'), { recursive: true });
  const banner = page.getByTestId('deleted-banner');
  await expect(banner).toBeVisible();
  await banner.getByTestId('deleted-resave').click();
  await expect(banner.getByTestId('deleted-error')).toBeVisible();
  await expect(status()).toHaveAttribute('data-state', 'deleted');
  await expect(lines()).toContainText('RECREATE-CONTENT');
  await mkdir(file('恢复 文件夹'));
  await banner.getByTestId('deleted-resave').click();
  await expect.poll(() => disk('恢复 文件夹/retry.txt').catch(() => '')).toContain('RECREATE-CONTENT');
  await expect(status()).toHaveAttribute('data-state', 'saved');
});

test('a deleted file reappearing with different text requires a choice and keeps unsaved edits', async () => {
  await tabOf(page, 'index.html').click();
  await typeAtEnd(page, 'REAPPEARED-KEEP-MINE');
  await rm(file('index.html'));
  await expect(page.getByTestId('deleted-banner')).toBeVisible();
  await writeFile(file('index.html'), '<p>RESTORED-BY-ANOTHER-EDITOR</p>\n');
  const banner = page.getByTestId('conflict-banner');
  await expect(banner).toBeVisible();
  await expect(page.getByTestId('deleted-banner')).toHaveCount(0);
  await showEnd();
  await expect(lines()).toContainText('REAPPEARED-KEEP-MINE');
  await page.waitForTimeout(1500);
  expect(await disk('index.html')).toBe('<p>RESTORED-BY-ANOTHER-EDITOR</p>\n');
  await banner.getByTestId('conflict-keep-mine').click();
  await expect.poll(() => disk('index.html')).toContain('REAPPEARED-KEEP-MINE');
  await expect(status()).toHaveAttribute('data-state', 'saved');
});

test('a deleted clean file can be closed after confirming (S11.3)', async () => {
  await openFile(page, '子 文件夹/页面 二.html');
  await rm(file('子 文件夹/页面 二.html'));
  const banner = page.getByTestId('deleted-banner');
  await expect(banner).toBeVisible();
  await banner.getByTestId('deleted-close').click();
  await banner.getByTestId('deleted-close-confirm').click();
  await expect(page.locator('[data-testid="tab"][data-path="子 文件夹/页面 二.html"]')).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});
