import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { previewEntryToProblem } from '../../src/preview/to-problem';
import type { PreviewLogEntry } from '../../src/shared/ipc/preview-contract';
import { launchApp } from './launch';
import {
  copyFixture,
  evalInPreview,
  openProject,
  previewInfo,
  processAlive,
  replaceEditorText,
  waitForPreviewState,
  workbenchPid,
} from './preview-helpers';

/**
 * S05.1–S05.5 end to end: hostile or broken pages cannot hurt the editor. An endless loop, a console flood, page
 * errors and a page that tries to read local files, each in its own project under a path with Chinese characters
 * and spaces.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
const temps: string[] = [];
const consoleErrors: string[] = [];
const editorText = () => page.locator('.view-lines');

async function project(fixture: string): Promise<string> {
  const { tmp, root } = await copyFixture(fixture);
  temps.push(tmp);
  return root;
}

async function openInEditor(name: string) {
  await page.getByTestId('file-tree').getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByTestId('tab-bar').getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
}

/** Clicks into the editor, types plain text on a new last line and returns how long until it was visible. */
async function typeAndMeasure(text: string): Promise<number> {
  const started = Date.now();
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(editorText()).toContainText(text);
  return Date.now() - started;
}

test.beforeAll(async () => {
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
  for (const tmp of temps) await rm(tmp, { recursive: true, force: true });
});

test('an endless loop runs in another process and does not block typing; Stop destroys and recreates the view (S05.1)', async () => {
  const root = await project('预览 死循环');
  await openProject(app, page, root);
  await openInEditor('index.html');
  await page.getByTestId('preview-start').click();
  // The watchdog notices the hung page within a few seconds.
  await waitForPreviewState(page, 'unresponsive');
  const hung = await previewInfo(app);
  const mainPid = await app.evaluate(() => process.pid);
  expect(hung.previewPid).not.toBeNull();
  expect(hung.previewPid).not.toBe(await workbenchPid(app));
  expect(hung.previewPid).not.toBe(mainPid);

  const typing = await typeAndMeasure('死循环时仍然可以输入');
  console.log(`typing while the preview is hung: ${typing} ms for 10 characters`);
  expect(typing).toBeLessThan(3_000);
  // The UI explains the state and offers Stop; the native view is hidden so the message is readable.
  await expect(page.getByTestId('preview-message')).toContainText('死循环');
  await expect(page.getByTestId('preview-stop')).toBeVisible();
  expect((await previewInfo(app)).viewVisible).toBe(false);

  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');
  expect((await previewInfo(app)).previewWebContentsId).toBeNull();
  // The hung renderer process is gone, not just hidden.
  await expect.poll(() => processAlive(hung.previewPid ?? -1), { timeout: 10_000 }).toBe(false);

  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'unresponsive');
  const again = await previewInfo(app);
  expect(again.previewWebContentsId).not.toBe(hung.previewWebContentsId);
  expect(again.previewPid).not.toBe(hung.previewPid);
  expect(await typeAndMeasure('第二次')).toBeLessThan(3_000);
});

test('unresponsive state: Stop recovers, and Chromium’s unresponsive event is handled (S05.2)', async () => {
  // Fix the code while the page is hung. A save does not try to reload a hung page; Stop + Start recovers.
  const fixed = '<!doctype html>\n<html lang="zh-CN">\n<body>\n<h1 id="ok">修好了</h1>\n</body>\n</html>\n';
  await replaceEditorText(app, page, fixed);
  await page.keyboard.press('ControlOrMeta+S');
  await expect(page.getByTestId('save-status')).toHaveText('已保存');
  await expect(page.getByTestId('preview-state')).toHaveAttribute('data-state', 'unresponsive');
  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
  expect(await evalInPreview<string>(app, `document.getElementById('ok').textContent`)).toBe('修好了');
  expect((await previewInfo(app)).viewVisible).toBe(true);

  // Chromium raises 'unresponsive' when the page does not answer input; the preview must react the same way.
  const id = (await previewInfo(app)).previewWebContentsId ?? -1;
  await app.evaluate(({ webContents }, wcId) => webContents.fromId(wcId)?.emit('unresponsive'), id);
  await waitForPreviewState(page, 'unresponsive');
  await expect(page.getByTestId('preview-stop')).toBeVisible();
  await expect(page.getByTestId('preview-state')).toContainText('网页没有响应');
  await app.evaluate(({ webContents }, wcId) => webContents.fromId(wcId)?.emit('responsive'), id);
  await waitForPreviewState(page, 'running');
});

