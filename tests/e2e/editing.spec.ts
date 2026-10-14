import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { collectConsoleErrors, makeProject, openFile, openProject } from './project';

/**
 * S09.3 editing basics in the real editor: indent, comment toggle, find / replace, undo / redo, 16px default font,
 * zoom and light / dark theme. Each edit is checked on disk after Ctrl/Cmd+S, not only on screen.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const BASICS = 'let apple = 1;\nlet banana = 2;\n';
const lines = () => page.locator('.monaco-editor .view-lines');
const status = () => page.getByTestId('save-status');
const onDisk = () => readFile(path.join(root, 'basics.js'), 'utf8');

/** Saves and waits until the file on disk is exactly `expected` (the status alone may still show the last save). */
async function saveAndExpect(expected: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+S');
  await expect.poll(onDisk).toBe(expected);
  await expect(status()).toHaveText('已保存');
}

async function cursorToStart() {
  await lines().click();
  await page.keyboard.press('ControlOrMeta+Home');
}

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-editing-'));
  await writeFile(path.join(root, 'basics.js'), BASICS);
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await openFile(page, 'basics.js');
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('the code font starts at 16px (PLAN §3)', async () => {
  await expect(page.getByTestId('zoom-reset')).toHaveText('16');
  expect(await lines().evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
});

test('Tab indents and Shift+Tab outdents the line', async () => {
  await cursorToStart();
  await page.keyboard.press('Tab');
  await expect(lines()).toContainText('let apple');
  await saveAndExpect('  let apple = 1;\nlet banana = 2;\n');
  await page.keyboard.press('Shift+Tab');
  await saveAndExpect(BASICS);
});

test('Ctrl/Cmd+/ toggles a line comment', async () => {
  await cursorToStart();
  await page.keyboard.press('ControlOrMeta+Slash');
  await expect(lines()).toContainText('// let apple');
  await saveAndExpect('// let apple = 1;\nlet banana = 2;\n');
  await page.keyboard.press('ControlOrMeta+Slash');
  await expect(lines()).not.toContainText('//');
  await saveAndExpect(BASICS);
});

test('find highlights matches and replace-all changes every one', async () => {
  await cursorToStart();
  await page.keyboard.press('ControlOrMeta+F');
  const widget = page.locator('.find-widget.visible');
  await expect(widget).toBeVisible();
  await widget.locator('.find-part textarea').fill('banana');
  await expect(widget.locator('.matchesCount')).toContainText('1');
  await page.keyboard.press('Escape');
  await lines().click();
  await page.keyboard.press('ControlOrMeta+H');
  await widget.locator('.find-part textarea').fill('let');
  await widget.locator('.replace-part textarea').fill('var');
  await widget.locator('.replace-part .codicon-find-replace-all').click();
  await page.keyboard.press('Escape');
  await expect(lines()).toContainText('var banana');
  await saveAndExpect('var apple = 1;\nvar banana = 2;\n');
});

test('undo and redo walk the edit history', async () => {
  await lines().click();
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(lines()).toContainText('let banana');
  await expect(lines()).not.toContainText('var');
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  await expect(lines()).toContainText('var banana');
  await page.keyboard.press('ControlOrMeta+Z');
  await saveAndExpect(BASICS);
});

test('zoom changes only the code font: buttons and Ctrl/Cmd with = - 0', async () => {
  const zoomFactor = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor());
  const fontSize = () => lines().evaluate((el) => getComputedStyle(el).fontSize);
  await page.getByTestId('zoom-in').click();
  await expect(page.getByTestId('zoom-reset')).toHaveText('17');
  await expect.poll(fontSize).toBe('17px');
  await lines().click();
  await page.keyboard.press('ControlOrMeta+Equal');
  await expect(page.getByTestId('zoom-reset')).toHaveText('18');
  await expect.poll(fontSize).toBe('18px');
  await page.keyboard.press('ControlOrMeta+Minus');
  await page.keyboard.press('ControlOrMeta+Minus');
  await page.keyboard.press('ControlOrMeta+Minus');
  await expect(page.getByTestId('zoom-reset')).toHaveText('15');
  await expect.poll(fontSize).toBe('15px');
  // The whole window never zooms (the menu's page zoom would shrink the UI, not the code).
  expect(await zoomFactor()).toBe(1);
  await page.keyboard.press('ControlOrMeta+0');
  await expect(page.getByTestId('zoom-reset')).toHaveText('16');
  await expect.poll(fontSize).toBe('16px');
  // Zooming is not an edit.
  await expect(status()).toHaveText('已保存');
  expect(await onDisk()).toBe(BASICS);
});

test('the editor follows the light and dark theme', async () => {
  const editor = page.locator('.monaco-editor').first();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(editor).toHaveClass(/(^|\s)vs(\s|$)/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(editor).toHaveClass(/(^|\s)vs-dark(\s|$)/);
});

test('no console errors during the editing run', async () => {
  expect(consoleErrors).toEqual([]);
});
