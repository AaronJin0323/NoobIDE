import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { DOC_START } from './keys';
import { launchApp } from './launch';
import {
  answerFolderDialog,
  collectConsoleErrors,
  focusEditor,
  makeProject,
  openFile,
  openProject,
  tabOf,
} from './project';

/**
 * S57 JavaScript navigation in the workbench, on a project whose path has Chinese characters and spaces: F12 into a
 * closed script, Shift+F12 across two files, the explained limit for an HTML page's inline <script>, and F12 pressed
 * right after opening a project, before its scripts are indexed.
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

/** S57.3: the editor test hooks that hold / release the project-script reads (monaco-setup.ts). */
type HookWindow = {
  __noobideEditorTestHooks: { holdProjectScriptReads(): void; releaseProjectScriptReads(): void };
};
const holdReads = () =>
  page.evaluate(() => (window as unknown as HookWindow).__noobideEditorTestHooks.holdProjectScriptReads());
const releaseReads = () =>
  page.evaluate(() => (window as unknown as HookWindow).__noobideEditorTestHooks.releaseProjectScriptReads());

/** Puts the cursor on `line` (1-based), `column` characters in. */
async function cursorTo(line: number, column: number): Promise<void> {
  await focusEditor(page);
  await page.keyboard.press(DOC_START);
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
  // One press: the command waits for the project's scripts to be indexed and for the language service to start, so
  // there is no "not found" to retry past (before the S57.3 fix this polled F12 and could leave that notice open).
  await page.keyboard.press('F12');
  await expect(tabOf(page, 'config.js')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('navigation-dialog')).toHaveCount(0);
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

test('F2 renames across both scripts after a per-file preview; each file undoes on its own (S57.2)', async () => {
  await page
    .getByTestId('navigation-dialog')
    .waitFor({ state: 'detached' })
    .catch(() => undefined);
  // Start with config.js closed again, so the rename has to open it.
  await openFile(page, 'config.js');
  await page.keyboard.press('ControlOrMeta+W');
  await expect(tabOf(page, 'config.js')).toHaveCount(0);
  await openFile(page, 'app.js');
  await cursorTo(1, 3);
  await page.keyboard.press('F2');
  const dialog = page.getByTestId('rename-dialog');
  await expect(page.getByTestId('rename-input')).toBeFocused();
  await expect(page.getByTestId('rename-input')).toHaveValue('greet');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('sayHello');
  await page.keyboard.press('Enter'); // Preview
  const files = dialog.getByTestId('rename-file');
  await expect(files).toHaveCount(2);
  expect(await files.evaluateAll((sections) => sections.map((s) => (s as HTMLElement).dataset.path))).toEqual([
    'app.js',
    'config.js',
  ]);
  await expect(files.first()).toContainText("sayHello('小雨');");
  expect(await onDisk('config.js')).toBe(CONFIG); // nothing written before Apply
  await expect(page.getByTestId('rename-apply')).toBeFocused();
  await page.keyboard.press('Enter'); // Apply
  await expect(dialog.getByTestId('rename-result')).toBeVisible();
  await expect(dialog.locator('[data-status="renamed"]')).toHaveCount(2);
  await expect.poll(() => onDisk('app.js')).toBe("sayHello('小雨');\nsayHello('Lin');\n");
  await expect.poll(() => onDisk('config.js')).toBe(CONFIG.replace('greet', 'sayHello'));
  await page.keyboard.press('Enter'); // Close
  await expect(dialog).toBeHidden();

  // Undo in config.js only (it was opened by the rename, in the background).
  await tabOf(page, 'config.js').click();
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+Z');
  await page.keyboard.press('ControlOrMeta+S');
  await expect.poll(() => onDisk('config.js')).toBe(CONFIG);
  expect(await onDisk('app.js')).toBe("sayHello('小雨');\nsayHello('Lin');\n");
});

test('F2 on a name of the browser is refused and says why; nothing changes (S57.2)', async () => {
  await writeFile(path.join(root, 'log.js'), 'console.log(1);\n');
  await openFile(page, 'log.js');
  await cursorTo(1, 10); // in "log"
  await page.keyboard.press('F2');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('print');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('rename-refused')).toContainText('浏览器自带');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('rename-dialog')).toBeHidden();
  expect(await onDisk('log.js')).toBe('console.log(1);\n');
  expect(consoleErrors).toEqual([]);
});

test('F12 pressed right after opening a project waits for its scripts to be indexed (S57.3)', async () => {
  // On a developer machine the project's scripts are read in milliseconds; on a starved hosted runner it takes seconds
  // (run 39041732247, macOS: an early F12 answered "not found"). The test hook holds the reads so the press provably
  // lands while the project is still being indexed; the user must see the wait, never "not found".
  const second = path.join(tmp, '第二个 项目');
  await mkdir(second, { recursive: true });
  await writeFile(path.join(second, 'config.js'), CONFIG);
  await writeFile(path.join(second, 'app.js'), APP);
  await holdReads();
  await answerFolderDialog(app, second);
  await page.getByTestId('open-other-folder').click();
  await expect(page.getByTestId('project-name')).toHaveText('第二个 项目');
  await openFile(page, 'app.js');
  await expect(tabOf(page, 'config.js')).toHaveCount(0);
  await focusEditor(page);
  await page.keyboard.press(DOC_START);
  await page.keyboard.press('ArrowRight'); // in "greet", column 2
  await page.keyboard.press('F12');
  // The command waits: the status strip says so in words, no sheet opens, nothing navigates yet.
  const note = page.getByTestId('navigation-indexing');
  await expect(note).toBeVisible();
  await expect(note).toContainText('转到定义');
  await expect(note).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('navigation-dialog')).toHaveCount(0);
  await expect(tabOf(page, 'config.js')).toHaveCount(0);
  // The disk "catches up": the same keypress navigates.
  await releaseReads();
  await expect(tabOf(page, 'config.js')).toHaveAttribute('aria-selected', 'true');
  await expect(note).toHaveCount(0);
  await expect(page.getByTestId('navigation-dialog')).toHaveCount(0);
  await expect(cursor()).toHaveText('行 1, 列 10');
  expect(consoleErrors).toEqual([]);
});
