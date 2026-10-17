import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { collectConsoleErrors, focusEditor, makeProject, openFile, openProject, tabOf } from './project';

/**
 * S57 JavaScript navigation in the workbench, on a project whose path has Chinese characters and spaces: F12 into a
 * closed script, Shift+F12 across two files, and the explained limit for an HTML page's inline <script>.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const CONFIG = "function greet(name) {\n  return '你好，' + name;\n}\n";
const APP = "greet('小雨');\ngreet('Lin');\n";
const PAGE =
  '<!DOCTYPE html>\n<html>\n<body>\n<script>\n  function hello() {}\n  hello();\n</script>\n</body>\n</html>\n';

const cursor = () => page.getByTestId('cursor-position');
const onDisk = (name: string) => readFile(path.join(root, name), 'utf8');

/** Puts the cursor on `line` (1-based), `column` characters in. */
async function cursorTo(line: number, column: number): Promise<void> {
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 1; i < line; i += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  for (let i = 1; i < column; i += 1) await page.keyboard.press('ArrowRight');
}

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-js-nav-'));
  await writeFile(path.join(root, 'config.js'), CONFIG);
  await writeFile(path.join(root, 'app.js'), APP);
  await writeFile(path.join(root, 'inline.html'), PAGE);
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await openFile(page, 'app.js');
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('F12 opens the closed script where the function is declared (S57.1)', async () => {
  await cursorTo(1, 3); // in "greet"
  await expect(tabOf(page, 'config.js')).toHaveCount(0); // not open: the service knows it as a closed file
  await expect
    .poll(async () => {
      await page.keyboard.press('F12');
      return (await tabOf(page, 'config.js').count()) > 0;
    })
    .toBe(true);
  await expect(tabOf(page, 'config.js')).toHaveAttribute('aria-selected', 'true');
  await expect(cursor()).toHaveText('行 1, 列 10');
});

test('Shift+F12 lists every use in both files; Enter opens one (S57.1)', async () => {
  await openFile(page, 'app.js');
  await cursorTo(2, 2);
  await page.keyboard.press('Shift+F12');
  const dialog = page.getByTestId('navigation-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('navigation-item')).toHaveCount(3);
  expect(
    await dialog.getByTestId('navigation-item').evaluateAll((items) => items.map((i) => i.dataset.location)),
  ).toEqual(['app.js:1:1', 'app.js:2:1', 'config.js:1:10']);
  await expect(dialog.getByTestId('navigation-item').first()).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(tabOf(page, 'config.js')).toHaveAttribute('aria-selected', 'true');
  await expect(cursor()).toHaveText('行 1, 列 10');
});

test('the commands are in the Edit menu and the palette', async () => {
  const ids = await app.evaluate(({ Menu }) =>
    ['go-to-definition', 'find-references'].map((id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.label ?? null),
  );
  expect(ids).toEqual(['转到定义', '查找所有引用']);
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await expect(page.getByTestId('palette-go-to-definition')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('in an HTML page’s inline <script> F12 explains that it is not supported (S57.1)', async () => {
  await openFile(page, 'inline.html');
  await cursorTo(6, 4); // in "hello();"
  await page.keyboard.press('F12');
  await expect(page.getByTestId('navigation-notice')).toContainText('<script>');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('navigation-dialog')).toBeHidden();
  expect(await onDisk('inline.html')).toBe(PAGE); // nothing changed
  expect(consoleErrors).toEqual([]);
});
