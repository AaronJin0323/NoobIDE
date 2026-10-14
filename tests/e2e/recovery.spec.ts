import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, repoRoot, tempRoot } from './launch';
import { DOC_END } from './keys';

/**
 * S12.1–S12.3 end to end: unsaved edits are journaled to app data within 2 s, survive a forced termination of the
 * app (ChildProcess.kill('SIGKILL'): TerminateProcess on Windows, SIGKILL on macOS — no quit handlers run), and the
 * relaunched app offers to restore them with a diff against the file on disk. The app
 * runs with its own app-data directory (--user-data-dir), whose path also has Chinese characters and spaces.
 */
test.describe.configure({ mode: 'serial' });

let tmp: string;
let root: string;
let userData: string;
let app: ElectronApplication | null = null;
let page: Page;
const consoleErrors: string[] = [];

const journalDir = () => path.join(userData, 'recovery');

/** Journal records (excluding the quarantine). */
async function journalRecords(): Promise<string[]> {
  const out: string[] = [];
  const dirs = await readdir(journalDir(), { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory() || d.name === 'quarantine') continue;
    for (const name of await readdir(path.join(journalDir(), d.name))) {
      if (name.endsWith('.json')) out.push(path.join(d.name, name));
    }
  }
  return out;
}

async function projectTree(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await projectTree(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

async function start() {
  app = await launchApp({}, { userDataDir: userData });
  page = await app.firstWindow();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.locator('.monaco-editor .view-lines').waitFor();
}

/** Normal quit. */
async function stop() {
  const current = app;
  app = null;
  await current?.close();
}

/**
 * Forced termination of the Electron main process: no quit handlers, no flush. On Windows Playwright starts Electron
 * through a `cmd.exe` wrapper, so `app.process()` is not the app — the main process id is asked from the app itself
 * and killed directly (TerminateProcess on Windows, SIGKILL on macOS), then the wrapper is killed too.
 */
async function kill() {
  const current = app;
  app = null;
  if (!current) return;
  const pid = await current.evaluate(() => process.pid);
  process.kill(pid, 'SIGKILL');
  current.process().kill('SIGKILL');
  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10_000 },
    )
    .toBe(false);
}

async function openProjectAndFile(relPath: string) {
  await app?.evaluate(({ dialog }, chosen) => {
    const fake = async () => ({ canceled: false, filePaths: [chosen] });
    (dialog as unknown as { showOpenDialog: typeof fake }).showOpenDialog = fake;
  }, root);
  // S13.4: after a normal quit the project is already reopened; then the files panel offers "open other folder".
  const first = page.getByTestId('open-folder');
  await ((await first.count()) > 0 ? first : page.getByTestId('open-other-folder')).click();
  await expect(page.getByTestId('project-name')).toHaveText('中文 路径 项目');
  // S08.1 file tree: expand the folders on the way, then open the file.
  const segments = relPath.split('/');
  for (let i = 1; i < segments.length; i += 1) {
    const folder = page.getByTestId('file-tree').locator(`[data-path="${segments.slice(0, i).join('/')}"]`);
    if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click();
  }
  await page.getByTestId('file-tree').locator(`[data-path="${relPath}"]`).click();
  await expect(selectedTab()).toHaveText(segments[segments.length - 1] ?? relPath);
}

/** The visible editor tab (S09 tab bar), not the recovery dialog's own tabs. */
const selectedTab = () => page.getByTestId('tab-bar').locator('[role="tab"][aria-selected="true"] .tab-name');

/**
 * Autosave (S10.2) writes edits after a one-second pause. To leave unsaved edits behind for a crash, the file is made
 * read-only first: the autosave fails, the edits stay in the editor and in the journal — the situation recovery is
 * for. `writable` undoes it.
 */
const readOnly = (relPath: string) => chmod(path.join(root, ...relPath.split('/')), 0o444);
const writable = (relPath: string) => chmod(path.join(root, ...relPath.split('/')), 0o644);

/** Plain text on a new last line (no markup, so Monaco's auto-closing does not edit the buffer again). */
async function typeAtEnd(text: string) {
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press(DOC_END);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
}

