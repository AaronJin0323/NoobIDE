import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { makeProject, openFile, openProject, tabOf, typeAtEnd } from './project';

/**
 * S13.4 end to end: after a normal quit the app reopens the last project with its tabs, the visible tab and the
 * layout sizes, and says clearly where the project is. Crash recovery takes precedence: after a forced termination
 * with unsaved edits, the recovery dialog is offered and the project is not reopened behind it.
 */
test.describe.configure({ mode: 'serial' });

let tmp: string;
let userData: string;
let project: { tmp: string; root: string };
let app: ElectronApplication | null = null;
let page: Page;

async function start() {
  app = await launchApp({}, { userDataDir: userData });
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
}

async function stop() {
  const current = app;
  app = null;
  await current?.close();
}

/** Forced termination of the main process (no quit handlers), as in recovery.spec.ts. */
async function kill() {
  const current = app;
  app = null;
  if (!current) return;
  const pid = await current.evaluate(() => process.pid);
  process.kill(pid, 'SIGKILL');
  current.process().kill('SIGKILL');
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

/** Crash-journal records in app data (S12.1), excluding the quarantine. */
async function journalRecords(): Promise<number> {
  const dir = path.join(userData, 'recovery');
  let count = 0;
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory() || d.name === 'quarantine') continue;
    count += (await readdir(path.join(dir, d.name))).filter((n) => n.endsWith('.json')).length;
  }
  return count;
}

const width = async (testId: string) => (await page.getByTestId(testId).boundingBox())?.width ?? 0;

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-session-e2e-'));
  userData = path.join(tmp, '用户 数据');
  project = await makeProject('noobide-session-project-');
});

test.afterAll(async () => {
  await stop().catch(() => undefined);
  for (const dir of [tmp, project.tmp]) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

test('reopening restores the project, its tabs, the active tab and the layout sizes (S13.4)', async () => {
  await start();
  await openProject(app as ElectronApplication, page, project.root);
  await openFile(page, 'style.css');
  await openFile(page, '子 文件夹/页面 二.html');
  await openFile(page, 'script.js');
  await tabOf(page, '子 文件夹/页面 二.html').click();

  // Resize with the keyboard: files panel wider, editor share larger.
  const filesBefore = await width('region-files');
  await page.getByTestId('splitter-files').focus();
  await page.keyboard.press('Shift+ArrowRight'); // +64 px
  await expect.poll(() => width('region-files')).toBeGreaterThan(filesBefore + 50);
  await page.getByTestId('splitter-editor').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight'); // 60 % code
  await expect(page.getByTestId('splitter-editor')).toHaveAttribute('aria-valuenow', '60');
  const filesWidth = await width('region-files');
  const editorWidth = await width('region-editor');
  const previewWidth = await width('region-preview');
  expect(editorWidth).toBeGreaterThan(previewWidth);
  await page.waitForTimeout(800); // the session is written 300 ms after the last change
  await stop();

  await start();
  await expect(page.getByTestId('project-path')).toHaveText(project.root);
  await expect(page.getByTestId('session-restored')).toBeVisible();
  await expect(page.getByTestId('session-restored-path')).toHaveText(project.root);
  await expect(page.locator('[data-testid="tab"]')).toHaveCount(3);
  expect(
    await page.locator('[data-testid="tab"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-path'))),
  ).toEqual(['style.css', '子 文件夹/页面 二.html', 'script.js']);
  await expect(tabOf(page, '子 文件夹/页面 二.html')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('splitter-editor')).toHaveAttribute('aria-valuenow', '60');
  await expect.poll(() => width('region-files')).toBe(filesWidth);
  expect(Math.abs((await width('region-editor')) - editorWidth)).toBeLessThanOrEqual(2);
  await page.getByTestId('session-restored-dismiss').click();
  await expect(page.getByTestId('session-restored')).toHaveCount(0);
});

test('crash recovery takes precedence over session restore (S13.4 + S12)', async () => {
  // A read-only file cannot be saved, so its edits stay unsaved and only the crash journal has them (as in S12's e2e).
  const file = path.join(project.root, 'index.html');
  await chmod(file, 0o444);
  await openFile(page, 'index.html');
  await typeAtEnd(page, 'UNSAVED-BEFORE-CRASH');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'failed');
  await expect.poll(() => journalRecords()).toBeGreaterThan(0);
  await kill();
  await chmod(file, 0o644);
  // The unsaved buffer survived the crash in the journal (so the next start has something to offer).
  expect(await journalRecords()).toBeGreaterThan(0);

  await start();
  await expect(page.getByTestId('recovery-dialog')).toBeVisible();
  // The project is not reopened behind the recovery dialog; the user chooses there.
  await expect(page.getByTestId('project-name')).toHaveText('未打开项目');
  await expect(page.getByTestId('session-restored')).toHaveCount(0);
  await page.getByTestId('recovery-later').click();
  await stop();
});
