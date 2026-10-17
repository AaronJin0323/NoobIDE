import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { collectConsoleErrors, documentText, focusEditor, makeProject, openFile, openProject } from './project';
import { DOC_END } from './keys';

/**
 * S53 HTML/CSS authoring aids in the real workbench: Emmet on Tab with its one-time hint and off switch (S53.1).
 * The capability cases (tests/fixtures/lang-capabilities) prove each expansion; this proves the wiring around them.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const PAGE = '<!DOCTYPE html>\n<html>\n<body>\n</body>\n</html>\n';
const editor = () => page.locator('.monaco-editor').first();

/** Runs a native menu item (main's application menu) by its command id. */
const clickMenuItem = (id: string) =>
  app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`no menu item ${itemId}`);
    (item.click as () => void)();
  }, id);
const onDisk = (name: string) => readFile(path.join(root, name), 'utf8');

/** Runs a command from the command palette by its id. */
async function runCommand(id: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await page.getByTestId(`palette-${id}`).click();
  await expect(page.getByTestId('command-palette')).toBeHidden();
}

/** Puts the cursor on a new line inside <body> and types `text` there (the suggestion list, if any, is closed). */
async function typeInBody(text: string): Promise<void> {
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
}

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-authoring-'));
  await writeFile(path.join(root, 'index.html'), PAGE);
  await writeFile(path.join(root, 'wrap.html'), '<p>Say hello now</p>\n');
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await openFile(page, 'index.html');
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('Tab expands an Emmet abbreviation; the first time a hint names the setting (S53.1)', async () => {
  await expect(page.getByTestId('emmet-hint')).toHaveCount(0);
  await typeInBody('ul>li*2');
  await page.keyboard.press('Tab');
  await expect.poll(() => documentText(editor())).toContain('<li></li>');
  const hint = page.getByTestId('emmet-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toHaveAttribute('role', 'status');
  await expect(hint).toContainText('Tab 展开 Emmet 缩写'); // the Edit menu item that turns it off
  // The expansion is one undo step; the abbreviation comes back.
  await page.keyboard.press('Escape'); // leave the snippet's tab stops
  await page.keyboard.press('ControlOrMeta+Z');
  await expect.poll(() => documentText(editor())).toContain('ul>li*2');
  await expect.poll(() => documentText(editor())).not.toContain('<li>');
  // Dismissed, it does not come back: the next expansion shows no hint, also after the settings were stored.
  await hint.getByRole('button').click();
  await expect(hint).toHaveCount(0);
  await page.keyboard.press(DOC_END);
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('p.note');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect.poll(() => documentText(editor())).toContain('<p class="note"></p>');
  await expect(page.getByTestId('emmet-hint')).toHaveCount(0);
  const stored = await page.evaluate(() => window.noobide?.settings?.get());
  expect(stored?.ok && stored.value.settings.emmetHintShown).toBe(true);
});

test('the Edit menu switch turns Emmet off: Tab then indents as usual (S53.1)', async () => {
  // Start from the file on disk again.
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(' ');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await runCommand('toggle-emmet');
  const stored = await page.evaluate(() => window.noobide?.settings?.get());
  expect(stored?.ok && stored.value.settings.emmet).toBe(false);
  const checked = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('toggle-emmet')?.checked);
  expect(checked).toBe(false);
  await focusEditor(page);
  await page.keyboard.type('ul>li');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await page.keyboard.press('ControlOrMeta+S');
  // One space to the next tab stop; nothing expanded.
  await expect.poll(() => onDisk('index.html')).toBe('ul>li ');
  // And on again.
  await runCommand('toggle-emmet');
  const again = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('toggle-emmet')?.checked);
  expect(again).toBe(true);
  expect(consoleErrors).toEqual([]);
});

test('Edit › Wrap with tag wraps the selection with both tag names linked; one undo restores it (S53.2)', async () => {
  await openFile(page, 'wrap.html');
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < 'Say '.length + 3; i += 1) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 'hello'.length; i += 1) await page.keyboard.press('Shift+ArrowRight');
  await clickMenuItem('wrap-with-tag');
  await expect.poll(() => documentText(editor())).toContain('<p>Say <div>hello</div> now</p>');
  // Two cursors: one on each tag name.
  await expect(editor().locator('.cursors-layer .cursor')).toHaveCount(2);
  await page.keyboard.press('ControlOrMeta+Z');
  await expect.poll(() => documentText(editor())).toContain('<p>Say hello now</p>');
  await expect.poll(() => documentText(editor())).not.toContain('div');
  // Wrapped again, typing renames both tags at once.
  await clickMenuItem('wrap-with-tag');
  await page.keyboard.type('em');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+S');
  await expect.poll(() => onDisk('wrap.html')).toBe('<p>Say <em>hello</em> now</p>\n');
});

test('renaming an opening tag renames its closing tag (S53.2)', async () => {
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowRight'); // after "<"
  await page.keyboard.press('ArrowRight'); // after "<p"
  await page.waitForTimeout(500); // linked editing ranges are computed after the cursor rests
  await page.keyboard.type('re');
  await page.keyboard.press('ControlOrMeta+S');
  await expect.poll(() => onDisk('wrap.html')).toBe('<pre>Say <em>hello</em> now</pre>\n');
  expect(consoleErrors).toEqual([]);
});
