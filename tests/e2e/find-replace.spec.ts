import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { collectConsoleErrors, focusEditor, makeProject, openFile, openProject } from './project';
import { DOC_START, FIND_REPLACE } from './keys';

/**
 * S51.1 find and replace in the current file, end to end: the registry's commands (Edit menu, palette, shortcuts)
 * open Monaco's find widget; replace-all is one undo step, reaches the save pipeline once (one local-history version)
 * and the whole flow works from the keyboard, with the match count readable by assistive technology.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];
const mac = process.platform === 'darwin';

const ORIGINAL = '.card {\n  color: red;\n}\n.card-title {\n  color: red;\n}\n.card-body {\n  color: blue;\n}\n';

const widget = () => page.locator('.find-widget.visible');
/** The code on screen (the file is short: every line is rendered), without the find widget's fields. */
const code = async () =>
  ((await page.locator('.monaco-editor .view-lines').first().textContent()) ?? '').replaceAll(' ', ' ');
const onDisk = () => readFile(path.join(root, 'style.css'), 'utf8');

/** Versions of style.css in local history with the given reason, counted in the History window. */
async function historyVersions(reason: string): Promise<number> {
  await page.getByTestId('show-history').click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('history-close') });
  await dialog.getByTestId('history-file').filter({ hasText: 'style.css' }).click();
  await page.getByTestId('history-version').first().waitFor();
  const count = await page.locator(`[data-testid="history-version"][data-reason="${reason}"]`).count();
  await page.getByTestId('history-close').click();
  await expect(dialog).toHaveCount(0);
  return count;
}

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-find-'));
  await writeFile(path.join(root, 'style.css'), ORIGINAL);
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await openFile(page, 'style.css');
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('find and replace are in the palette with their platform shortcut', async () => {
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await page.getByTestId('palette-input').fill('查找');
  await expect(page.getByTestId('palette-find')).toContainText(mac ? '⌘F' : 'Ctrl+F');
  await page.getByTestId('palette-input').fill('replace');
  await expect(page.getByTestId('palette-replace')).toContainText(mac ? '⌥⌘F' : 'Ctrl+H');
  await page.keyboard.press('Enter');
  await expect(widget()).toBeVisible();
  await expect(widget().locator('.replace-part')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(widget()).toHaveCount(0);
});

test('replace all is one undo step and is saved once through the save pipeline', async () => {
  await expect.poll(onDisk).toBe(ORIGINAL);
  await focusEditor(page);
  await page.keyboard.press(FIND_REPLACE);
  await expect(widget().locator('.replace-part')).toBeVisible();
  await widget().locator('.find-part textarea').fill('card');
  await widget().locator('.replace-part textarea').fill('panel');
  await expect(widget().locator('.matchesCount')).toHaveText(/of 3/);
  // Replace all from the keyboard: Ctrl+Alt+Enter on Windows, ⌘↩ on macOS (Monaco's bindings).
  await widget().locator('.replace-part textarea').focus();
  await page.keyboard.press(mac ? 'Meta+Enter' : 'Control+Alt+Enter');
  const replaced = ORIGINAL.replaceAll('card', 'panel');
  // The edit reaches the save pipeline like typing: autosave writes it once.
  await expect.poll(onDisk, { timeout: 10_000 }).toBe(replaced);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', /saved|clean/);
  await page.keyboard.press('Escape');
  await expect(widget()).toHaveCount(0);
  // Exactly one local-history version of the replaced content (the save burst of one edit).
  expect(await historyVersions('after-save')).toBe(1);

  // One Ctrl/Cmd+Z restores the exact pre-replace text.
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('ControlOrMeta+Z');
  await expect.poll(async () => (await code()).includes('panel')).toBe(false);
  await page.keyboard.press('ControlOrMeta+S');
  await expect.poll(onDisk).toBe(ORIGINAL);
});

test('keyboard only: find, next / previous match, count announced, replace one, replace all', async () => {
  await focusEditor(page);
  await page.keyboard.press(DOC_START);
  await page.keyboard.press('ControlOrMeta+F');
  await expect(widget()).toBeVisible();
  await page.keyboard.type('red');
  // The count is text (not colour), and Monaco announces it through its live region for screen readers.
  await expect(widget().locator('.matchesCount')).toHaveText(/1 of 2/);
  await expect(page.locator('.monaco-alert, [role="alert"]').filter({ hasText: /of 2/ }).first()).toBeAttached();
  await page.keyboard.press('Enter'); // next match
  await expect(widget().locator('.matchesCount')).toHaveText(/2 of 2/);
  await page.keyboard.press('Shift+Enter'); // previous match
  await expect(widget().locator('.matchesCount')).toHaveText(/1 of 2/);

  // Ctrl+H / ⌥⌘F with a query already typed: the keyboard lands in the replace field.
  await page.keyboard.press(FIND_REPLACE);
  await expect(widget().locator('.replace-part textarea')).toBeFocused();
  await page.keyboard.type('green');
  const reds = async () => (await code()).match(/red/g)?.length ?? 0;
  // Replace one: Ctrl/Cmd+Shift+1, replace all: Ctrl+Alt+Enter / ⌘↩ (Monaco's bindings inside the widget).
  await page.keyboard.press('ControlOrMeta+Shift+Digit1');
  await expect.poll(reds).toBe(1);
  await page.keyboard.press(mac ? 'Meta+Enter' : 'Control+Alt+Enter');
  await expect.poll(reds).toBe(0);
  await expect(widget().locator('.matchesCount')).toHaveText(/No results/);
  // Back to the original from the keyboard: Escape closes the widget, Ctrl/Cmd+Z twice undoes both replaces.
  await page.keyboard.press('Escape');
  await expect(widget()).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Z');
  await expect.poll(reds).toBe(1);
  await page.keyboard.press('ControlOrMeta+Z');
  await expect.poll(reds).toBe(2);
  await page.keyboard.press('ControlOrMeta+S');
  await expect.poll(onDisk).toBe(ORIGINAL);
});

test('find and replace are in the native Edit menu', async () => {
  const labels = await app.evaluate(({ Menu }) => {
    const edit = Menu.getApplicationMenu()?.items.find((item) => item.label === '编辑');
    return edit?.submenu?.items.map((item) => `${item.label}|${item.enabled}`) ?? [];
  });
  expect(labels).toContain('查找|true');
  expect(labels).toContain('替换|true');
});

test('no console errors', () => {
  expect(consoleErrors).toEqual([]);
});
