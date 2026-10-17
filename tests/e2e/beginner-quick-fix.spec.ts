import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { collectConsoleErrors, documentText, makeProject, openFile, openProject, switchLanguage } from './project';

/**
 * S55.3: quick fixes for rules 16, 18, 19 and 23 on the problem card and in the editor lightbulb, on a project whose
 * path has Chinese characters and spaces. Each fix is one ordinary editor edit, saved through the file's save
 * pipeline (autosaved, snapshotted in local history), undoable, keyboard-reachable, and its result is announced as
 * text on the fix card (zh-CN and en).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const PAGE = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '  <head>',
  '    <meta charset="utf-8" />',
  '    <title>快速修复</title>',
  '    <link rel="stylesheet" href="css/主题 样式.css" />',
  '  </head>',
  '  <body>',
  '    <section>',
  '      <h1 id="title">你好</h1>',
  '      <img src="images/logoo.png" alt="标志" />',
  '      <img src="images/logo.png" />',
  '    </secton>',
  '    <script src="js/app.js"></script>',
  '  </body>',
  '</html>',
  '',
].join('\n');
const SCRIPT = "const title = document.getElementById('#title');\n";

const disk = (relPath: string) => readFile(path.join(root, relPath), 'utf8');
const toggle = () => page.getByTestId('problems-toggle');
const panel = () => page.getByTestId('problems-panel');
const section = (id: string) => page.locator(`[data-section="${id}"]`);
const rowAt = (where: string) => section('static').getByTestId('problem-row').filter({ hasText: where }).first();
const fixCard = () => page.getByTestId('problem-fix-card');
const fixStatus = () => page.getByTestId('problem-fix-status');
const editorHasFocus = () => page.evaluate(() => Boolean(document.activeElement?.closest('.monaco-editor')));
const editorText = () => documentText(page.locator('.monaco-editor'));

async function expand(row: ReturnType<typeof rowAt>) {
  const summary = row.getByTestId('problem-summary');
  if ((await summary.getAttribute('aria-expanded')) !== 'true') await summary.click();
  await expect(row.getByTestId('problem-card')).toBeVisible();
}

/** Applies the card's fix from the keyboard and waits for the resolved state (said in words). */
async function fixFromCard(where: string, label: string, resolved: string) {
  const row = rowAt(where);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expand(row);
  const fix = row.getByTestId('problem-fix');
  await expect(fix).toHaveText(label, { timeout: 15_000 });
  await fix.focus();
  await page.keyboard.press('Enter');
  await expect(fixCard()).toBeFocused();
  await expect(fixStatus()).toHaveAttribute('role', 'status');
  await expect(fixStatus()).toHaveText(resolved, { timeout: 20_000 });
  await expect(fixCard()).toHaveAttribute('data-phase', 'resolved');
}

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-快速 修复-'));
  await mkdir(path.join(root, 'css'), { recursive: true });
  await mkdir(path.join(root, 'images'), { recursive: true });
  await mkdir(path.join(root, 'js'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), PAGE);
  await writeFile(path.join(root, 'css', 'base.css'), 'body {\n  margin: 0;\n}\n');
  await writeFile(path.join(root, 'images', 'logo.png'), 'png');
  await writeFile(path.join(root, 'js', 'app.js'), SCRIPT);
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

test('card: change a broken path to the existing file, saved and snapshotted (zh-CN)', async () => {
  await openFile(page, 'index.html');
  await expect(toggle()).toContainText('警告', { timeout: 30_000 });
  await toggle().click();
  await expect(panel()).toBeVisible();
  await fixFromCard(
    'index.html:11',
    '把路径改成 images/logo.png',
    '已解决：index.html 第 11 行，重新检查后不再报告这个问题。',
  );
  expect(await disk('index.html')).toBe(PAGE.replace('images/logoo.png', 'images/logo.png'));
  await expect(page.getByTestId('save-status')).toHaveText('已保存');
  // The save went through the normal pipeline, so local history has a version after it.
  await page.getByTestId('show-history').click();
  await expect(page.getByTestId('history-dialog')).toBeVisible();
  await expect(page.getByTestId('history-version').first()).toHaveAttribute('data-reason', 'after-save');
  await page.getByTestId('history-close').click();
  await fixCard().getByTestId('problem-fix-clear').click();
});

