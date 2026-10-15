import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
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
import { DOC_END } from './keys';

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
  await page.keyboard.press(DOC_END);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(editorText()).toContainText(text);
  return Date.now() - started;
}

test.beforeAll(async () => {
  // rebind.test stands for a public DNS name that resolves to loopback (localtest.me, *.nip.io, DNS rebinding):
  // Chromium's resolver — the one the preview's network proxy asks — maps it to 127.0.0.1 for this run.
  app = await launchApp({}, { args: ['--host-resolver-rules=MAP rebind.test 127.0.0.1'] });
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

test('a console flood keeps the log bounded, every keystroke lands and main never stalls (S05.3, S05.7)', async () => {
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

  // S05.7: the main (browser UI) thread's longest stall over the whole flood, from a 10 ms timer in main.
  await app.evaluate(() => {
    const lag = { max: 0, timer: undefined as ReturnType<typeof setInterval> | undefined };
    (globalThis as unknown as { __mainLag: typeof lag }).__mainLag = lag;
    let last = performance.now();
    lag.timer = setInterval(() => {
      const now = performance.now();
      lag.max = Math.max(lag.max, now - last - 10);
      last = now;
    }, 10);
  });
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
  const mainStall = await app.evaluate(() => {
    const lag = (globalThis as unknown as { __mainLag: { max: number; timer: ReturnType<typeof setInterval> } })
      .__mainLag;
    clearInterval(lag.timer);
    return Math.round(lag.max);
  });
  const probe = await page.evaluate(
    () => (window as unknown as { __probe: { inputs: number[]; maxTimerLag: number } }).__probe,
  );
  const latencies = sent.sends.map((t, i) => (probe.inputs[i] ?? Number.POSITIVE_INFINITY) - t);
  console.log(
    `console flood: ${logged} messages in 6 s; keystroke latency ms ${JSON.stringify(latencies)}; ` +
      `workbench max timer lag ${Math.round(probe.maxTimerLag)} ms; main max timer lag ${sent.mainLag} ms; ` +
      `longest main-thread stall during the flood ${mainStall} ms`,
  );
  // All 20 keystrokes typed during the flood reached the editor, each quickly.
  expect(probe.inputs.length).toBe(20);
  await expect(editorText()).toContainText('q'.repeat(20));
  expect(Math.max(...latencies)).toBeLessThan(500);
  expect(probe.maxTimerLag).toBeLessThan(500);
  // S05.7: the in-page rate limit (decision 0016) keeps the messages that reach main far below what stalls it.
  expect(mainStall).toBeLessThan(200);
  expect(sent.mainLag).toBeLessThan(200);
  // Messages below the limit keep the page's own file and line (the limiter hands out the native method).
  const records = (await previewInfo(app)) as unknown as { recentRecords: RawRecord[] };
  const flood = records.recentRecords.filter((r) => r.source === 'console' && r.message.startsWith('洪水消息'));
  expect(flood.length).toBeGreaterThan(0);
  for (const r of flood) {
    // The entry page is served at the server root.
    expect(['/', '/index.html']).toContain(new URL(r.url ?? 'x:').pathname);
    expect(r.line).toBe(18);
  }

  const dropped = page.getByTestId('preview-console-dropped');
  await expect(dropped).toBeVisible();
  const droppedCount = Number(/(\d+)/.exec((await dropped.textContent()) ?? '')?.[1] ?? 0);
  expect(droppedCount).toBeGreaterThan(0);
  const shown = await page.getByTestId('preview-console').locator('li').count();
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThanOrEqual(200);
  expect(shown + droppedCount).toBeLessThanOrEqual(logged);

  // A dedicated worker's console reaches main as well; the guard is installed in workers before their script runs.
  const workerStall = await app.evaluate(
    async ({ webContents }, id) => {
      let last = performance.now();
      let max = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        max = Math.max(max, now - last - 10);
        last = now;
      }, 10);
      const count = await webContents.fromId(id)?.executeJavaScript(
        `new Promise((resolve) => {
        const code = 'const end = Date.now() + 3000; let i = 0; while (Date.now() < end) { console.log("工作线程 " + i); i += 1; } postMessage(i);';
        const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
        worker.onmessage = (e) => resolve(e.data);
      })`,
      );
      await new Promise((r) => setTimeout(r, 300));
      clearInterval(timer);
      return { count: Number(count), max: Math.round(max) };
    },
    (await previewInfo(app)).previewWebContentsId ?? -1,
  );
  console.log(`worker console flood: ${workerStall.count} calls in 3 s; longest main stall ${workerStall.max} ms`);
  expect(workerStall.count).toBeGreaterThan(10_000);
  expect(workerStall.max).toBeLessThan(200);
  expect((await previewInfo(app)).pageGuarded).toBe(true);

  // Decision 0016 amendment: a page that saved a native console method before exceeding the limit bypasses it.
  // Main's flood guard then stops the running script (Runtime.terminateExecution), in the page and in workers, so
  // the flood ends at its source; the longest main stall stays within the same budget.
  const previewId = (await previewInfo(app)).previewWebContentsId ?? -1;
  const pageBypass = await measureMainStall(
    app,
    previewId,
    `(() => { const log = console.log; const end = Date.now() + 2000; let i = 0; while (Date.now() < end) { log('缓存的引用 ' + i); i += 1; } return 'finished'; })()`,
  );
  console.log(
    `cached console.log reference in the page (limiter bypassed): ${pageBypass.result} after ${pageBypass.ms} ms; ` +
      `longest main stall ${pageBypass.max} ms`,
  );
  expect(pageBypass.result).toBe('stopped');
  expect(pageBypass.ms).toBeLessThan(1_000);
  expect(pageBypass.max).toBeLessThan(200);
  // The page itself still works, and the console says why its script stopped (once per page load).
  expect(await evalInPreview<number>(app, '1 + 1')).toBe(2);
  await expect(
    page
      .locator('.preview-console-line[data-notice="console-flood-stopped"]')
      .filter({ hasText: '停止了正在运行的脚本' }),
  ).toHaveCount(1);

  // The same from a dedicated worker: its loop is ended too (it never posts 'finished').
  const workerBypass = await measureMainStall(
    app,
    previewId,
    `new Promise((resolve) => {
      const code = 'const log = console.log; const end = Date.now() + 2000; let i = 0; while (Date.now() < end) { log("工作线程缓存 " + i); i += 1; } postMessage("finished");';
      const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      w.onmessage = (e) => resolve(e.data);
      setTimeout(() => resolve('stopped'), 3000);
    })`,
  );
  console.log(
    `cached console.log reference in a worker (limiter bypassed): ${workerBypass.result}; ` +
      `longest main stall ${workerBypass.max} ms`,
  );
  expect(workerBypass.result).toBe('stopped');
  expect(workerBypass.max).toBeLessThan(200);
  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');
});

