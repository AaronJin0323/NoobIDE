import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { collectConsoleErrors, makeProject, openFile, openProject } from './project';

/**
 * The problem card (S22.4, PLAN §9) and the one-click fix for a misspelled name (S22.5), on a project whose path has
 * Chinese characters and spaces. The fix is an ordinary editor edit saved through the file's save pipeline.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];
let userData: string;

const SCRIPT = "// 点按钮时打个招呼\nconst userName = '林小雨';\nconsole.log(userNmae);\n";
const FIXED = "// 点按钮时打个招呼\nconst userName = '林小雨';\nconsole.log(userName);\n";
// Two declared names are equally close to the misspelling, and one name is close to nothing.
const MULTI = 'const scoreTotal = 1;\nconst scoreTotul = 2;\nconsole.log(scoreTotol);\nconsole.log(qwertyuiop);\n';

const disk = (relPath: string) => readFile(path.join(root, relPath), 'utf8');
const toggle = () => page.getByTestId('problems-toggle');
const panel = () => page.getByTestId('problems-panel');
const section = (id: string) => page.locator(`[data-section="${id}"]`);
const rowAt = (id: string, where: string) => section(id).getByTestId('problem-row').filter({ hasText: where }).first();
const fixCard = () => page.getByTestId('problem-fix-card');
const fixStatus = () => page.getByTestId('problem-fix-status');
const lines = () => page.locator('.monaco-editor .view-lines');
const editorHasFocus = () => page.evaluate(() => Boolean(document.activeElement?.closest('.monaco-editor')));

async function expand(row: ReturnType<typeof rowAt>) {
  const summary = row.getByTestId('problem-summary');
  if ((await summary.getAttribute('aria-expanded')) !== 'true') await summary.click();
  await expect(row.getByTestId('problem-card')).toBeVisible();
}

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-问题卡片-'));
  await writeFile(path.join(root, 'script.js'), SCRIPT);
  await writeFile(path.join(root, 'multi.js'), MULTI);
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="utf-8" />\n    <title>卡片</title>\n  </head>\n  <body>\n    <h1>你好</h1>\n    <script src="script.js"></script>\n  </body>\n</html>\n',
  );
  userData = path.join(tmp, '应用 数据');
  await mkdir(userData, { recursive: true });
  app = await launchApp({}, { userDataDir: userData });
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
});

test.afterAll(async () => {
  await chmod(path.join(root, 'script.js'), 0o644).catch(() => undefined);
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('the card shows file, line, explanation, checks, Go to code and Show original in zh-CN and en (S22.4)', async () => {
  await openFile(page, 'script.js');
  await expect(toggle()).toContainText('1 个错误', { timeout: 30_000 });
  await toggle().click();
  await expect(panel()).toBeVisible();
  const row = rowAt('static', 'script.js:3');
  await expand(row);
  const card = row.getByTestId('problem-card');
  await expect(card).toHaveAttribute('role', 'group');
  await expect(card.getByTestId('problem-card-head')).toHaveText('代码检查 script.js，第 3 行：找不到变量 userNmae。');
  await expect(card.getByTestId('problem-explanation')).toHaveText('这个名字可能拼错了，也可能还没有定义。');
  // The language service found the declaration: the check names it and its line (PLAN §9 example).
  await expect(card.getByTestId('problem-checks')).toContainText(
    '检查它的拼写是否和定义时的 userName（第 2 行）一致。',
    {
      timeout: 15_000,
    },
  );
  await expect(card.getByTestId('problem-checks')).toContainText('如果这个变量还没有定义，先声明它。');
  await expect(card.getByTestId('problem-go-to')).toHaveText('转到代码');
  await card.getByTestId('problem-show-original').click();
  await expect(card.getByTestId('problem-original-message')).toHaveText(
    "Cannot find name 'userNmae'. Did you mean 'userName'?",
  );

  await page.getByTestId('switch-language').click();
  await expect(card.getByTestId('problem-card-head')).toHaveText(
    'Code check script.js, line 3: Cannot find the variable userNmae.',
  );
  await expect(card.getByTestId('problem-checks')).toContainText('userName (line 2)');
  await expect(card.getByTestId('problem-go-to')).toHaveText('Go to code');
  await expect(card.getByTestId('problem-show-original')).toHaveText('Show original error');
  await expect(card.getByTestId('problem-fix')).toHaveText('Change to userName');
  await page.getByTestId('switch-language').click();
  await expect(card.getByTestId('problem-fix')).toHaveText('改成 userName');
});

test('several or no similar declared names: no fix, the normal explanation and Go to code (S22.5)', async () => {
  await openFile(page, 'multi.js');
  const several = rowAt('static', 'multi.js:3');
  await expect(several).toBeVisible({ timeout: 30_000 });
  await expand(several);
  await expect(several.getByTestId('problem-checks')).toContainText('scoreTotal', { timeout: 15_000 });
  await expect(several.getByTestId('problem-checks')).toContainText('scoreTotul');
  await expect(several.getByTestId('problem-go-to')).toBeVisible();
  await expect(several.getByTestId('problem-fix')).toHaveCount(0);

  const none = rowAt('static', 'multi.js:4');
  await expand(none);
  await expect(none.getByTestId('problem-checks')).toContainText('检查名字的拼写和大小写');
  await expect(none.getByTestId('problem-go-to')).toBeVisible();
  await expect(none.getByTestId('problem-fix')).toHaveCount(0);
  await page.locator('[data-testid="tab"][data-path="multi.js"] [data-testid="tab-close"]').click();
});

test('fix from the keyboard: only that span changes, saved atomically, resolved after re-check; card Undo (S22.5)', async () => {
  const row = rowAt('static', 'script.js:3');
  await expand(row);
  const fix = row.getByTestId('problem-fix');
  await expect(fix).toHaveText('改成 userName', { timeout: 15_000 });
  await fix.focus();
  await page.keyboard.press('Enter');

  // The result card takes focus and says what happened, in words.
  await expect(fixCard()).toBeFocused();
  await expect(fixStatus()).toHaveAttribute('role', 'status');
  await expect(fixStatus()).toHaveText('已解决：script.js 第 3 行，重新检查后不再报告这个问题。', { timeout: 20_000 });
  await expect(fixCard()).toHaveAttribute('data-phase', 'resolved');
  expect(await disk('script.js')).toBe(FIXED);
  await expect(page.getByTestId('save-status')).toHaveText('已保存');
  await expect(rowAt('static', 'script.js:3')).toHaveCount(0, { timeout: 20_000 });
  // The original error stays available until cleared.
  await fixCard().getByTestId('problem-fix-show-original').click();
  await expect(fixCard().getByTestId('problem-original-message')).toHaveText(
    "Cannot find name 'userNmae'. Did you mean 'userName'?",
  );

  // Undo on the card, keyboard only: the original text is back and saved, the problem is reported again.
  await fixCard().getByTestId('problem-fix-undo').focus();
  await page.keyboard.press('Enter');
  await expect(fixStatus()).toHaveText('已撤销：script.js 第 3 行恢复为 userNmae，并已保存。');
  expect(await disk('script.js')).toBe(SCRIPT);
  await expect(rowAt('static', 'script.js:3')).toBeVisible({ timeout: 20_000 });
  await fixCard().getByTestId('problem-fix-clear').click();
  await expect(fixCard()).toHaveCount(0);
});

test('the fix is a normal editor edit: Ctrl/Cmd+Z in the editor takes it back (S22.5)', async () => {
  const row = rowAt('static', 'script.js:3');
  await expand(row);
  await row.getByTestId('problem-fix').click();
  await expect(fixCard()).toHaveAttribute('data-phase', 'resolved', { timeout: 20_000 });
  expect(await disk('script.js')).toBe(FIXED);
  await expect(fixCard()).toContainText(process.platform === 'darwin' ? '⌘Z' : 'Ctrl+Z');

  await fixCard().getByTestId('problem-fix-go-to').click();
  await expect.poll(editorHasFocus).toBe(true);
  await expect(page.getByTestId('cursor-position')).toHaveText('行 3, 列 13');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(lines()).toContainText('console.log(userNmae);');
  // Autosave writes the undone text; the card no longer claims the problem is resolved.
  await expect.poll(() => disk('script.js'), { timeout: 10_000 }).toBe(SCRIPT);
  await expect(fixCard()).toHaveAttribute('data-phase', 'still-reported', { timeout: 20_000 });
  await expect(fixStatus()).toContainText('仍然报告这个问题');
  await fixCard().getByTestId('problem-fix-clear').click();
});

test('a failed save keeps the edit, shows the save failure and never shows resolved; a retry resolves it (S22.5)', async () => {
  const file = path.join(root, 'script.js');
  await chmod(file, 0o444);
  const row = rowAt('static', 'script.js:3');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expand(row);
  await row.getByTestId('problem-fix').click();
  await expect(fixCard()).toHaveAttribute('data-phase', 'save-failed', { timeout: 20_000 });
  await expect(fixStatus()).toContainText('保存失败');
  await expect(fixStatus()).toContainText('修改还在编辑器里');
  await expect(page.getByTestId('save-status')).toHaveText('保存失败 — 你的修改还在');
  await expect(lines()).toContainText('console.log(userName);');
  expect(await disk('script.js')).toBe(SCRIPT);
  // Even once the code check no longer reports it, a fix that is not on disk is not called resolved.
  await expect(rowAt('static', 'script.js:3')).toHaveCount(0, { timeout: 20_000 });
  await page.waitForTimeout(1500);
  await expect(fixCard()).toHaveAttribute('data-phase', 'save-failed');
  await expect(fixStatus()).not.toContainText('已解决');

  await chmod(file, 0o644);
  await fixCard().getByTestId('problem-fix-retry').click();
  await expect(fixCard()).toHaveAttribute('data-phase', 'resolved', { timeout: 20_000 });
  expect(await disk('script.js')).toBe(FIXED);
  // Put the mistake back for the runtime test.
  await fixCard().getByTestId('problem-fix-undo').click();
  await expect(fixCard()).toHaveAttribute('data-phase', 'undone');
  expect(await disk('script.js')).toBe(SCRIPT);
  await fixCard().getByTestId('problem-fix-clear').click();
});

test('a problem from the running page is resolved only after the preview reloaded without it (S22.5)', async () => {
  await page.getByTestId('preview-start').click();
  await expect(page.getByTestId('preview-state')).toHaveAttribute('data-state', 'running', { timeout: 20_000 });
  const row = rowAt('runtime', 'script.js:3');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expand(row);
  await expect(row.getByTestId('problem-card-head')).toContainText('运行时错误');
  const fix = row.getByTestId('problem-fix');
  await expect(fix).toHaveText('改成 userName', { timeout: 15_000 });
  await fix.click();
  // The save refreshes the preview (S10.5); the error does not occur in the new page load.
  await expect(fixStatus()).toHaveText('已解决：script.js 第 3 行，重新检查和刷新预览后都没有再出现。', {
    timeout: 30_000,
  });
  expect(await disk('script.js')).toBe(FIXED);
  await expect(row).toContainText('刷新后没有再出现');

  // English: the result is announced in English too.
  await page.getByTestId('switch-language').click();
  await expect(fixStatus()).toHaveText(
    'Resolved: script.js line 3 — not reported again after checking again and refreshing the preview.',
  );
  await page.getByTestId('switch-language').click();
});

test('no console errors during the problem card run', () => {
  expect(consoleErrors).toEqual([]);
});

/** Texts of the recovery journal records (S12) in this run's app data. */
async function journalTexts(): Promise<string[]> {
  const dir = path.join(userData, 'recovery');
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory() || d.name === 'quarantine') continue;
    for (const name of await readdir(path.join(dir, d.name))) {
      if (name.endsWith('.json')) out.push(await readFile(path.join(dir, d.name, name), 'utf8'));
    }
  }
  return out;
}