const status = () => page.getByTestId('save-status');
const editorText = () => page.locator('.view-lines');

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(tempRoot(), 'noobide-e2e-recovery-'));
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  userData = path.join(tmp, '应用 数据');
  await mkdir(path.dirname(root), { recursive: true });
  await mkdir(userData, { recursive: true });
  await cp(path.join(repoRoot, 'tests', 'fixtures', '中文 路径 项目'), root, { recursive: true });
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  // Chromium helper processes can hold files in the app-data directory for a moment after the app exits.
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

test('a dirty buffer is journaled outside the project within 2 s and removed after saving (S12.1)', async () => {
  await start();
  await expect(page.getByTestId('recovery-dialog')).toHaveCount(0);
  await openProjectAndFile('index.html');
  const before = await projectTree(root);
  await readOnly('index.html');
  await typeAtEnd('日志测试');
  const typedAt = Date.now();
  await expect.poll(journalRecords, { timeout: 2000, intervals: [50] }).toHaveLength(1);
  expect(Date.now() - typedAt).toBeLessThanOrEqual(2000);
  expect(await projectTree(root)).toEqual(before); // nothing written into the project
  expect(await readFile(path.join(root, 'index.html'), 'utf8')).not.toContain('日志测试');
  await writable('index.html');
  await page.keyboard.press('ControlOrMeta+S');
  await expect(status()).toHaveText('已保存');
  await expect.poll(journalRecords, { timeout: 5000 }).toHaveLength(0);
  expect(await readFile(path.join(root, 'index.html'), 'utf8')).toContain('日志测试');
  // S21.2: the save also took local-history snapshots, in app data next to the journal (not in the project).
  // Stored right after the save returns (queued, not awaited by the save).
  await expect
    .poll(async () => (await readdir(path.join(userData, 'history', 'index')).catch(() => [])).length)
    .toBe(1);
  expect(await projectTree(root)).toEqual(before);
  await stop();
});