/**
 * Runs `code` in the preview while a 10 ms timer in main records the longest stall; also returns the code's result
 * ('stopped' when its execution was terminated) and how long it ran.
 */
async function measureMainStall(
  app: ElectronApplication,
  previewId: number,
  code: string,
): Promise<{ max: number; result: string; ms: number }> {
  return app.evaluate(
    async ({ webContents }, { id, js }) => {
      let last = performance.now();
      let max = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        max = Math.max(max, now - last - 10);
        last = now;
      }, 10);
      const started = Date.now();
      const result = await Promise.race([
        (webContents.fromId(id)?.executeJavaScript(js) ?? Promise.resolve('no preview')).then(String, () => 'stopped'),
        new Promise<string>((r) => setTimeout(() => r('timeout'), 10_000)),
      ]);
      const ms = Date.now() - started;
      await new Promise((r) => setTimeout(r, 1_000)); // whatever main still had queued
      clearInterval(timer);
      return { max: Math.round(max), result, ms };
    },
    { id: previewId, js: code },
  );
}

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
  // All interfaces: reachable through loopback, this machine's LAN address and its name, like a typical dev server.
  await new Promise<void>((resolve) => other.listen(0, '0.0.0.0', resolve));
  const otherPort = (other.address() as AddressInfo).port;
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal);
  await writeFile(
    path.join(root, 'config.json'),
    JSON.stringify({
      secretFileUrl: pathToFileURL(secret).href,
      otherPortUrl: `http://127.0.0.1:${otherPort}/`,
      otherPort,
      lanUrl: lan ? `http://${lan.address}:${otherPort}/` : null,
      machineName: os.hostname(),
    }),
  );

  try {
    await openProject(app, page, root);
    await page.getByTestId('preview-start').click();
    await waitForPreviewState(page, 'running');
    await expect
      .poll(() => evalInPreview<string>(app, 'document.body.dataset.results ?? ""'), { timeout: 45_000 })
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
        'dns-name-to-loopback',
        'dns-name-to-loopback-no-cors',
        'dns-name-to-server',
        'websocket-dns-name',
        'public-dns-name-to-loopback',
        'machine-name',
        'lan-ip',
        'zero-address',
        'image-dns-name',
        'service-worker',
        'external-browser-grant',
        'ide-bridge',
      ].sort(),
    );
    for (const [name, outcome] of Object.entries(results)) expect(outcome, name).toBe('failed');
    expect(junction).toBe(true); // the symlink-escape attempt really had a link to follow
    expect(otherHits).toBe(0);
    // file: never even reaches the network layer (Chromium refuses it in the renderer); the loopback attempts are
    // stopped by the preview session's request policy before any byte is sent.
    const info = await previewInfo(app);
    const blocked = info.blockedRequests;
    expect(blocked.some((b) => b.host === `127.0.0.1:${otherPort}`)).toBe(true);
    expect(blocked.some((b) => b.host.startsWith('localhost:'))).toBe(true);
    // Names are judged by the address they resolve to, by the proxy that then connects to exactly that address.
    expect(blocked).toContainEqual({ scheme: 'proxy', host: `rebind.test:${otherPort}` });
    expect(
      blocked.some((b) => b.scheme === 'proxy' && b.host === `rebind.test:${new URL(info.origin ?? '').port}`),
    ).toBe(true);
    if (lan) expect(blocked).toContainEqual({ scheme: 'proxy', host: `${lan.address}:${otherPort}` });
    expect(blocked).toContainEqual({ scheme: 'service-worker', host: '' });
    // WebRTC may not send UDP outside the proxy.
    const rtc = await app.evaluate(
      ({ webContents }, id) => webContents.fromId(id)?.getWebRTCIPHandlingPolicy(),
      info.previewWebContentsId ?? -1,
    );
    expect(rtc).toBe('disable_non_proxied_udp');
    // No service worker exists after a refresh either. The refreshed page runs its attacks again — including a new
    // registration attempt, which is visible as an in-flight registration until its script request is refused —
    // so the check waits until this page load has finished its attempts.
    await page.getByTestId('preview-reload').click();
    await waitForPreviewState(page, 'running');
    await expect
      .poll(() => evalInPreview<string>(app, 'document.body.dataset.results ?? ""'), { timeout: 45_000 })
      .not.toBe('');
    const again = JSON.parse(await evalInPreview<string>(app, 'document.body.dataset.results')) as Record<
      string,
      string
    >;
    expect(again['service-worker']).toBe('failed');
    await expect
      .poll(() => evalInPreview<number>(app, 'navigator.serviceWorker.getRegistrations().then((r) => r.length)'), {
        timeout: 5_000,
      })
      .toBe(0);
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }
});

