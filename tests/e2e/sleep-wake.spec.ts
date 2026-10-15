import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { collectConsoleErrors, documentText, makeProject, openFile, openProject, treeRow, typeAtEnd } from './project';
import { evalInPreview, previewInfo, waitForPreviewState } from './preview-helpers';

/**
 * S25.1/S25.2 (decision 0028): sleep/wake recovery driven through the real powerMonitor in main — the test emits
 * its `suspend` / `resume` events; the machine itself never sleeps. Faults a sleep can cause are injected from main:
 * the static server's socket dies, the page stops answering. Checks the tree, the preview and saving afterwards, on
 * a project path with Chinese characters and spaces. Real sleeps are owner checks (harness/MANUAL-CHECKS.md#S25.1).
 */
test.describe.configure({ mode: 'serial' });

interface WakeReport {
  trigger: string;
  watcher: string;
  server: string;
  page: string;
  at: number;
}

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const lastWake = () =>
  app.evaluate(() =>
    (
      globalThis as unknown as { __noobideTestHooks: { wake: { last(): WakeReport | null } } }
    ).__noobideTestHooks.wake.last(),
  );

/** Emits a sleep and a wake on Electron's powerMonitor, with `duringSleep` in between; returns the recovery report. */
async function sleepAndWake(duringSleep: () => Promise<unknown> = async () => undefined): Promise<WakeReport> {
  const before = (await lastWake())?.at ?? 0;
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
  await duringSleep();
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
  let report: WakeReport | null = null;
  await expect
    .poll(
      async () => {
        report = await lastWake();
        return report?.at ?? 0;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(before);
  return report as unknown as WakeReport;
}

const notice = () => page.locator('.preview-console-line[data-notice="restarted-after-sleep"]');

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-wake-'));
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

test('a healthy wake rescans the tree and leaves a working preview alone (no reload)', async () => {
  const info = await previewInfo(app);
  const report = await sleepAndWake(() => writeFile(path.join(root, '睡眠 期间.html'), '<p>z</p>\n'));
  expect(report).toMatchObject({ trigger: 'resume', watcher: 'rescanned', server: 'ok', page: 'ok' });
  await expect(treeRow(page, '睡眠 期间.html')).toBeVisible();
  const after = await previewInfo(app);
  expect(after.previewPid).toBe(info.previewPid);
  expect(after.status.generation).toBe(info.status.generation);
  expect(after.status.state).toBe('running');
  await expect(notice()).toHaveCount(0);
});

test('the server socket died during sleep: the preview restarts on the same port and says so', async () => {
  const before = await previewInfo(app);
  const report = await sleepAndWake(() =>
    app.evaluate(() =>
      (
        globalThis as unknown as { __noobideTestHooks: { wake: { killServerSocket(): Promise<boolean> } } }
      ).__noobideTestHooks.wake.killServerSocket(),
    ),
  );
  expect(report).toMatchObject({ server: 'restarted', page: 'restarted' });
  await waitForPreviewState(page, 'running');
  const after = await previewInfo(app);
  expect(after.origin).toBe(before.origin); // same port: the page keeps its origin and storage
  expect(await evalInPreview<string>(app, 'document.readyState')).toBe('complete');
  await expect(notice()).toHaveCount(1);
  await expect(notice()).toContainText('预览用的本地服务器已经停止');
  // Isolation is unchanged after the restart.
  expect(after.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
  expect(after.webPreferences?.preload ?? null).toBeFalsy();
});

test('a page that stops responding after the wake is restarted; unsaved edits survive and save', async () => {
  await openFile(page, 'index.html');
  await typeAtEnd(page, 'WAKE_EDIT');
  const before = await previewInfo(app);
  const report = await sleepAndWake(() =>
    // The page answered when the machine went to sleep and hangs afterwards.
    evalInPreview(app, 'setTimeout(() => { for (;;) {} }, 0); 1'),
  );
  expect(report).toMatchObject({ server: 'ok', page: 'restarted' });
  await waitForPreviewState(page, 'running');
  const after = await previewInfo(app);
  expect(after.previewPid).not.toBe(before.previewPid);
  await expect(notice().filter({ hasText: '醒来后网页没有响应' })).toHaveCount(1);

  // The editor buffer was never touched; autosave and Ctrl/Cmd+S still write it.
  expect(await documentText(page.locator('.monaco-editor'))).toContain('WAKE_EDIT');
  await typeAtEnd(page, 'AFTER_WAKE');
  await page.keyboard.press('ControlOrMeta+S');
  await expect
    .poll(() => readFile(path.join(root, 'index.html'), 'utf8'), { timeout: 10_000 })
    .toMatch(/WAKE_EDIT[\s\S]*AFTER_WAKE/);
  await expect(page.getByTestId('save-status')).toHaveText('已保存');
});

test('a page that was already hung before the sleep is left alone (Stop still works)', async () => {
  await evalInPreview(app, 'setTimeout(() => { for (;;) {} }, 0); 1');
  await waitForPreviewState(page, 'unresponsive');
  const pid = (await previewInfo(app)).previewPid;
  const report = await sleepAndWake();
  expect(report).toMatchObject({ server: 'ok', page: 'left-alone' });
  expect((await previewInfo(app)).previewPid).toBe(pid);
  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');
  expect(consoleErrors).toEqual([]);
});