test('card: add alt, then Ctrl/Cmd+Z in the editor takes it back like any edit', async () => {
  await fixFromCard(
    'index.html:12',
    '给这个 <img> 加上 alt=""',
    '已解决：index.html 第 12 行，重新检查后不再报告这个问题。',
  );
  expect(await disk('index.html')).toContain('<img alt="" src="images/logo.png" />');
  await fixCard().getByTestId('problem-fix-go-to').click();
  await expect.poll(editorHasFocus).toBe(true);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(editorText).toContain('<img src="images/logo.png" />');
  await expect.poll(() => disk('index.html'), { timeout: 10_000 }).toContain('<img src="images/logo.png" />');
  await expect(fixCard()).toHaveAttribute('data-phase', 'still-reported', { timeout: 20_000 });
  await fixCard().getByTestId('problem-fix-clear').click();
});

test('card: fix the closing tag; Undo on the card puts it back and saves', async () => {
  await fixFromCard(
    'index.html:13',
    '把 </secton> 改成 </section>',
    '已解决：index.html 第 13 行，重新检查后不再报告这个问题。',
  );
  expect(await disk('index.html')).toContain('    </section>\n');
  await fixCard().getByTestId('problem-fix-undo').focus();
  await page.keyboard.press('Enter');
  await expect(fixStatus()).toHaveText('已撤销：index.html 第 13 行恢复为 secton，并已保存。');
  await expect.poll(() => disk('index.html')).toContain('    </secton>\n');
  await fixCard().getByTestId('problem-fix-clear').click();
});

test('card: create the missing file from a template; it never existed before and opens in a tab', async () => {
  await fixFromCard(
    'index.html:6',
    '新建文件 css/主题 样式.css',
    '已解决：index.html 第 6 行，重新检查后不再报告这个问题。',
  );
  expect(await disk('css/主题 样式.css')).toBe('/* 主题 样式：在这里写样式。 */\n');
  await expect(page.locator('[data-testid="tab"][data-path="css/主题 样式.css"]')).toBeVisible();
  await fixCard().getByTestId('problem-fix-clear').click();
});

test('card: rename to the defined id in getElementById (en), keyboard only', async () => {
  await switchLanguage(page);
  await openFile(page, 'js/app.js');
  await fixFromCard(
    'js/app.js:1',
    "Change '#title' to 'title'",
    'Resolved: js/app.js line 1 — checking again no longer reports this problem.',
  );
  expect(await disk('js/app.js')).toBe("const title = document.getElementById('title');\n");
  await fixCard().getByTestId('problem-fix-clear').click();
});

test('lightbulb: Ctrl/Cmd+. offers the same fix with the same label; applying it keeps focus in the editor (en)', async () => {
  await openFile(page, 'index.html');
  const row = rowAt('index.html:12');
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expand(row);
  await row.getByTestId('problem-go-to').click();
  await expect.poll(editorHasFocus).toBe(true);
  await page.keyboard.press('ControlOrMeta+.');
  // Monaco's quick-fix menu (its Action Widget listbox) lists the fix with the card's label, keyboard-selected.
  const option = page
    .getByRole('listbox', { name: 'Action Widget' })
    .getByRole('option', { name: /Add alt="" to this <img>/ });
  await expect(option).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Enter');
  await expect.poll(() => disk('index.html'), { timeout: 15_000 }).toContain('<img alt="" src="images/logo.png" />');
  // The result is announced as text on the fix card; the keyboard stays in the editor.
  await expect(panel()).toBeVisible();
  await expect(fixStatus()).toHaveText(
    'Resolved: index.html line 12 — checking again no longer reports this problem.',
    {
      timeout: 20_000,
    },
  );
  expect(await editorHasFocus()).toBe(true);
  // One ordinary edit: undo in the editor takes it back.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(editorText).toContain('<img src="images/logo.png" />');
  await fixCard().getByTestId('problem-fix-clear').click();
  await switchLanguage(page);
});

test('no console errors during the quick-fix run', () => {
  expect(consoleErrors).toEqual([]);
});