test('alert, confirm, prompt, print and beforeunload cannot block the IDE, refresh or Stop (S05.5)', async () => {
  // Still the malicious project from the previous test.
  await waitForPreviewState(page, 'running');
  await openInEditor('index.html');
  const started = Date.now();
  // userGesture: the page has user activation, the strongest case (beforeunload dialogs need it).
  const answers = await evalInPreview<unknown[]>(
    app,
    `(() => {
      alert('来自页面的提示');
      const confirmed = confirm('确定吗?');
      let prompted;
      try { prompted = prompt('名字?'); } catch { prompted = 'threw'; }
      print();
      return [confirmed, prompted];
    })()`,
  );
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(answers[0]).toBe(false);
  expect([null, 'threw']).toContain(answers[1]);
  // The alert text is shown in the IDE's console instead of a modal dialog, and the IDE still takes input.
  await expect(page.getByTestId('preview-console')).toContainText('来自页面的提示');

  // A page that refuses to unload: refresh still loads a new document, and Stop still ends it.
  const arm = `window.__doc = Math.random();
    addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = '真的要离开吗?'; });
    window.__doc`;
  const before = await evalInPreview<number>(app, arm);
  await page.getByTestId('preview-reload').click();
  await expect
    .poll(() => evalInPreview<number | null>(app, 'window.__doc ?? null'), { timeout: 10_000 })
    .not.toBe(before);
  await waitForPreviewState(page, 'running');
  await evalInPreview<number>(app, arm);
  // The IDE takes input (typing autosaves, and the save refreshes the page despite its beforeunload handler).
  expect(await typeAndMeasure('对话框之后')).toBeLessThan(3_000);
  const projectId = (await previewInfo(app)).status.projectId;
  const stoppedAt = Date.now();
  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');
  expect(Date.now() - stoppedAt).toBeLessThan(5_000);

  // Starts are serialised (each reconfigures the project's session); Start, Start, Stop in a row must end stopped.
  await page.evaluate(async (id) => {
    const preview = (
      window as unknown as {
        noobide: { preview: { start(r: { projectId: string }): Promise<unknown>; stop(): Promise<unknown> } };
      }
    ).noobide.preview;
    await Promise.all([preview.start({ projectId: id }), preview.start({ projectId: id }), preview.stop()]);
  }, projectId ?? '');
  await page.waitForTimeout(1_000);
  const after = await previewInfo(app);
  expect(after.status.state).toBe('stopped');
  expect(after.previewWebContentsId).toBeNull();
  await waitForPreviewState(page, 'stopped');
});

test('no workbench console errors during the isolation run', async () => {
  expect(consoleErrors).toEqual([]);
});
