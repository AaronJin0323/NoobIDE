import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { electronArgs, repoRoot } from './launch';
import { collectConsoleErrors, openFile, switchLanguage } from './project';
import { evalInPreview, replaceEditorText, waitForPreviewState } from './preview-helpers';

/**
 * S27.2 offline acceptance (PLAN §11 "Offline use"): with the network disabled, a beginner can create a project from
 * a built-in template, edit and save it, see it in the preview, and get error explanations.
 *
 * "Network disabled" is enforced on every layer the app could use, while loopback stays reachable (the preview's
 * static server is on 127.0.0.1 — that is the machine itself, not the network):
 * - Chromium (workbench and preview renderers, every session): all traffic goes to a proxy on a closed loopback port
 *   (loopback is bypassed, as by default) and every DNS name except localhost resolves to "not found".
 * - The workbench session additionally runs with Chromium's offline network emulation.
 * - Node in the main process: tests/e2e/offline-guard.cjs (preloaded with `-r`) makes TCP connections and DNS lookups to any non-loopback
 *   host fail, and records them.
 * The test first proves the cut works (a page fetch and a main-process fetch to the internet both fail), and at the
 * end that the app itself tried to reach nothing outside the machine.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let documents: string;
let consoleErrors: string[];
let project: string;

const OFFLINE_SWITCHES = [
  '--proxy-server=http://127.0.0.1:9',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
];
const nodeAttempts = () =>
  app.evaluate(() => [...((globalThis as { __noobideOfflineAttempts?: string[] }).__noobideOfflineAttempts ?? [])]);
const workbenchBlocked = () =>
  app.evaluate(
    () =>
      (globalThis as unknown as { __noobideTestHooks: { blockedRequests: unknown[] } }).__noobideTestHooks
        .blockedRequests.length,
  );

test.beforeAll(async () => {
  // realpath: on macOS the temp folder is a symlink (/var → /private/var) and the app shows real paths.
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-offline-')));
  documents = path.join(tmp, '我的 文档');
  await mkdir(documents);
  const userDataDir = path.join(tmp, 'userdata');
  await mkdir(userDataDir);
  const guard = path.join(repoRoot, 'tests', 'e2e', 'offline-guard.cjs');
  app = await electron.launch({
    // `-r` preloads the guard into main before the app's code (Playwright passes its own loader the same way;
    // NODE_OPTIONS is removed by Playwright).
    args: ['-r', guard, `--user-data-dir=${userDataDir}`, ...OFFLINE_SWITCHES, ...electronArgs()],
    cwd: repoRoot,
  });
  await app.evaluate(({ session }) => session.defaultSession.enableNetworkEmulation({ offline: true }));
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await app.evaluate(({ app: electronApp }, docs) => electronApp.setPath('documents', docs), documents);
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('the network is really off: Node in main and Chromium both fail to reach the internet', async () => {
  const internet = await app.evaluate(async ({ session }) => {
    const attempt = (f: () => Promise<unknown>) =>
      f().then(
        () => 'reached',
        () => 'failed',
      );
    return {
      node: await attempt(() => fetch('https://example.com/')),
      // A fresh Chromium session without any of the app's request guards: only the cut can stop it.
      chromium: await attempt(() => session.fromPartition('offline-probe').fetch('https://example.com/')),
    };
  });
  expect(internet).toEqual({ node: 'failed', chromium: 'failed' });
  expect(await nodeAttempts()).toEqual(['example.com']);
});

test('templates: a project is created from the default built-in template and its preview runs', async () => {
  await page.getByTestId('welcome-create').click();
  // The default template and the default location (<Documents>/NoobIDE 项目/<name>).
  await expect(page.getByTestId('wizard-folder')).toContainText(documents);
  project = (await page.getByTestId('wizard-folder').textContent()) ?? '';
  expect(project.startsWith(documents)).toBe(true);
  await page.getByTestId('wizard-create').click();
  await expect(page.getByTestId('create-wizard')).toHaveCount(0);
  await expect(page.getByTestId('project-name')).toHaveAttribute('title', project);
  for (const rel of ['index.html', 'style.css', 'script.js', 'images/avatar.svg']) {
    await expect(readFile(path.join(project, ...rel.split('/')))).resolves.toBeTruthy();
  }
  await expect(
    page.locator('[data-testid="tab"][data-path="index.html"] [role="tab"][aria-selected="true"]'),
  ).toBeVisible();
  // Built-in templates are trusted: the preview starts by itself.
  await waitForPreviewState(page, 'running');
  await expect
    .poll(() => evalInPreview<string>(app, `document.querySelector('h1')?.textContent ?? ''`))
    .toBe('你好，我是小雨');
  // Local CSS and image loaded from the loopback server despite the cut.
  const loaded = await evalInPreview<{ avatar: boolean; styled: boolean }>(
    app,
    `({ avatar: document.querySelector('img.avatar').complete && document.querySelector('img.avatar').naturalWidth > 0,
        styled: getComputedStyle(document.querySelector('main.card')).display !== 'inline' })`,
  );
  expect(loaded).toEqual({ avatar: true, styled: true });
});

test('a webpage fetch to the internet fails in the preview (the cut also covers renderers)', async () => {
  const outcome = await evalInPreview<string>(
    app,
    `fetch('https://example.com/', { cache: 'no-store' }).then(() => 'reached', () => 'failed')`,
  );
  expect(outcome).toBe('failed');
  // The preview's own request policy allows external URLs (PLAN §8), so the failure is the network cut.
  const blocked = await app.evaluate(
    () =>
      (
        globalThis as unknown as { __noobideTestHooks: { preview(): { blockedRequests: { host: string }[] } } }
      ).__noobideTestHooks.preview().blockedRequests,
  );
  expect(blocked.map((r) => r.host)).not.toContain('example.com');
});

test('editing and preview: an edit is saved to disk and the preview shows it', async () => {
  const file = path.join(project, 'index.html');
  const original = await readFile(file, 'utf8');
  const changed = original.replace('<h1>你好，我是小雨</h1>', '<h1>离线也能做网页</h1>');
  expect(changed).not.toBe(original);
  await replaceEditorText(app, page, changed);
  await expect(page.getByTestId('save-status')).toHaveText('未保存');
  await page.keyboard.press('ControlOrMeta+S');
  await expect(page.getByTestId('save-status')).toHaveText('已保存');
  expect(await readFile(file, 'utf8')).toContain('<h1>离线也能做网页</h1>');
  await expect
    .poll(() => evalInPreview<string>(app, `document.querySelector('h1')?.textContent ?? ''`))
    .toBe('离线也能做网页');
});

test('explanations: a typo is explained as a code-check problem and as a runtime problem', async () => {
  await openFile(page, 'script.js');
  const file = path.join(project, 'script.js');
  const original = await readFile(file, 'utf8');
  await replaceEditorText(app, page, `${original}console.log(userNmae);\n`);
  await page.keyboard.press('ControlOrMeta+S');
  await expect(page.getByTestId('save-status')).toHaveText('已保存');

  const toggle = page.getByTestId('problems-toggle');
  await expect(toggle).toContainText('2 个错误', { timeout: 30_000 });
  await toggle.click();
  const staticRow = page.locator('[data-section="static"]').getByTestId('problem-row');
  const runtimeRow = page.locator('[data-section="runtime"]').getByTestId('problem-row');
  await expect(staticRow).toContainText('找不到变量 userNmae。');
  await expect(runtimeRow).toContainText('找不到变量 userNmae。');
  await expect(runtimeRow).toHaveAttribute('data-code', 'ReferenceError');

  await runtimeRow.getByTestId('problem-summary').click();
  const card = runtimeRow.getByTestId('problem-card');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-rule', /.+/);
  await card.getByTestId('problem-show-original').click();
  await expect(card.getByTestId('problem-original-message')).toHaveText(
    'Uncaught ReferenceError: userNmae is not defined',
  );
  await card.getByTestId('problem-go-to').click();
  await expect(page.getByTestId('cursor-position')).toHaveText(/^行 \d+, 列 \d+$/);

  // English explanations are bundled too.
  await switchLanguage(page);
  await expect(page.locator('[data-section="runtime"]')).toContainText('While the page runs');
  await switchLanguage(page);
});

test('the app itself tried to reach nothing outside this machine', async () => {
  // Only the deliberate probe of the first test reached the main-process guard; the workbench guard refused nothing.
  expect(await nodeAttempts()).toEqual(['example.com']);
  expect(await workbenchBlocked()).toBe(0);
  expect(consoleErrors).toEqual([]);
});
