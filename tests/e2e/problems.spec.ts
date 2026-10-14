import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { ProblemRecord } from '../../src/shared/problem';
import { launchApp } from './launch';
import { collectConsoleErrors, makeProject, openFile, openProject } from './project';

/**
 * Static diagnostics → problems (S19), the Problems panel (S17) and the problem card (S22.4/S22.5), on a project whose
 * path has Chinese characters and spaces.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

type HookWindow = { __noobideProblemsTestHooks: { static: ProblemRecord[] } };
const staticRecords = () =>
  page.evaluate(() =>
    (window as unknown as HookWindow).__noobideProblemsTestHooks.static.map((r) => ({
      file: r.file,
      line: r.line,
      column: r.column,
      code: r.code,
      severity: r.severity,
      message: r.originalMessage,
    })),
  );

const SCRIPT = "// 点按钮时打个招呼\nconst userName = '林小雨';\nconsole.log(userNmae);\n";

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-problems-'));
  await writeFile(path.join(root, 'script.js'), SCRIPT);
  await writeFile(path.join(root, 'style.css'), 'h1 {\n  colr: red;\n}\n');
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

test('language-service markers become static problem records, and fixing clears them (S19.1)', async () => {
  await openFile(page, 'script.js');
  await expect.poll(staticRecords, { timeout: 30_000 }).toEqual([
    {
      file: 'script.js',
      line: 3,
      column: 13,
      code: '2552',
      severity: 'error',
      message: "Cannot find name 'userNmae'. Did you mean 'userName'?",
    },
  ]);
  await openFile(page, 'style.css');
  await expect
    .poll(async () => (await staticRecords()).map((r) => `${r.file}:${r.line}:${r.code}:${r.severity}`))
    .toEqual(['script.js:3:2552:error', 'style.css:2:unknownProperties:warning']);

  // Fixing the CSS typo removes its record (after the debounce), the other file's record stays.
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('o'); // colr → color
  await expect.poll(async () => (await staticRecords()).map((r) => r.file)).toEqual(['script.js']);

  // Closing a file removes its records.
  await page.locator('[data-testid="tab"][data-path="script.js"] [data-testid="tab-close"]').click();
  await expect.poll(staticRecords).toEqual([]);
});

test('no console errors during the problems run', () => {
  expect(consoleErrors).toEqual([]);
});
