import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { axeScan } from './a11y-helpers';
import { launchApp, tempRoot } from './launch';
import { makeProject, openFile, openProject, tabOf, typeAtEnd } from './project';

/**
 * S49.5 end to end:
 * - the command palette lists the commands last run from it first, newest first, under "最近使用", when the query is
 *   empty; they are stored in the app settings (app data, per user) and are there again after a restart;
 * - when the tabs overflow, the tab bar offers "所有标签": every open file with its state word, the shown one
 *   checked, opened or closed from the list with the mouse or the keyboard.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let userData: string;

const palette = () => page.getByTestId('command-palette');
const options = () => palette().getByRole('option');

async function launch() {
  app = await launchApp({}, { userDataDir: userData });
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines, [data-testid="project-name"]').first().waitFor();
}

async function openPalette() {
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await expect(palette()).toBeVisible();
}

async function runFromPalette(id: string) {
  await openPalette();
  await palette().getByTestId(`palette-${id}`).click();
  await expect(palette()).toHaveCount(0);
}

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-recents-'));
  userData = await mkdtemp(path.join(tempRoot(), 'noobide-e2e-recents-data-'));
  await writeFile(path.join(root, 'a-long-script-name.js'), 'let a = 1;\n');
  await writeFile(path.join(root, 'another-long-page.html'), '<!doctype html>\n<p>x</p>\n');
  await launch();
  await openProject(app, page, root);
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});

test('the palette lists the commands last run from it first, newest first, and keeps them after a restart', async () => {
  await openPalette();
  await expect(palette().getByTestId('palette-recent')).toHaveCount(0); // nothing run yet
  await page.keyboard.press('Escape');

  await runFromPalette('toggle-problems');
  await runFromPalette('toggle-files');
  await runFromPalette('toggle-files'); // the files panel is back; it moves to the front once, not twice
  await runFromPalette('toggle-problems'); // and Problems is closed again

  await openPalette();
  const recent = palette().getByTestId('palette-recent');
  await expect(recent).toHaveAttribute('aria-label', '最近使用');
  await expect(recent.getByRole('option')).toHaveCount(2);
  expect(await options().evaluateAll((all) => all.slice(0, 2).map((o) => o.getAttribute('data-testid')))).toEqual([
    'palette-toggle-problems',
    'palette-toggle-files',
  ]);
  await expect(options().first()).toHaveAttribute('aria-selected', 'true'); // Enter runs the newest
  expect((await axeScan(page)).map((f) => `${f.id} ${f.targets.join(', ')}`)).toEqual([]);
  // A query ranks by match; the group is only for the empty query.
  await page.getByTestId('palette-input').fill('zoom');
  await expect(palette().getByTestId('palette-recent')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Stored in the app settings (app data), never in the project.
  const stored = await page.evaluate(async () => {
    const result = await window.noobide?.settings?.get();
    return result?.ok ? result.value.settings.paletteRecents : null;
  });
  expect(stored).toEqual(['toggle-problems', 'toggle-files']);

  await app.close();
  await launch();
  await openPalette();
  await expect(palette().getByTestId('palette-recent').getByRole('option')).toHaveCount(2);
  await expect(options().first()).toHaveAttribute('data-testid', 'palette-toggle-problems');
  await page.keyboard.press('Escape');
});

test('an overflowing tab bar offers All tabs: every file with its state word, opened and closed from the list', async () => {
  // The restart reopened the project (S13.4).
  await expect(page.getByTestId('file-tree')).toBeVisible({ timeout: 20_000 });
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.setContentSize(960, 720);
  });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(960);
  const files = [
    'index.html',
    'style.css',
    'script.js',
    'README.md',
    '子 文件夹/页面 二.html',
    'a-long-script-name.js',
    'another-long-page.html',
  ];
  for (const file of files) await openFile(page, file);
  // A failed save (read-only file) keeps its state, so the list can be checked for a state word other than Saved.
  const css = path.join(root, 'style.css');
  await chmod(css, 0o444);
  await tabOf(page, 'style.css').click();
  await typeAtEnd(page, '/* 改动 */');
  await expect(page.locator('[data-testid="tab"][data-path="style.css"] [data-testid="tab-state"]')).toHaveText(
    '保存失败',
  );
  await tabOf(page, 'README.md').click();

  const all = page.getByTestId('tabs-all');
  await expect(all).toBeVisible();
  await expect(all).toHaveAccessibleName('所有标签：列出打开的文件（7 个）');
  await all.click();
  const list = page.getByTestId('all-tabs-list');
  await expect(list).toBeVisible();
  const rows = list.locator('.all-tabs-row');
  await expect(rows).toHaveCount(7);
  expect(await rows.evaluateAll((els) => els.map((r) => r.getAttribute('data-path')))).toEqual(files);
  // Every row says its state in a word; the shown tab is checked and has the focus.
  await expect(rows.nth(1).getByTestId('all-tabs-state')).toHaveText('保存失败');
  await expect(rows.nth(0).getByTestId('all-tabs-state')).toHaveText('已保存');
  const shown = rows.nth(3).getByTestId('all-tabs-open');
  await expect(shown).toHaveAttribute('aria-current', 'true');
  await expect(shown).toBeFocused();
  await expect(rows.nth(4)).toContainText('子 文件夹');
  expect((await axeScan(page)).map((f) => `${f.id} ${f.targets.join(', ')}`)).toEqual([]);

  // Keyboard: the arrows move, Enter opens, Escape closes and returns to the button.
  await page.keyboard.press('ArrowDown'); // README's close button
  await page.keyboard.press('ArrowDown'); // 页面 二.html
  await expect(rows.nth(4).getByTestId('all-tabs-open')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(list).toHaveCount(0);
  await expect(tabOf(page, '子 文件夹/页面 二.html')).toHaveAttribute('aria-selected', 'true');
  await all.click();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(all).toBeFocused();

  // Close from the list: the × of a row, and Delete on a focused row; the focus stays in the list.
  await all.click();
  await list.locator('.all-tabs-row[data-path="script.js"]').getByTestId('all-tabs-close').click();
  await expect(page.locator('[data-testid="tab"][data-path="script.js"]')).toHaveCount(0);
  await expect(rows).toHaveCount(6);
  await list.locator('.all-tabs-row[data-path="index.html"]').getByTestId('all-tabs-open').focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-testid="tab"][data-path="index.html"]')).toHaveCount(0);
  await expect(rows).toHaveCount(5);
  await expect(rows.first().getByTestId('all-tabs-open')).toBeFocused();
  await page.keyboard.press('Escape');
  await chmod(css, 0o644);
});
