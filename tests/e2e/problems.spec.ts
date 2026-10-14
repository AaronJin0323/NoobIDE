import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { ProblemRecord } from '../../src/shared/problem';
import { launchApp, repoRoot } from './launch';
import { collectConsoleErrors, makeProject, openFile, openProject } from './project';
import { evalInPreview } from './preview-helpers';

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
  // S17.1: a page with a missing image (wireframe 3b: case mismatch, 头像.PNG) for the resource section.
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="utf-8" />\n    <title>我的 主页</title>\n  </head>\n  <body>\n    <h1>你好</h1>\n    <img src="images/头像.PNG" alt="头像" />\n    <script src="script.js"></script>\n  </body>\n</html>\n',
  );
  // S19.2: beginner-tuning fixtures (noise that must stay quiet, mistakes that must be reported).
  await cp(path.join(repoRoot, 'tests', 'fixtures', 'static-diagnostics'), path.join(root, 'diag'), {
    recursive: true,
  });
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

test('beginner tuning: noisy-but-valid code stays quiet; undefined names and syntax errors are kept (S19.2)', async () => {
  const expected = JSON.parse(
    await readFile(path.join(repoRoot, 'tests', 'fixtures', 'static-diagnostics', 'expected.json'), 'utf8'),
  ) as { files: Record<string, string[]> };
  for (const [file, codes] of Object.entries(expected.files)) {
    await openFile(page, `diag/${file}`);
    const mine = async () =>
      (await staticRecords()).filter((r) => r.file === `diag/${file}`).map((r) => `${r.line}:${r.code}:${r.severity}`);
    await expect.poll(mine, { timeout: 30_000 }).toEqual(codes);
  }
  // The quiet files stay quiet once every file has been checked: the services answer within about a second here
  // (the files with errors above show they are running), so 3 s later nothing may have arrived for a quiet file.
  await page.waitForTimeout(3000);
  for (const [file, codes] of Object.entries(expected.files)) {
    if (codes.length) continue;
    expect((await staticRecords()).filter((r) => r.file === `diag/${file}`)).toEqual([]);
  }
});

const toggle = () => page.getByTestId('problems-toggle');
const panel = () => page.getByTestId('problems-panel');
const section = (id: string) => page.locator(`[data-section="${id}"]`);
const editorHasFocus = () => page.evaluate(() => Boolean(document.activeElement?.closest('.monaco-editor')));

test('problems appear in the status strip without opening the panel or taking focus; announced politely (S17.1)', async () => {
  // Start from only the userNmae problem: close every other tab.
  const tabs = page.locator('[data-testid="tab"]');
  while ((await tabs.count()) > 0) {
    const before = await tabs.count();
    await tabs.first().locator('[data-testid="tab-close"]').click();
    await expect(tabs).toHaveCount(before - 1);
  }
  await openFile(page, 'script.js');
  await expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle()).toContainText('问题 · 1 个错误', { timeout: 30_000 });
  await expect(toggle()).toHaveAttribute('data-errors', '1');
  const announcer = page.getByTestId('problems-announcer');
  await expect(announcer).toHaveAttribute('aria-live', 'polite');
  await expect(announcer).toHaveText(/发现 1 个新问题/);
  const firstAnnouncement = await announcer.textContent();

  // Typing a second mistake: the count goes up, the panel stays closed, focus stays in the editor.
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('console.log(scoreTotal);');
  await expect(toggle()).toContainText('问题 · 2 个错误', { timeout: 30_000 });
  await expect(panel()).toBeHidden();
  expect(await editorHasFocus()).toBe(true);
  // Announced once more (a new text, so screen readers read it), without moving focus.
  await expect.poll(() => announcer.textContent()).not.toBe(firstAnnouncement);
  await expect(announcer).toHaveText(/发现 1 个新问题/);
  expect(await editorHasFocus()).toBe(true);
  // Remove the second mistake again: back to one problem.
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Delete');
  await expect(toggle()).toContainText('问题 · 1 个错误', { timeout: 30_000 });
});