test('a console flood keeps the log bounded and every keystroke lands (S05.3, main stall measured)', async () => {
  const root = await project('预览 日志洪水');
  await openProject(app, page, root);
  await openInEditor('index.html');
  // Playwright itself subscribes to every console message of every page, including the preview view, so its own
  // commands queue up behind the flood. Input therefore comes from main (sendInputEvent, like a real keyboard) and
  // the workbench records when each keystroke arrives and how late its timers run; both are read after the flood.
  await page.evaluate(() => {
    const probe = { inputs: [] as number[], maxTimerLag: 0 };
    (window as unknown as { __probe: typeof probe }).__probe = probe;
    // Monaco edits through an EditContext element, which reports typed text as 'beforeinput'.
    document.addEventListener('beforeinput', () => probe.inputs.push(Date.now()), true);
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      probe.maxTimerLag = Math.max(probe.maxTimerLag, now - last - 50);
      last = now;
    }, 50);
  });
  const box = await page.locator('.monaco-editor .view-lines').boundingBox();
  if (!box) throw new Error('editor not visible');
  // Near the left edge: .view-lines can be wider than the visible editor and reach under the preview.
  const point = { x: Math.round(box.x + 40), y: Math.round(box.y + 10) };

  await page.getByTestId('preview-start').click();
  const sent = await app.evaluate(async ({ BrowserWindow }, at) => {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!wc) return { sends: [] as number[], mainLag: 0 };
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await wait(500); // the page is flooding by now
    BrowserWindow.getAllWindows()[0]?.focus();
    wc.focus();
    wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await wait(100);
    const sends: number[] = [];
    let mainLag = 0;
    for (let i = 0; i < 20; i += 1) {
      const before = Date.now();
      await wait(150);
      mainLag = Math.max(mainLag, Date.now() - before - 150);
      sends.push(Date.now());
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Q' });
      wc.sendInputEvent({ type: 'char', keyCode: 'q' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Q' });
    }
    return { sends, mainLag };
  }, point);

  await expect
    .poll(() => evalInPreview<string>(app, 'document.body.dataset.count ?? ""'), { timeout: 30_000 })
    .not.toBe('');
  const logged = Number(await evalInPreview<string>(app, 'document.body.dataset.count'));
  const probe = await page.evaluate(
    () => (window as unknown as { __probe: { inputs: number[]; maxTimerLag: number } }).__probe,
  );
  const latencies = sent.sends.map((t, i) => (probe.inputs[i] ?? Number.POSITIVE_INFINITY) - t);
  console.log(
    `console flood: ${logged} messages in 6 s; keystroke latency ms ${JSON.stringify(latencies)}; ` +
      `workbench max timer lag ${Math.round(probe.maxTimerLag)} ms; main max timer lag ${sent.mainLag} ms`,
  );
  // All 20 keystrokes typed during the flood reached the editor, each quickly.
  expect(probe.inputs.length).toBe(20);
  await expect(editorText()).toContainText('q'.repeat(20));
  expect(Math.max(...latencies)).toBeLessThan(500);
  expect(probe.maxTimerLag).toBeLessThan(500);
  // KNOWN GAP (S05.3 stays blocked, follow-up S05.7): Electron builds a main-process event for every console
  // message, so ~100k messages/s still stall the main/UI thread for seconds even with the flood guard (8 s → 3–5 s
  // measured). Keystrokes are delayed, not lost. This bound only guards against regressions.
  expect(sent.mainLag).toBeLessThan(10_000);

  const dropped = page.getByTestId('preview-console-dropped');
  await expect(dropped).toBeVisible();
  const droppedCount = Number(/(\d+)/.exec((await dropped.textContent()) ?? '')?.[1] ?? 0);
  expect(droppedCount).toBeGreaterThan(0);
  const shown = await page.getByTestId('preview-console').locator('li').count();
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThanOrEqual(200);
  expect(shown + droppedCount).toBeLessThanOrEqual(logged);
  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');
});

interface RawRecord {
  source: string;
  level: string;
  message: string;
  url?: string;
  line?: number;
  status?: number;
}

