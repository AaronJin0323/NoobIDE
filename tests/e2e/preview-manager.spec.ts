import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, tempRoot } from './launch';
import { DOC_END } from './keys';
import { focusEditor, treeRow, projectMenu } from './project';
import { evalInPreview, openProject, previewInfo, waitForPreviewState } from './preview-helpers';

/**
 * S14 preview manager and S15.4 preview toolbar end to end, on project paths with Chinese characters and spaces:
 * start-preview consent and trust (S14.4), one server per project with an ownership check (S14.6), refresh
 * generations (S14.1), automatic refresh after a save and a typing pause vs manual refresh (S14.2), the entry page
 * picker (S14.3), per-project storage and "Clear preview data" (S14.5), and the toolbar's commands, "Open in
 * browser" and developer tools (S15.4).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let rootA: string;
let rootB: string;
const consoleErrors: string[] = [];

const INDEX = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>首页</title></head>
<body>
<h1 id="title">首页</h1>
<script src="app.js"></script>
</body>
</html>
`;
const APP_JS = "document.body.dataset.stored = localStorage.getItem('k') ?? 'none';\n";

async function makeSite(name: string): Promise<string> {
  const root = path.join(tmp, '网页 练习', name);
  await mkdir(path.join(root, '子 页面'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), INDEX);
  await writeFile(path.join(root, 'app.js'), APP_JS);
  await writeFile(path.join(root, 'about.html'), '<!doctype html><meta charset="utf-8"><h1 id="title">关于</h1>\n');
  await writeFile(path.join(root, '子 页面', '联系 我们.html'), '<!doctype html><meta charset="utf-8"><h1>联系</h1>\n');
  return root;
}

const pill = () => page.getByTestId('preview-state');
const generation = async () => Number(await pill().getAttribute('data-generation'));
const projectId = async () => (await previewInfo(app)).status.projectId ?? '';
const timeOrigin = () => evalInPreview<number>(app, 'performance.timeOrigin');
const serverProjects = () =>
  app.evaluate(
    () =>
      (
        globalThis as unknown as { __noobideTestHooks: { preview(): { serverProjects: string[] } } }
      ).__noobideTestHooks.preview().serverProjects,
  );
const reachable = (origin: string) =>
  fetch(`${origin}/`).then(
    () => true,
    () => false,
  );

async function closeProject(): Promise<void> {
  await projectMenu(page, 'close-project');
  await expect(page.getByTestId('welcome')).toBeVisible();
}

async function bridgeCall<T>(method: string, arg?: unknown): Promise<T> {
  return page.evaluate(
    async ({ method: m, arg: a }) => {
      const preview = (window as unknown as { noobide: { preview: Record<string, (x?: unknown) => Promise<unknown>> } })
        .noobide.preview;
      return (a === undefined ? preview[m]?.() : preview[m]?.(a)) as unknown;
    },
    { method, arg },
  ) as Promise<T>;
}

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(tempRoot(), 'noobide-pm-e2e-'));
  rootA = await makeSite('项目 甲');
  rootB = await makeSite('项目 乙');
  app = await launchApp();
  page = await app.firstWindow();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.locator('.monaco-editor .view-lines').waitFor();
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

test('an opened folder asks for "Start preview" once; the choice is kept in app data (S14.4)', async () => {
  const before = (await readdir(rootA)).sort();
  await openProject(app, page, rootA);
  await expect(page.getByTestId('preview-consent')).toBeVisible();
  await expect(page.getByTestId('preview-consent')).toContainText('只有在你点“开始预览”之后才会运行');
  await waitForPreviewState(page, 'stopped');
  expect((await previewInfo(app)).previewWebContentsId).toBeNull();
  expect(await serverProjects()).toEqual([]);

  await page.getByTestId('preview-consent-start').click();
  await waitForPreviewState(page, 'running');
  await expect(page.getByTestId('preview-consent')).toHaveCount(0);
  await expect.poll(() => evalInPreview<string>(app, 'document.body.dataset.stored ?? ""')).toBe('none');

  // Trust lives in app data, as a hash: no folder name, nothing written into the project.
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  const stored = await readFile(path.join(userData, 'preview.json'), 'utf8');
  expect(JSON.parse(stored).trusted).toHaveLength(1);
  expect(stored).not.toContain('项目 甲');
  expect((await readdir(rootA)).sort()).toEqual(before);

  // Reopened later, the folder previews by itself.
  await closeProject();
  await openProject(app, page, rootA);
  await waitForPreviewState(page, 'running');
  await expect(page.getByTestId('preview-consent')).toHaveCount(0);
});

test('one server per open project, shut down on switch and close; ownership is checked (S14.6)', async () => {
  const idA = await projectId();
  const { origin } = await previewInfo(app);
  expect(origin).not.toBeNull();
  expect(await serverProjects()).toEqual([idA]);
  // Starting again does not add a second server.
  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');
  expect(await serverProjects()).toEqual([]);
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
  expect(await serverProjects()).toEqual([idA]);

  // Ownership: a request naming another project is refused and changes nothing.
  const other = '00000000-0000-4000-8000-000000000000';
  expect(await bridgeCall('stop', { projectId: other })).toMatchObject({ ok: false, code: 'not-owner' });
  expect(await bridgeCall('reload', { projectId: other })).toMatchObject({ ok: false, code: 'not-owner' });
  await waitForPreviewState(page, 'running');
  expect(await serverProjects()).toEqual([idA]);

  // Switching to another project shuts A's server down; B (never started) asks for consent.
  const originA = (await previewInfo(app)).origin ?? '';
  await openProject(app, page, rootB);
  await expect(page.getByTestId('preview-consent')).toBeVisible();
  expect(await serverProjects()).toEqual([]);
  expect(await reachable(originA)).toBe(false);
  await page.getByTestId('preview-consent-start').click();
  await waitForPreviewState(page, 'running');
  const idB = await projectId();
  expect(await serverProjects()).toEqual([idB]);

  // Closing the project shuts its server down.
  const originB = (await previewInfo(app)).origin ?? '';
  await closeProject();
  await waitForPreviewState(page, 'stopped');
  expect(await serverProjects()).toEqual([]);
  expect(await reachable(originB)).toBe(false);

  await openProject(app, page, rootA);
  await waitForPreviewState(page, 'running');
});

test('Refresh (button and ⌘R/Ctrl+R command) starts a new page-load generation; the reload note shows once (S14.1, S15.4)', async () => {
  const g0 = await generation();
  expect(g0).toBeGreaterThan(0);
  await page.getByTestId('preview-reload').click();
  await expect.poll(generation).toBe(g0 + 1);
  await waitForPreviewState(page, 'running');
  expect((await previewInfo(app)).status.generation).toBe(g0 + 1);
  // The first refresh explains once that reloading clears the page's state.
  const note = page.getByTestId('preview-notice-reload-note');
  await expect(note).toContainText('刷新会重新加载页面');
  await note.getByRole('button').click();
  await expect(note).toHaveCount(0);

  // The registry command (shortcut) does the same; the note does not come back.
  await page.getByTestId('region-preview').locator('.panel-header .region-title').click(); // the title, not a header button
  await page.keyboard.press('ControlOrMeta+R');
  await expect.poll(generation).toBe(g0 + 2);
  await waitForPreviewState(page, 'running');
  await expect(note).toHaveCount(0);

  // The native View menu offers the preview commands.
  const labels = await app.evaluate(({ Menu }) => {
    const out: string[] = [];
    const walk = (menu: Electron.Menu | null) => {
      for (const item of menu?.items ?? []) {
        out.push(item.label);
        walk(item.submenu ?? null);
      }
    };
    walk(Menu.getApplicationMenu());
    return out;
  });
  expect(labels).toEqual(expect.arrayContaining(['刷新预览', '停止预览', '在浏览器中打开预览']));
});

test('automatic refresh waits for a typing pause; manual mode only marks the page as outdated (S14.2)', async () => {
  await treeRow(page, 'index.html').click();
  await focusEditor(page);
  await page.keyboard.press(DOC_END);
  const loaded = await timeOrigin();
  // Save while still typing: no reload until the typing stops.
  await page.keyboard.type('a');
  await page.keyboard.press('ControlOrMeta+S');
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.type('b');
    await page.waitForTimeout(100);
  }
  expect(await timeOrigin()).toBe(loaded);
  await expect.poll(timeOrigin, { timeout: 5_000 }).not.toBe(loaded);
  await page.keyboard.press('ControlOrMeta+S');
  await waitForPreviewState(page, 'running');

  // Manual mode: stored in .noobide/project.json; a save does not reload, the pill says so in words.
  const auto = page.getByTestId('preview-auto-refresh');
  await expect(auto).toBeChecked();
  await auto.uncheck();
  await expect
    .poll(async () => readFile(path.join(rootA, '.noobide', 'project.json'), 'utf8').then(JSON.parse, () => null))
    .toEqual({ version: 1, preview: { autoRefresh: false } });
  const before = await timeOrigin();
  await focusEditor(page);
  await page.keyboard.press(DOC_END);
  await page.keyboard.type('c');
  await page.keyboard.press('ControlOrMeta+S');
  await expect(pill()).toHaveAttribute('data-outdated', 'true');
  await expect(pill()).toContainText('有未显示的保存');
  await page.waitForTimeout(1_000);
  expect(await timeOrigin()).toBe(before);
  await page.getByTestId('preview-reload').click();
  await expect.poll(timeOrigin).not.toBe(before);
  await waitForPreviewState(page, 'running');
  await expect(pill()).not.toHaveAttribute('data-outdated', 'true');

  // Back to automatic: the key is removed again (automatic is the default).
  await auto.check();
  await expect
    .poll(async () => readFile(path.join(rootA, '.noobide', 'project.json'), 'utf8').then(JSON.parse))
    .toEqual({ version: 1 });
});

test('the entry picker lists the pages, defaults to index.html and stores the choice in project.json (S14.3)', async () => {
  const picker = page.getByTestId('preview-entry');
  await expect(picker).toHaveValue('index.html');
  const values = await picker
    .locator('option')
    .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));
  expect(values).toEqual(['index.html', 'about.html', '子 页面/联系 我们.html']);

  await picker.selectOption('子 页面/联系 我们.html');
  await expect
    .poll(async () => JSON.parse(await readFile(path.join(rootA, '.noobide', 'project.json'), 'utf8')))
    .toEqual({ version: 1, entry: '子 页面/联系 我们.html' });
  await expect
    .poll(async () => decodeURIComponent(new URL((await previewInfo(app)).status.url ?? 'http://x/').pathname))
    .toBe('/子 页面/联系 我们.html');
  await waitForPreviewState(page, 'running');

  await picker.selectOption('index.html');
  await expect
    .poll(async () => JSON.parse(await readFile(path.join(rootA, '.noobide', 'project.json'), 'utf8')))
    .toEqual({ version: 1 });
  await expect.poll(async () => new URL((await previewInfo(app)).status.url ?? 'http://x/x').pathname).toBe('/');
  await waitForPreviewState(page, 'running');
});

test('each project has its own preview storage; "Clear preview data" clears only this project’s (S14.5)', async () => {
  const partitionA = (await previewInfo(app)).partition;
  await evalInPreview(app, "localStorage.setItem('k', 'from-A')");
  await page.getByTestId('preview-reload').click();
  await expect.poll(() => evalInPreview<string>(app, 'document.body.dataset.stored ?? ""')).toBe('from-A');

  // Project B: another partition, its own value.
  await openProject(app, page, rootB);
  await waitForPreviewState(page, 'running'); // trusted in the S14.6 test
  const partitionB = (await previewInfo(app)).partition;
  expect(partitionB).not.toBe(partitionA);
  await expect.poll(() => evalInPreview<string>(app, 'document.body.dataset.stored ?? ""')).toBe('none');
  await evalInPreview(app, "localStorage.setItem('k', 'from-B')");

  // Back to A: clear its data from the Advanced panel, which explains the external browser's separate storage.
  await openProject(app, page, rootA);
  await waitForPreviewState(page, 'running');
  await expect.poll(() => evalInPreview<string>(app, 'document.body.dataset.stored ?? ""')).toBe('from-A');
  await page.getByTestId('preview-advanced').click();
  const panel = page.getByTestId('preview-advanced-panel');
  await expect(panel).toContainText('外部浏览器的数据是分开保存的');
  const loaded = await timeOrigin();
  await panel.getByTestId('preview-clear-data').click();
  await expect(page.getByTestId('preview-notice-clear')).toContainText('预览数据已清除');
  await expect.poll(timeOrigin).not.toBe(loaded);
  await expect.poll(() => evalInPreview<string>(app, 'document.body.dataset.stored ?? ""')).toBe('none');

  // B's storage is untouched.
  await openProject(app, page, rootB);
  await waitForPreviewState(page, 'running');
  await expect.poll(() => evalInPreview<string>(app, 'document.body.dataset.stored ?? ""')).toBe('from-B');
  await openProject(app, page, rootA);
  await waitForPreviewState(page, 'running');
});

test('"Open in browser" hands the OS a one-time grant URL and explains the separate storage (S15.4)', async () => {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { __opened: string[] }).__opened = opened;
    (shell as unknown as { openExternal: (url: string) => Promise<void> }).openExternal = async (url) => {
      opened.push(url);
    };
  });
  await page.getByTestId('preview-open-external').click();
  await expect(page.getByTestId('preview-notice-external')).toContainText('浏览器有自己的存储');
  const opened = await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
  expect(opened).toHaveLength(1);
  const url = opened[0] ?? '';
  const { origin } = await previewInfo(app);
  expect(url.startsWith(`${origin}/.noobide-grant/`)).toBe(true);

  // Without the grant the port gives nothing; the grant works once and its cookie opens the page.
  expect((await fetch(`${origin}/`)).status).toBe(403);
  const redeemed = await fetch(url, { redirect: 'manual' });
  expect(redeemed.status).toBe(302);
  expect(redeemed.headers.get('location')).toBe('/');
  const cookie = (redeemed.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const pageRes = await fetch(`${origin}/`, { headers: { cookie } });
  expect(pageRes.status).toBe(200);
  expect(await pageRes.text()).toContain('首页');
  expect((await fetch(url, { redirect: 'manual' })).status).toBe(403);
});

test('developer tools open from the Advanced panel (S15.4)', async () => {
  const advanced = page.getByTestId('preview-advanced');
  if ((await advanced.getAttribute('aria-expanded')) !== 'true') await advanced.click();
  await expect(page.getByTestId('preview-advanced-panel')).toContainText('Chromium');
  await page.getByTestId('preview-devtools').click();
  const { previewWebContentsId } = await previewInfo(app);
  await expect
    .poll(() =>
      app.evaluate(
        ({ webContents }, id) => webContents.fromId(id ?? -1)?.isDevToolsOpened() ?? false,
        previewWebContentsId,
      ),
    )
    .toBe(true);
  await app.evaluate(({ webContents }, id) => webContents.fromId(id ?? -1)?.closeDevTools(), previewWebContentsId);
  await waitForPreviewState(page, 'running');
});

test('no workbench console errors during the preview manager run', () => {
  expect(consoleErrors).toEqual([]);
});
