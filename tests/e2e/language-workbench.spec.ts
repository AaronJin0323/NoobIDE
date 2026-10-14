import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { collectConsoleErrors, makeProject, openFile, openProject, tabOf } from './project';

/**
 * Language features in the workbench (S18.3 formatting, S18.4 multi-file JS + worker recovery). One app, one
 * project with a Chinese path and spaces (tests/fixtures/中文 路径 项目, copied to a temp folder).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

interface EditorTestHooks {
  preFormat: { uri: string; languageId: string }[];
}
const preFormat = () =>
  page.evaluate(
    () => (window as unknown as { __noobideEditorTestHooks?: EditorTestHooks }).__noobideEditorTestHooks?.preFormat,
  );

const onDisk = (rel: string) => readFile(path.join(root, ...rel.split('/')), 'utf8');

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-lang-'));
  await writeFile(path.join(root, 'style.css'), 'h1{color:red;margin:0}\n');
  await writeFile(path.join(root, 'script.js'), 'function add(a,b){\nreturn a+b\n}\n');
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('Format button formats CSS, saves it, and fires the pre-format hook first (S18.3)', async () => {
  await openFile(page, 'style.css');
  const before = (await preFormat())?.length ?? 0;
  const button = page.getByTestId('format-document');
  await expect(button).toHaveText('整理格式');
  await expect(button).toHaveAttribute('title', /Shift\+Alt\+F/);
  await button.click();
  await expect.poll(() => onDisk('style.css')).toBe('h1 {\n  color: red;\n  margin: 0\n}');
  const events = (await preFormat()) ?? [];
  expect(events.length).toBe(before + 1);
  expect(events.at(-1)).toMatchObject({ languageId: 'css' });
  expect(decodeURIComponent(events.at(-1)?.uri ?? '')).toContain('中文 路径 项目/style.css');
  // Formatting is a normal edit: Ctrl/Cmd+Z brings the original text back (and autosave writes it).
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+Z');
  await expect.poll(() => onDisk('style.css')).toBe('h1{color:red;margin:0}\n');
});

test('Shift+Alt+F formats JavaScript and fires the hook (S18.3)', async () => {
  await openFile(page, 'script.js');
  await expect(tabOf(page, 'script.js')).toHaveAttribute('aria-selected', 'true');
  const before = (await preFormat())?.length ?? 0;
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Shift+Alt+F');
  await expect.poll(() => onDisk('script.js')).toBe('function add(a, b) {\n  return a + b\n}\n');
  const events = (await preFormat()) ?? [];
  expect(events.length).toBe(before + 1);
  expect(events.at(-1)).toMatchObject({ languageId: 'javascript' });
});

test('no console errors during the language run', () => {
  expect(consoleErrors).toEqual([]);
});