test('after a forced termination the relaunched app offers the edits with a diff and restores them (S12.2)', async () => {
  await start();
  await openProjectAndFile('子 文件夹/页面 二.html');
  const file = path.join(root, '子 文件夹', '页面 二.html');
  const onDisk = await readFile(file, 'utf8');
  await readOnly('子 文件夹/页面 二.html');
  await typeAtEnd('崩溃前没保存的一行');
  await expect.poll(journalRecords, { timeout: 2000, intervals: [50] }).toHaveLength(1);
  await kill();
  await writable('子 文件夹/页面 二.html');
  expect(await readFile(file, 'utf8')).toBe(onDisk);

  await start();
  const dialog = page.getByTestId('recovery-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('recovery-project')).toContainText('中文 路径 项目');
  await expect(dialog.getByTestId('recovery-project')).toContainText('子 文件夹/页面 二.html');
  await expect(dialog.getByTestId('recovery-usage')).toContainText('MB');

  await dialog.getByTestId('recovery-review').click();
  await expect(page.getByTestId('project-name')).toHaveText('中文 路径 项目');
  const diff = dialog.getByTestId('recovery-diff');
  await expect(diff.locator('[data-kind="added"]')).toContainText('崩溃前没保存的一行');
  await expect(diff).toContainText('新增 1 行');

  await dialog.getByTestId('recovery-restore').click();
  await expect(dialog).toHaveCount(0);
  await expect(selectedTab()).toHaveText('页面 二.html');
  await expect(editorText()).toContainText('崩溃前没保存的一行');
  await expect(status()).toHaveText('未保存'); // restored, not yet saved
  // A restored copy is never written on the user's behalf: not even autosave touches it until the user acts.
  await page.waitForTimeout(1500);
  await expect(status()).toHaveText('未保存');
  expect(await readFile(file, 'utf8')).toBe(onDisk);

  await page.keyboard.press('ControlOrMeta+S');
  await expect(status()).toHaveText('已保存');
  expect(await readFile(file, 'utf8')).toContain('崩溃前没保存的一行');
  await expect.poll(journalRecords, { timeout: 5000 }).toHaveLength(0);
  await stop();
});

test('restoring never saves a restored copy silently; each copy opens in its own tab (S12.2, S09)', async () => {
  await start();
  await openProjectAndFile('index.html');
  await readOnly('index.html');
  await typeAtEnd('第一份副本');
  await expect.poll(journalRecords, { timeout: 2000, intervals: [50] }).toHaveLength(1);
  await kill();
  await writable('index.html');
  await start();
  await page.getByTestId('recovery-later').click();
  await openProjectAndFile('script.js');
  await readOnly('script.js');
  await typeAtEnd('第二份副本');
  await expect.poll(journalRecords, { timeout: 2000, intervals: [50] }).toHaveLength(2);
  await kill();
  await writable('script.js');
  const indexOnDisk = await readFile(path.join(root, 'index.html'), 'utf8');
  const scriptOnDisk = await readFile(path.join(root, 'script.js'), 'utf8');
  await start();
  const dialog = page.getByTestId('recovery-dialog');
  await dialog.getByTestId('recovery-review').click();
  await expect(dialog.getByRole('tab')).toHaveCount(2);
  await dialog.getByRole('tab', { name: 'script.js' }).click();
  await expect(dialog.getByTestId('recovery-diff')).toContainText('第二份副本');
  await dialog.getByTestId('recovery-restore').click();
  await expect(selectedTab()).toHaveText('script.js');
  await expect(status()).toHaveText('未保存');
  // The other copy is still offered; restoring it opens a second tab and writes neither file.
  await expect(dialog.getByRole('tab')).toHaveCount(1);
  await expect(dialog.getByTestId('recovery-diff')).toContainText('第一份副本');
  await dialog.getByTestId('recovery-restore').click();
  await expect(dialog).toHaveCount(0);
  await expect(selectedTab()).toHaveText('index.html');
  await expect(editorText()).toContainText('第一份副本');
  await expect(status()).toHaveText('未保存');
  expect(await readFile(path.join(root, 'index.html'), 'utf8')).toBe(indexOnDisk);
  expect(await readFile(path.join(root, 'script.js'), 'utf8')).toBe(scriptOnDisk);
  await page.keyboard.press('ControlOrMeta+S');
  await expect(status()).toHaveText('已保存');
  expect(await readFile(path.join(root, 'index.html'), 'utf8')).toContain('第一份副本');
  await page.getByTestId('tab-bar').getByRole('tab', { name: 'script.js' }).click();
  await expect(status()).toHaveText('未保存');
  await page.keyboard.press('ControlOrMeta+S');
  await expect(status()).toHaveText('已保存');
  expect(await readFile(path.join(root, 'script.js'), 'utf8')).toContain('第二份副本');
  await expect.poll(journalRecords, { timeout: 5000 }).toHaveLength(0);
  await stop();
});

test('"decide later" keeps the copy; the clear-data control removes it (S12.3)', async () => {
  await start();
  await openProjectAndFile('style.css');
  await readOnly('style.css');
  await typeAtEnd('稍后处理');
  await expect.poll(journalRecords, { timeout: 2000, intervals: [50] }).toHaveLength(1);
  await kill();
  await writable('style.css');

  await start();
  await expect(page.getByTestId('recovery-dialog')).toBeVisible();
  await page.getByTestId('recovery-later').click();
  await expect(page.getByTestId('recovery-dialog')).toHaveCount(0);
  expect(await journalRecords()).toHaveLength(1);
  await kill();

  await start();
  const dialog = page.getByTestId('recovery-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('recovery-clear').click();
  await dialog.getByTestId('recovery-clear-confirm').click();
  await expect(dialog).toHaveCount(0);
  expect(await journalRecords()).toHaveLength(0);
  expect(await readFile(path.join(root, 'style.css'), 'utf8')).not.toContain('稍后处理');
  await stop();

  await start();
  await expect(page.getByTestId('recovery-dialog')).toHaveCount(0);
  await stop();
});

test('no console errors during the recovery run', async () => {
  expect(consoleErrors).toEqual([]);
});