test('uncaught exception, console error, 404 and module load failure produce raw records (S05.4)', async () => {
  const root = await project('预览 错误');
  await openProject(app, page, root);
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
  const records = async () => (await previewInfo(app)) as unknown as { recentRecords: RawRecord[] };
  const find = async (match: (r: RawRecord) => boolean) => (await records()).recentRecords.find(match);
  const fileOf = (r: RawRecord | undefined) => (r?.url ? decodeURIComponent(new URL(r.url).pathname) : null);

  await expect.poll(async () => (await records()).recentRecords.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(4);
  const all = (await records()).recentRecords;
  console.log(`raw records: ${JSON.stringify(all, null, 1)}`);

  const consoleError = await find((r) => r.source === 'console' && r.message.includes('自定义错误'));
  expect(consoleError).toMatchObject({ level: 'error', line: 1 });
  expect(fileOf(consoleError)).toBe('/js/errors.js');

  const exception = await find((r) => r.source === 'exception' && r.message.includes('userNmae'));
  expect(exception).toMatchObject({ level: 'error', line: 3 });
  expect(exception?.message).toMatch(/^Uncaught ReferenceError/);
  expect(fileOf(exception)).toBe('/js/errors.js');

  const image404 = await find((r) => r.source === 'network' && r.status === 404 && /missing\.png$/.test(r.url ?? ''));
  expect(fileOf(image404)).toBe('/images/missing.png');

  const module404 = await find((r) => r.source === 'network' && /missing-module\.js$/.test(r.url ?? ''));
  expect(module404).toMatchObject({ status: 404, level: 'error' });
  expect(module404?.message).toContain('script');

  // The raw records map onto the shared diagnostics model (src/shared/problem.ts) with project paths.
  const info = await previewInfo(app);
  const problems = (all as unknown as PreviewLogEntry[])
    .map((r) =>
      previewEntryToProblem(r, {
        projectId: info.status.projectId ?? '',
        preview: { sessionId: 'e2e', generation: 0 },
        previewOrigin: info.origin ?? '',
      }),
    )
    .filter((p) => p !== null);
  expect(problems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: 'runtime', code: 'ReferenceError', file: 'js/errors.js', line: 3 }),
      expect.objectContaining({ source: 'console', file: 'js/errors.js', line: 1 }),
      expect.objectContaining({
        source: 'resource',
        resource: expect.objectContaining({ requestedPath: 'images/missing.png', status: 404 }),
      }),
      expect.objectContaining({
        source: 'resource',
        resource: expect.objectContaining({ requestedPath: 'js/missing-module.js', resourceType: 'script' }),
      }),
    ]),
  );

  // The same records reach the preview console in the workbench.
  const consoleList = page.getByTestId('preview-console');
  await expect(consoleList).toContainText('自定义错误');
  await expect(consoleList).toContainText('userNmae');
  await expect(consoleList).toContainText('missing.png');
  await expect(consoleList).toContainText('missing-module.js');
});

test('records keep arriving while DevTools is open on the preview (S05.4 coexistence)', async () => {
  const id = (await previewInfo(app)).previewWebContentsId ?? -1;
  await app.evaluate(({ webContents }, wcId) => webContents.fromId(wcId)?.openDevTools({ mode: 'detach' }), id);
  await expect
    .poll(() => app.evaluate(({ webContents }, wcId) => webContents.fromId(wcId)?.isDevToolsOpened(), id))
    .toBe(true);
  await evalInPreview(app, `console.error('DevTools 打开时的错误'); 1`);
  await expect(page.getByTestId('preview-console')).toContainText('DevTools 打开时的错误');
  await app.evaluate(({ webContents }, wcId) => webContents.fromId(wcId)?.closeDevTools(), id);
  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');
});

test('a malicious page cannot read local files, other loopback services or the IDE (S05.5)', async () => {
  const root = await project('预览 恶意');
  const outside = path.dirname(path.dirname(root)); // the temp folder that holds 网页 练习/
  const secret = path.join(outside, 'secret.txt');
  await writeFile(secret, 'TOP SECRET');
  let junction = true;
  await symlink(outside, path.join(root, 'jump'), 'junction').catch(() => {
    junction = false;
  });

  let otherHits = 0;
  const other: Server = createServer((_req, res) => {
    otherHits += 1;
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' });
    res.end('OTHER LOCAL SERVICE');
  });
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  const otherPort = (other.address() as AddressInfo).port;
  await writeFile(
    path.join(root, 'config.json'),
    JSON.stringify({ secretFileUrl: pathToFileURL(secret).href, otherPortUrl: `http://127.0.0.1:${otherPort}/` }),
  );

  try {
    await openProject(app, page, root);
    await page.getByTestId('preview-start').click();
    await waitForPreviewState(page, 'running');
    await expect
      .poll(() => evalInPreview<string>(app, 'document.body.dataset.results ?? ""'), { timeout: 15_000 })
      .not.toBe('');
    const results = JSON.parse(await evalInPreview<string>(app, 'document.body.dataset.results')) as Record<
      string,
      string
    >;
    console.log(`attack results: ${JSON.stringify(results)}`);
    expect(Object.keys(results).sort()).toEqual(
      [
        'file-fetch',
        'file-xhr',
        'traversal',
        'encoded-traversal',
        'double-encoded-traversal',
        'encoded-backslash',
        'symlink-escape',
        'dotfile',
        'other-loopback-port',
        'other-loopback-port-no-cors',
        'localhost-alias',
        'ipv6-loopback',
        'websocket-other-port',
        'ide-bridge',
      ].sort(),
    );
    for (const [name, outcome] of Object.entries(results)) expect(outcome, name).toBe('failed');
    expect(junction).toBe(true); // the symlink-escape attempt really had a link to follow
    expect(otherHits).toBe(0);
    // file: never even reaches the network layer (Chromium refuses it in the renderer); the loopback attempts are
    // stopped by the preview session's request policy before any byte is sent.
    const blocked = (await previewInfo(app)).blockedRequests;
    expect(blocked.some((b) => b.host === `127.0.0.1:${otherPort}`)).toBe(true);
    expect(blocked.some((b) => b.host.startsWith('localhost:'))).toBe(true);
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }
});

test('no workbench console errors during the isolation run', async () => {
  expect(consoleErrors).toEqual([]);
});
