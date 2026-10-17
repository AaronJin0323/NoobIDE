import { chmod, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import {
  copyFixture,
  evalInPreview,
  openProject,
  previewInfo,
  replaceEditorText,
  waitForPreviewState,
  workbenchPid,
} from './preview-helpers';

/**
 * S04.2–S04.4 end to end: the multi-file fixture (CSS, classic script, ES module import, fetch of JSON, SVG and PNG
 * images, Chinese file names) is served by the loopback server and rendered in the sandboxed WebContentsView, which
 * follows the preview pane; saving a file refreshes the page.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  ({ tmp, root } = await copyFixture('预览 多文件'));
  app = await launchApp();
  page = await app.firstWindow();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.locator('.monaco-editor .view-lines').waitFor();
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('a project is not run until the user starts the preview (PLAN §8)', async () => {
  await expect(page.getByTestId('preview-start')).toHaveCount(0); // no project yet
  await openProject(app, page, root);
  await waitForPreviewState(page, 'stopped');
  expect((await previewInfo(app)).previewWebContentsId).toBeNull();
  await expect(page.getByTestId('preview-start')).toBeVisible();
});

test('the multi-file fixture loads with zero failed requests (S04.2)', async () => {
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
  await expect
    .poll(() => evalInPreview<string>(app, 'JSON.stringify(document.body.dataset)'))
    .toBe(JSON.stringify({ classic: 'ok', module: 'ok', data: 'ok' }));
  const loaded = await evalInPreview<{
    module: string;
    data: string;
    color: string;
    images: boolean[];
    resources: { name: string; status: number }[];
  }>(
    app,
    `({
      module: document.getElementById('module').textContent,
      data: document.getElementById('data').textContent,
      color: getComputedStyle(document.body).color,
      images: [...document.images].map((img) => img.complete && img.naturalWidth > 0),
      resources: performance.getEntriesByType('resource').map((e) => ({
        name: decodeURIComponent(new URL(e.name).pathname),
        status: e.responseStatus,
      })),
    })`,
  );
  expect(loaded.module).toBe('模块已加载');
  expect(loaded.data).toBe('数据已加载');
  expect(loaded.color).toBe('rgb(47, 93, 67)');
  expect(loaded.images).toEqual([true, true]);
  expect(loaded.resources.map((r) => r.name).sort()).toEqual([
    '/css/style.css',
    '/data/data.json',
    '/js/classic.js',
    '/js/main.js',
    '/js/util.mjs',
    '/图片/photo.png',
    '/图片/标志.svg',
  ]);
  expect(loaded.resources.every((r) => r.status === 200)).toBe(true);
  // No network or page-load record reached the preview console (the main process records every failure there).
  await page.waitForTimeout(500);
  await expect(page.getByTestId('preview-console').locator('[data-source="network"]')).toHaveCount(0);
  await expect(page.getByTestId('preview-console').locator('.level-error')).toHaveCount(0);
});

test('the preview view is sandboxed, has no preload or Node, uses a per-project partition (S04.3)', async () => {
  const info = await previewInfo(app);
  expect(info.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(info.partition).toMatch(/^persist:noobide-preview-[0-9a-f]{32}$/);
  expect(info.webPreferences).toMatchObject({
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
  });
  expect(info.webPreferences?.preload ?? null).toBeNull();
  // The view really uses the partition (not the workbench's default session).
  const sameSession = await app.evaluate(
    ({ session, webContents }, { id, partition }) => {
      const wc = webContents.fromId(id);
      return wc?.session === session.fromPartition(partition) && wc?.session !== session.defaultSession;
    },
    { id: info.previewWebContentsId ?? -1, partition: info.partition ?? '' },
  );
  expect(sameSession).toBe(true);
  const globals = await evalInPreview<Record<string, string>>(
    app,
    `({ require: typeof require, process: typeof process, noobide: typeof noobide, ipc: typeof ipcRenderer })`,
  );
  expect(globals).toEqual({ require: 'undefined', process: 'undefined', noobide: 'undefined', ipc: 'undefined' });
  expect(info.previewPid).not.toBe(await workbenchPid(app));
  // Ownership: only the preview session adds the per-server token. Any other client — here the test runner, like
  // another program on this machine or a browser tab — is refused even though it knows the port.
  const outsider = await fetch(`${info.origin}/index.html`);
  expect(outsider.status).toBe(403);
});

async function stageRect() {
  return page.getByTestId('preview-stage').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  });
}

async function expectViewOverStage() {
  await expect
    .poll(async () => {
      const [info, rect] = [await previewInfo(app), await stageRect()];
      const b = info.viewBounds;
      return (
        info.viewVisible === true &&
        b !== null &&
        Math.abs(b.x - rect.x) <= 1 &&
        Math.abs(b.y - rect.y) <= 1 &&
        Math.abs(b.width - rect.width) <= 1 &&
        Math.abs(b.height - rect.height) <= 1
      );
    })
    .toBe(true);
}

test('the view follows the preview pane when the window and the layout change (S04.3)', async () => {
  await expectViewOverStage();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1400, 900));
  await expectViewOverStage();
  await page.getByTestId('problems-toggle').click();
  await expectViewOverStage();
  await page.getByTestId('problems-toggle').click();
  await expectViewOverStage();
  // Narrow layout showing code: the preview pane is hidden, and so is the native view.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(700, 700));
  await expect(page.getByTestId('narrow-switch')).toBeVisible();
  await page.getByTestId('narrow-switch').getByRole('button').first().click();
  await expect.poll(async () => (await previewInfo(app)).viewVisible).toBe(false);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800));
  await expectViewOverStage();
});

test('window.open is denied and off-origin navigation is blocked (S04.3)', async () => {
  const windowsBefore = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length);
  const opened = await evalInPreview<boolean>(app, `window.open('https://example.com/') === null`);
  expect(opened).toBe(true);
  await evalInPreview(app, `window.open('${'file:///C:/Windows/win.ini'}'); 1`);
  const origin = (await previewInfo(app)).origin;
  await evalInPreview(app, `location.href = 'https://example.com/'; 1`);
  await page.waitForTimeout(500);
  await evalInPreview(app, `location.href = 'file:///C:/'; 1`);
  await page.waitForTimeout(500);
  const url = await evalInPreview<string>(app, 'location.href');
  expect(new URL(url).origin).toBe(origin);
  expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().length)).toBe(windowsBefore);
  // Explained in the user's language (not the English fallback), pointing at the “Open in browser” button.
  const blocked = page.getByTestId('preview-console').locator('.preview-console-line[data-notice="link-blocked"]');
  await expect.poll(() => blocked.count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('preview-console')).not.toContainText('navigation blocked');
  await expect(page.getByTestId('preview-console')).not.toContainText('window.open blocked');
});

test('edit → save → the preview shows the new heading (S04.4)', async () => {
  await page.getByTestId('file-tree').getByRole('treeitem', { name: 'index.html', exact: true }).click();
  await expect(page.getByTestId('tab-bar').getByRole('tab', { name: 'index.html' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const original = await readFile(path.join(root, 'index.html'), 'utf8');
  const changed = original.replace('<h1 id="title">多文件预览</h1>', '<h1 id="title">保存后的新标题</h1>');
  expect(changed).not.toBe(original);
  await replaceEditorText(app, page, changed);
  await expect(page.getByTestId('save-status')).toHaveText('未保存');
  const before = await evalInPreview<string>(app, `document.getElementById('title').textContent`);
  expect(before).toBe('多文件预览');
  const savedAt = Date.now();
  await page.keyboard.press('ControlOrMeta+S');
  await expect(page.getByTestId('save-status')).toHaveText('已保存');
  await expect
    .poll(() => evalInPreview<string>(app, `document.getElementById('title')?.textContent ?? ''`), { timeout: 5_000 })
    .toBe('保存后的新标题');
  const elapsed = Date.now() - savedAt;
  console.log(`save → preview updated: ${elapsed} ms`);
  await waitForPreviewState(page, 'running');
  expect(await readFile(path.join(root, 'index.html'), 'utf8')).toContain('保存后的新标题');
});

test('a failed save does not refresh the preview and shows "preview not updated" (S10.5)', async () => {
  const file = path.join(root, 'index.html');
  const onDisk = await readFile(file, 'utf8');
  const loadsBefore = await evalInPreview<number>(app, 'performance.timeOrigin');
  await chmod(file, 0o444);
  try {
    await replaceEditorText(app, page, onDisk.replace('保存后的新标题', '只读时的标题'));
    await page.keyboard.press('ControlOrMeta+S');
    await expect(page.getByTestId('save-status')).toHaveText('保存失败');
    const pill = page.getByTestId('preview-state');
    await expect(pill).toHaveAttribute('data-not-updated', 'true');
    await expect(pill).toContainText('预览未更新');
    // The page was not reloaded and still shows what is on disk.
    await page.waitForTimeout(1_000);
    expect(await evalInPreview<number>(app, 'performance.timeOrigin')).toBe(loadsBefore);
    expect(await evalInPreview<string>(app, `document.getElementById('title').textContent`)).toBe('保存后的新标题');
    expect(await readFile(file, 'utf8')).toBe(onDisk);
  } finally {
    await chmod(file, 0o644);
  }
  // Once the save succeeds, the preview refreshes and the warning disappears.
  await page.keyboard.press('ControlOrMeta+S');
  await expect(page.getByTestId('save-status')).toHaveText('已保存');
  await expect
    .poll(() => evalInPreview<string>(app, `document.getElementById('title')?.textContent ?? ''`), { timeout: 5_000 })
    .toBe('只读时的标题');
  await expect(page.getByTestId('preview-state')).not.toHaveAttribute('data-not-updated', 'true');
  await waitForPreviewState(page, 'running');
});

test('Stop destroys the view and shuts the server down; switching projects stops the preview', async () => {
  const { origin, status: running } = await previewInfo(app);
  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');
  const info = await previewInfo(app);
  expect(info.previewWebContentsId).toBeNull();
  expect(info.origin).toBeNull();
  const reachable = await fetch(`${origin}/`).then(
    () => true,
    () => false,
  );
  expect(reachable).toBe(false);

  // Stop while the server is still starting is not lost: no view appears afterwards.
  await page.evaluate(async (id) => {
    const preview = (
      window as unknown as { noobide: { preview: { start(r: object): Promise<unknown>; stop(): Promise<unknown> } } }
    ).noobide.preview;
    const starting = preview.start({ projectId: id });
    await preview.stop();
    await starting;
  }, running.projectId ?? '');
  await page.waitForTimeout(500);
  await waitForPreviewState(page, 'stopped');
  expect((await previewInfo(app)).previewWebContentsId).toBeNull();

  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
  const other = await copyFixture('中文 路径 项目');
  try {
    await openProject(app, page, other.root);
    await waitForPreviewState(page, 'stopped');
    expect((await previewInfo(app)).previewWebContentsId).toBeNull();
  } finally {
    await rm(other.tmp, { recursive: true, force: true });
  }
});

test('no workbench console errors during the preview run', async () => {
  expect(consoleErrors).toEqual([]);
});
