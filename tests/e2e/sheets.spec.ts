import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, repoRoot } from './launch';
import { makeProject, openFile, openProject, treeRow, typeAtEnd } from './project';
import { expectFocusTrapped, expectSheetAnatomy } from './sheet-helpers';

/**
 * S45.4: every sheet follows one anatomy (title, optional one-line description, content, trailing actions with
 * Cancel before the primary and destructive actions named and drawn as such), closes with Escape, traps focus,
 * returns focus to its opener, and fits a 1024×660 window without clipping its actions. The crash-recovery prompt
 * is checked the same way in recovery.spec.ts (it needs a crashed run).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-sheets-'));
  app = await launchApp();
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor({ state: 'attached' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1024, 660));
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1024, 660]);
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

/** A picture of the sheet at 1024×660 for review (layout only, never evidence of behaviour). */
const shots = path.join(repoRoot, 'test-results', 'sheets');
async function shot(name: string) {
  await mkdir(shots, { recursive: true });
  await page.waitForTimeout(400); // let the sheet settle
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

/** Escape closes the sheet and focus is back on the opener. */
async function escapeReturnsTo(sheet: string, opener: string) {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(sheet)).toHaveCount(0);
  await expect(page.getByTestId(opener)).toBeFocused();
}

test('create project: Cancel before Create, fits 1024×660, Escape returns to the welcome button', async () => {
  await page.getByTestId('welcome-create').focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByTestId('create-wizard');
  await expect(page.getByTestId('wizard-name')).toBeFocused();
  const labels = await expectSheetAnatomy(page, sheet);
  expect(labels).toEqual(['取消', '创建并打开']);
  await expect(sheet.locator('.sheet-description')).toBeVisible();
  await shot('create-project');
  await expectFocusTrapped(page, 'create-wizard');
  await escapeReturnsTo('create-wizard', 'welcome-create');
});

test('palette: a sheet with a hidden title; Escape returns to the command search', async () => {
  await openProject(app, page, root);
  await openFile(page, 'index.html');
  await page.getByTestId('open-palette').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await expectSheetAnatomy(page, page.getByTestId('command-palette'), { titleVisible: false, actions: false });
  await page.getByTestId('palette-input').fill('them');
  await shot('palette');
  await expectFocusTrapped(page, 'command-palette', 3);
  await escapeReturnsTo('command-palette', 'open-palette');
});

test('about: a lone Close is the default button', async () => {
  await page.getByTestId('open-palette').focus();
  await page.evaluate(() => window.dispatchEvent(new Event('noobide:open-about')));
  await expect(page.getByTestId('about-close')).toBeFocused();
  expect(await expectSheetAnatomy(page, page.getByTestId('about-dialog'))).toEqual(['关闭']);
  await shot('about');
  await expectFocusTrapped(page, 'about-dialog', 3);
  await escapeReturnsTo('about-dialog', 'open-palette');
});

test('glossary: the list scrolls inside, Close stays visible; focus returns to the menu button', async () => {
  await page.getByTestId('app-menu').click();
  await page.getByTestId('menu-help-glossary').click();
  const sheet = page.getByTestId('glossary');
  await expect(page.getByTestId('glossary-search')).toBeFocused();
  expect(await expectSheetAnatomy(page, sheet)).toEqual(['关闭']);
  // The content is longer than the window: the list scrolls, the actions are not pushed out.
  const list = page.getByTestId('glossary-list');
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await shot('glossary');
  await expectFocusTrapped(page, 'glossary', 4);
  await escapeReturnsTo('glossary', 'app-menu');
});

test('history: Close, then Restore once a version is chosen; storage behind a disclosure; Escape returns', async () => {
  await typeAtEnd(page, 'SHEETS');
  await page.keyboard.press('ControlOrMeta+S');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', /saved|clean/);
  await page.getByTestId('show-history').focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByTestId('history-dialog');
  expect(await expectSheetAnatomy(page, sheet)).toEqual(['关闭']);
  await page.getByTestId('history-version').last().click();
  await expect(page.getByTestId('history-diff')).toBeVisible();
  expect(await expectSheetAnatomy(page, sheet)).toEqual(['关闭', '恢复这个版本']);
  await shot('history');
  await expect(page.getByTestId('history-storage-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('history-storage-toggle').click();
  // Opening the disclosure lengthens the content; the sheet still fits and its actions stay in view.
  await expectSheetAnatomy(page, sheet);
  await page.getByTestId('history-clear-project').click();
  // The destructive action is named with its verb and drawn as destructive, after Cancel.
  const confirm = page.getByTestId('history-confirm');
  await expect(confirm.getByRole('button')).toHaveText(['取消', '清除历史']);
  await expect(page.getByTestId('history-confirm-clear')).toHaveClass(/destructive-button/);
  await shot('history-storage');
  await page.keyboard.press('Escape'); // cancels the question first
  await expect(confirm).toHaveCount(0);
  await expectFocusTrapped(page, 'history-dialog', 20);
  await escapeReturnsTo('history-dialog', 'show-history');
});

test('delete confirmation: Cancel first and focused, the destructive verb last; Escape returns to the row', async () => {
  await treeRow(page, 'style.css').click();
  await page.keyboard.press('Delete');
  const sheet = page.getByTestId('delete-dialog');
  await expect(sheet.getByRole('button', { name: '取消' })).toBeFocused();
  await expect(sheet).toHaveAttribute('role', 'alertdialog');
  const labels = await expectSheetAnatomy(page, sheet);
  expect(labels[0]).toBe('取消');
  await expect(page.getByTestId('confirm-button')).toHaveClass(/destructive-button/);
  await shot('delete');
  await expectFocusTrapped(page, 'delete-dialog', 3);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-path') ?? null))
    .toBe('style.css');
});

test('the sheets follow the interface language (en)', async () => {
  await page.getByTestId('app-menu').click();
  await page.getByTestId('menu-language-en').click();
  await page.getByTestId('show-history').focus();
  await page.keyboard.press('Enter');
  expect(await expectSheetAnatomy(page, page.getByTestId('history-dialog'))).toEqual(['Close']);
  await escapeReturnsTo('history-dialog', 'show-history');
  await page.getByTestId('app-menu').click();
  await page.getByTestId('menu-language-zh-CN').click();
});