test('the panel lists static, runtime and resource problems in separate sections with counts (S17.1)', async () => {
  await toggle().click();
  await expect(panel()).toBeVisible();
  await expect(toggle()).toBeFocused(); // opening it does not move focus into the panel
  await expect(page.getByTestId('problems-badge-static')).toHaveText('1');
  await expect(page.getByTestId('problems-badge-runtime')).toHaveText('0');
  await expect(page.getByTestId('problems-badge-resource')).toHaveText('0');
  const row = section('static').getByTestId('problem-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('错误');
  await expect(row).toContainText('script.js:3');
  await expect(row).toContainText('找不到变量 userNmae。');

  // Run the page: the browser's ReferenceError and the missing image arrive as runtime and resource problems.
  await page.getByTestId('preview-start').click();
  await expect(page.getByTestId('preview-state')).toHaveAttribute('data-state', 'running', { timeout: 20_000 });
  await expect(page.getByTestId('problems-badge-runtime')).toHaveText('1', { timeout: 20_000 });
  await expect(page.getByTestId('problems-badge-resource')).toHaveText('1');
  await expect(section('runtime').getByTestId('problem-row')).toContainText('找不到变量 userNmae。');
  await expect(section('runtime').getByTestId('problem-row')).toHaveAttribute('data-code', 'ReferenceError');
  await expect(section('resource').getByTestId('problem-row')).toContainText('images/头像.PNG');
  await expect(toggle()).toContainText('3 个错误');

  // English UI: same structure, translated labels.
  await page.getByTestId('switch-language').click();
  await expect(section('static')).toContainText('Code check');
  await expect(section('runtime')).toContainText('While the page runs');
  await expect(section('resource')).toContainText('Loading files');
  await expect(toggle()).toContainText('Problems · 3 errors');
  await page.getByTestId('switch-language').click();
});

test('Go to code opens the file at the reported line and column and focuses the editor (S17.2)', async () => {
  // A static problem: the editor moves to script.js line 3, column 13 (where userNmae starts).
  await page.locator('[data-testid="tab"][data-path="script.js"] [data-testid="tab-close"]').click();
  const staticRow = section('static').getByTestId('problem-row');
  await expect(staticRow).toHaveCount(0); // closed file: its static problem is gone, the runtime one stays
  const runtimeRow = section('runtime').getByTestId('problem-row');
  await runtimeRow.getByTestId('problem-summary').click();
  await expect(runtimeRow.getByTestId('problem-summary')).toHaveAttribute('aria-expanded', 'true');
  // The runtime record reports line 3 (Chromium gives no column for this record): the closed file opens there.
  await runtimeRow.getByTestId('problem-go-to').click();
  await expect(page.locator('[data-testid="tab"][data-path="script.js"] [role="tab"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId('cursor-position')).toHaveText('行 3, 列 1');
  await expect.poll(editorHasFocus).toBe(true);

  // The static problem is back (the file is open again) and goes to the exact column, keyboard only.
  await expect(staticRow).toHaveCount(1, { timeout: 30_000 });
  await staticRow.getByTestId('problem-summary').focus();
  await page.keyboard.press('Enter');
  await staticRow.getByTestId('problem-go-to').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('cursor-position')).toHaveText('行 3, 列 13');
  await expect.poll(editorHasFocus).toBe(true);
});

test('Show original error reveals the exact message, stack and where it came from (S17.2)', async () => {
  const runtimeRow = section('runtime').getByTestId('problem-row');
  await runtimeRow.getByTestId('problem-summary').click(); // one problem's details at a time
  const show = runtimeRow.getByTestId('problem-show-original');
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await expect(runtimeRow.getByTestId('problem-original')).toHaveCount(0);
  await show.click();
  await expect(show).toHaveAttribute('aria-expanded', 'true');
  await expect(runtimeRow.getByTestId('problem-original-message')).toHaveText(
    'Uncaught ReferenceError: userNmae is not defined',
  );
  await expect(runtimeRow.getByTestId('problem-original-meta')).toContainText('代码 ReferenceError');
  await expect(runtimeRow.getByTestId('problem-original-meta')).toContainText('来源：预览页面');

  const staticRow = section('static').getByTestId('problem-row');
  await staticRow.getByTestId('problem-summary').click();
  await staticRow.getByTestId('problem-show-original').click();
  await expect(staticRow.getByTestId('problem-original-message')).toHaveText(
    "Cannot find name 'userNmae'. Did you mean 'userName'?",
  );
  await expect(staticRow.getByTestId('problem-original-meta')).toContainText('代码 2552');
  await expect(staticRow.getByTestId('problem-original-meta')).toContainText('来源：代码检查（javascript）');
});

test('console view: levels, filter, clear, and attribution to the current page load (S17.3)', async () => {
  const consoleView = page.getByTestId('preview-console');
  const lines = consoleView.locator('li');
  await evalInPreview(app, "console.info('信息一'); console.warn('警告一'); console.error('错误一'); 1");
  await expect(consoleView).toContainText('错误一');
  // Levels are spelled out on every line (not colour alone).
  await expect(lines.filter({ hasText: '警告一' })).toContainText('警告');
  await expect(lines.filter({ hasText: '信息一' })).toContainText('信息');

  const level = page.getByTestId('console-level');
  await level.selectOption('error');
  await expect(lines.filter({ hasText: '错误一' })).toHaveCount(1);
  await expect(lines.filter({ hasText: '警告一' })).toHaveCount(0);
  await expect(lines.filter({ hasText: '信息一' })).toHaveCount(0);
  await level.selectOption('warning');
  await expect(lines).toHaveCount(1);
  await expect(lines).toContainText('警告一');
  await level.selectOption('all');

  // A refresh starts a new page load: earlier output is labelled "before refresh" and can be hidden.
  await page.getByTestId('preview-reload').click();
  await expect(page.getByTestId('preview-state')).toHaveAttribute('data-state', 'running', { timeout: 20_000 });
  await evalInPreview(app, "console.info('刷新后'); 1");
  await expect(lines.filter({ hasText: '刷新后' })).toHaveCount(1);
  await expect(lines.filter({ hasText: '刷新后' })).not.toContainText('刷新前');
  await expect(lines.filter({ hasText: '信息一' })).toContainText('刷新前');
  const onlyCurrent = page.getByTestId('console-only-current');
  await onlyCurrent.check();
  await expect(lines.filter({ hasText: '信息一' })).toHaveCount(0);
  await expect(lines.filter({ hasText: '刷新后' })).toHaveCount(1);

  await page.getByTestId('console-clear').click();
  await expect(lines).toHaveCount(0);
  await expect(consoleView).toContainText('网页还没有输出。');
});

test('no console errors during the problems run', () => {
  expect(consoleErrors).toEqual([]);
});