/** Forced termination, as in recovery.spec.ts: no quit handlers run. */
async function kill() {
  const pid = await app.evaluate(() => process.pid);
  process.kill(pid, 'SIGKILL');
  app.process().kill('SIGKILL');
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
}

test('a fix applied to a background tab whose save fails is journaled and survives a forced kill (S22.5, S12)', async () => {
  const file = path.join(root, 'script.js');
  if ((await fixCard().count()) > 0) await fixCard().getByTestId('problem-fix-clear').click();
  if ((await toggle().getAttribute('aria-expanded')) !== 'true') await toggle().click();
  // Put the mistake back from outside NoobIDE: the open tab reloads it (S11).
  await writeFile(file, SCRIPT);
  await openFile(page, 'script.js');
  await expect(lines()).toContainText('console.log(userNmae);', { timeout: 10_000 });
  await expect(rowAt('static', 'script.js:3')).toBeVisible({ timeout: 20_000 });
  await openFile(page, 'index.html'); // script.js is now a background tab
  await expect(page.locator('[data-testid="tab"][data-path="index.html"] [role="tab"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await chmod(file, 0o444);
  const row = rowAt('static', 'script.js:3');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expand(row);
  await row.getByTestId('problem-fix').click();
  await expect(fixCard()).toHaveAttribute('data-phase', 'save-failed', { timeout: 20_000 });
  expect(await disk('script.js')).toBe(SCRIPT);
  // The edit exists only in memory — and in the recovery journal (outside the project).
  await expect
    .poll(async () => (await journalTexts()).some((t) => t.includes('console.log(userName);')), { timeout: 5000 })
    .toBe(true);

  await kill();
  await chmod(file, 0o644);
  expect(await disk('script.js')).toBe(SCRIPT);
  app = await launchApp({}, { userDataDir: userData });
  page = await app.firstWindow();
  const dialog = page.getByTestId('recovery-dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByTestId('recovery-project')).toContainText('script.js');
  await dialog.getByTestId('recovery-review').click();
  await expect(dialog.getByTestId('recovery-diff').locator('[data-kind="added"]')).toContainText(
    'console.log(userName);',
  );
});
