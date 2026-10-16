import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  CONSOLE_BURST,
  CONSOLE_LIMIT,
  MAX_GUARDED_SCOPES,
  WORKER_CONSOLE_BURST,
  WORKER_CONSOLE_LIMIT,
} from '../../src/preview/page-guard';
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
  // About 2 minutes; up to three floods and three windows per bypass case on a noisy runner.
  test.setTimeout(360_000);
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
  // Stalls over 50 ms are kept with their time since the start click, so a failure shows when main stalled.
  // On the 4-vCPU Windows CI runner main also stalls for 0.1–0.9 s at random with no console output at all (the
  // baselines of the next test part), so one flood cannot show a 200 ms bound there: the flood runs up to
  // FLOOD_ATTEMPTS times (Stop + Start: a new view, so the page floods again) until one run meets every timing bound.
  // A limiter that let the flood through would stall main for seconds in every run.
  const FLOOD_ATTEMPTS = 3;
  const floodRun = async () => {
    await page.evaluate(() => {
      const probe = (window as unknown as { __probe: { inputs: number[]; maxTimerLag: number } }).__probe;
      probe.inputs = [];
      probe.maxTimerLag = 0;
    });
    await app.evaluate(() => {
      const t0 = performance.now();
      const lag = {
        max: 0,
        startedAt: Date.now(),
        stalls: [] as [number, number][],
        timer: undefined as ReturnType<typeof setInterval> | undefined,
      };
      (globalThis as unknown as { __mainLag: typeof lag }).__mainLag = lag;
      let last = performance.now();
      lag.timer = setInterval(() => {
        const now = performance.now();
        const stall = now - last - 10;
        lag.max = Math.max(lag.max, stall);
        if (stall > 50 && lag.stalls.length < 50) lag.stalls.push([Math.round(last - t0), Math.round(stall)]);
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
    const { mainStall, stalls, startedAt } = await app.evaluate(() => {
      const lag = (
        globalThis as unknown as {
          __mainLag: {
            max: number;
            startedAt: number;
            stalls: [number, number][];
            timer: ReturnType<typeof setInterval>;
          };
        }
      ).__mainLag;
      clearInterval(lag.timer);
      return { mainStall: Math.round(lag.max), stalls: lag.stalls, startedAt: lag.startedAt };
    });
    const probe = await page.evaluate(
      () => (window as unknown as { __probe: { inputs: number[]; maxTimerLag: number } }).__probe,
    );
    const latencies = sent.sends.map((t, i) => (probe.inputs[i] ?? Number.POSITIVE_INFINITY) - t);
    console.log(
      `console flood: ${logged} messages in 6 s; keystroke latency ms ${JSON.stringify(latencies)}; ` +
        `workbench max timer lag ${Math.round(probe.maxTimerLag)} ms; main max timer lag ${sent.mainLag} ms; ` +
        `longest main-thread stall during the flood ${mainStall} ms; stalls over 50 ms [ms after Start, ms] ${JSON.stringify(stalls)}; keystrokes sent at ${JSON.stringify(sent.sends.map((t) => t - startedAt))}`,
    );
    const floodInfo = (await previewInfo(app)) as unknown as { floodTrace?: unknown; guardTrace?: unknown };
    console.log(
      `console flood: main flood guard ${JSON.stringify(floodInfo.floodTrace)}; page guard ${JSON.stringify(floodInfo.guardTrace)}`,
    );
    const timely =
      probe.inputs.length === 20 &&
      Math.max(...latencies) < 500 &&
      probe.maxTimerLag < 500 &&
      mainStall < 200 &&
      sent.mainLag < 200;
    return { logged, mainStall, mainLag: sent.mainLag, probe, latencies, timely };
  };
  let run = await floodRun();
  for (let attempt = 1; attempt < FLOOD_ATTEMPTS && !run.timely; attempt += 1) {
    await page.getByTestId('preview-stop').click();
    await waitForPreviewState(page, 'stopped');
    run = await floodRun();
  }
  const { logged, mainStall, probe, latencies } = run;
  // All 20 keystrokes typed during the flood reached the editor, each quickly.
  expect(probe.inputs.length).toBe(20);
  await expect(editorText()).toContainText('q'.repeat(20));
  expect(Math.max(...latencies)).toBeLessThan(500);
  expect(probe.maxTimerLag).toBeLessThan(500);
  // S05.7: the in-page rate limit (decision 0016) keeps the messages that reach main far below what stalls it.
  expect(mainStall).toBeLessThan(200);
  expect(run.mainLag).toBeLessThan(200);
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
        worker.onmessage = (e) => { worker.terminate(); resolve(e.data); };
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
  // Limited floods (page, then worker) never trip main's guard: nothing was stopped, no notice.
  await expect(page.locator('.preview-console-line[data-notice="console-flood-stopped"]')).toHaveCount(0);

  // Decision 0016, second amendment: every console method a page can reach is the guard's limiter, so keeping a
  // reference to one (before the limit, from a descriptor, through call/apply/bind, a console.context object, a
  // fresh iframe, a worker, a worklet) never yields an unlimited one. Each of these loops runs to its end without
  // anything being stopped, only a bounded number of messages reaches main, and main never stalls.
  const previewId = (await previewInfo(app)).previewWebContentsId ?? -1;
  // Sandboxed iframes stay in the page's process, so the guard is in place before their scripts run.
  expect(
    await app.evaluate(({ app: electronApp }) => electronApp.commandLine.getSwitchValue('disable-features')),
  ).toContain('IsolateSandboxedIframes');
  const LOOP_MS = 1_500;
  const loop = (body: string) =>
    `const end = Date.now() + ${LOOP_MS}; let i = 0; while (Date.now() < end) { ${body}; i += 1; }`;
  const inWorker = (code: string) =>
    `new Promise((resolve) => {
      const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(code)}], { type: 'text/javascript' })));
      // Ended afterwards: a running worker holds one of the MAX_GUARDED_SCOPES slots.
      w.onmessage = (e) => { w.terminate(); resolve(e.data); };
      setTimeout(() => resolve('stopped'), ${LOOP_MS + 3_000});
    })`;
  const inFrame = (setup: string) =>
    `new Promise((resolve) => {
      const f = document.createElement('iframe');
      ${setup}
      addEventListener('message', function on(e) { if (e.data === 'finished') { removeEventListener('message', on); f.remove(); resolve('finished'); } });
      document.body.append(f);
      setTimeout(() => resolve('stopped'), ${LOOP_MS + 3_000});
    })`;
  const bypasses: [string, string][] = [
    [
      'saved console.log in the page',
      `(() => { const log = console.log; ${loop("log('缓存的引用 ' + i)")} return 'finished'; })()`,
    ],
    [
      'descriptor value, call, apply, bind, Reflect.apply',
      `(() => {
        const log = Object.getOwnPropertyDescriptor(console, 'log').value;
        const bound = Function.prototype.bind.call(console.warn, console);
        ${loop('log.call(console, i); Function.prototype.apply.call(console.error, console, [i]); bound(i); Reflect.apply(console.info, console, [i])')}
        return 'finished';
      })()`,
    ],
    [
      'prototype and context tricks',
      `(() => {
        const ctx = console.context('x');
        const proto = Object.getPrototypeOf(console);
        const log = (proto && proto.log) || ctx.log;
        ${loop('log(i); ctx.warn(i)')}
        return 'finished';
      })()`,
    ],
    [
      'saved console.log of a new iframe (initial about:blank)',
      `(() => { const f = document.createElement('iframe'); document.body.append(f); const log = f.contentWindow.console.log; ${loop("log('框架 ' + i)")} f.remove(); return 'finished'; })()`,
    ],
    [
      'saved console.log in a sandboxed srcdoc iframe',
      inFrame(
        `f.sandbox = 'allow-scripts'; f.srcdoc = ${JSON.stringify(`<script>const log = console.log; ${loop("log('沙箱框架 ' + i)")} parent.postMessage('finished', '*');</script>`)};`,
      ),
    ],
    [
      'saved console.log in a worker',
      inWorker(`const log = console.log; ${loop("log('工作线程缓存 ' + i)")} postMessage('finished');`),
    ],
    [
      'saved console.log in a nested worker',
      inWorker(
        `const inner = ${JSON.stringify(`const log = console.log; ${loop("log('嵌套 ' + i)")} postMessage('finished');`)};
        const w = new Worker(URL.createObjectURL(new Blob([inner], { type: 'text/javascript' })));
        w.onmessage = (e) => postMessage(e.data);`,
      ),
    ],
    [
      'worklet entry points are gone (paint and audio worklets cannot be limited)',
      `(() => {
        if (typeof CSS.paintWorklet !== 'undefined') return 'paint worklet reachable';
        if ('audioWorklet' in BaseAudioContext.prototype) return 'audio worklet reachable';
        const f = document.createElement('iframe');
        document.body.append(f);
        const reachable = typeof f.contentWindow.CSS.paintWorklet !== 'undefined' || 'audioWorklet' in f.contentWindow.BaseAudioContext.prototype;
        f.remove();
        return reachable ? 'reachable in an iframe' : 'finished';
      })()`,
    ],
    [
      '200 iframes, each with a saved console.log',
      `(() => {
        const logs = [];
        for (let k = 0; k < 200; k += 1) {
          const f = document.createElement('iframe');
          f.style.display = 'none';
          document.body.append(f);
          logs.push(f.contentWindow.console.log);
        }
        ${loop("for (const log of logs) log('多个框架 ' + i)")}
        document.querySelectorAll('iframe').forEach((f) => f.remove());
        return 'finished';
      })()`,
    ],
    [
      'iframes created and removed in a loop, each a saved console.log',
      `(() => {
        let frames = 0;
        ${loop("const f = document.createElement('iframe'); document.body.append(f); const log = f.contentWindow.console.log; for (let k = 0; k < 60; k += 1) log('循环框架 ' + k); f.remove(); frames += 1")}
        return frames > 100 ? 'finished' : 'only ' + frames + ' frames';
      })()`,
    ],
    [
      'sandboxed iframes created and removed in a loop',
      `new Promise((resolve) => {
        const code = ${JSON.stringify(`<script>const log = console.log; for (let k = 0; k < 60; k += 1) log('沙箱循环 ' + k);</script>`)};
        const end = Date.now() + ${LOOP_MS};
        let frames = 0;
        const next = () => {
          if (Date.now() >= end) return resolve(frames > 20 ? 'finished' : 'only ' + frames + ' frames');
          const f = document.createElement('iframe');
          f.sandbox = 'allow-scripts';
          f.srcdoc = code;
          f.onload = () => { f.remove(); frames += 1; next(); };
          document.body.append(f);
        };
        next();
      })`,
    ],
    [
      'workers started and ended in a loop, each a saved console.log',
      `new Promise((resolve) => {
        const code = ${JSON.stringify(`const log = console.log; for (let k = 0; k < 20; k += 1) log('循环线程 ' + k); postMessage('done');`)};
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        const end = Date.now() + ${LOOP_MS};
        const all = [];
        let done = 0;
        const spawn = () => {
          if (Date.now() >= end) return;
          const w = new Worker(url);
          all.push(w);
          w.onmessage = () => { done += 1; w.terminate(); spawn(); };
        };
        for (let k = 0; k < ${MAX_GUARDED_SCOPES}; k += 1) spawn();
        setTimeout(() => { all.forEach((w) => w.terminate()); resolve(done > 0 ? 'finished' : 'none ran'); }, ${LOOP_MS + 500});
      })`,
    ],
    [
      '20 workers at once, each with a saved console.log',
      `new Promise((resolve) => {
        const code = ${JSON.stringify(`const log = console.log; ${loop("log('多个线程 ' + i)")} postMessage('done');`)};
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        const workers = [];
        let done = 0;
        for (let k = 0; k < 20; k += 1) {
          const w = new Worker(url);
          workers.push(w);
          w.onmessage = () => { done += 1; };
        }
        // At most ${MAX_GUARDED_SCOPES} run; the others never start (decision 0016, second amendment). Waited for
        // 5 s: on the 4-vCPU Windows runner the last of the eight sometimes started more than 2 s late.
        setTimeout(() => { workers.forEach((w) => w.terminate()); resolve(done === ${MAX_GUARDED_SCOPES} ? 'finished' : 'done: ' + done); }, ${LOOP_MS + 5_000});
      })`,
    ],
    [
      'reportError and rejected promises',
      `(() => { const report = reportError; ${loop("report(new Error('报告 ' + i)); if (i % 1000 === 0) Promise.reject(i)")} return 'finished'; })()`,
    ],
  ];
  // What the page's documents (one shared budget, at least one message each) or a set of workers may send in
  // LOOP_MS, plus summaries (page-guard.ts).
  const allowed = CONSOLE_BURST + Math.ceil((CONSOLE_LIMIT * LOOP_MS) / 1_000) + 10;
  // Workers: at most MAX_GUARDED_SCOPES start per second and run at once, each with its own small budget.
  const workerWindows = Math.ceil((LOOP_MS + 500) / 1_000) + 1;
  const allowedFor = (name: string) =>
    name.startsWith('20 workers')
      ? MAX_GUARDED_SCOPES * (WORKER_CONSOLE_BURST + Math.ceil((WORKER_CONSOLE_LIMIT * LOOP_MS) / 1_000) + 2)
      : name.startsWith('workers started and ended')
        ? workerWindows * MAX_GUARDED_SCOPES * (WORKER_CONSOLE_BURST + 2)
        : allowed;
  // Creating and removing 200 iframes in one burst costs main (Chromium's browser UI thread) per-frame work that has
  // nothing to do with the console: frame bookkeeping and the DevTools Page events of every frame for the page guard's
  // session and Playwright's. On a 4-vCPU Windows CI runner that alone measured ~0.5 s. The console budget applies on
  // top of a calibrated baseline: the same frames and the same busy loop, no console output.
  const framesOnly = await measureMainStall(
    app,
    previewId,
    `(() => {
      const logs = [];
      for (let k = 0; k < 200; k += 1) {
        const f = document.createElement('iframe');
        f.style.display = 'none';
        document.body.append(f);
        logs.push(f.contentWindow.console.log);
      }
      ${loop('void logs.length')}
      document.querySelectorAll('iframe').forEach((f) => f.remove());
      return 'finished';
    })()`,
  );
  console.log(`200 iframes without console output (baseline): longest main stall ${framesOnly.max} ms`);
  expect(framesOnly.result).toBe('finished');
  expect(framesOnly.max).toBeLessThan(1_500); // frame lifecycle alone stays bounded too
  // The same holds for creating and removing iframes as fast as possible (Windows runner: 263–703 ms with console
  // output, the 200-iframe baseline alone 320–328 ms there; macOS runner and dev machines < 70 ms).
  const churnOnly = await measureMainStall(
    app,
    previewId,
    `(() => {
      let frames = 0;
      ${loop("const f = document.createElement('iframe'); document.body.append(f); void f.contentWindow.console.log; f.remove(); frames += 1")}
      return frames > 100 ? 'finished' : 'only ' + frames + ' frames';
    })()`,
  );
  console.log(
    `iframes created and removed in a loop without console output (baseline): longest main stall ${churnOnly.max} ms`,
  );
  expect(churnOnly.result).toBe('finished');
  expect(churnOnly.max).toBeLessThan(1_500);
  // And for eight busy workers at once: on the 4-vCPU Windows runner they alone stalled main 0.7–3 s (CI run
  // 38805786307), console or not; the same code with a no-op instead of the log call is the baseline.
  const workersOnly = await measureMainStall(
    app,
    previewId,
    `new Promise((resolve) => {
      const code = ${JSON.stringify(`${loop('void i')} postMessage('done');`)};
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const workers = [];
      let done = 0;
      for (let k = 0; k < 20; k += 1) {
        const w = new Worker(url);
        workers.push(w);
        w.onmessage = () => { done += 1; };
      }
      setTimeout(() => { workers.forEach((w) => w.terminate()); resolve(done === ${MAX_GUARDED_SCOPES} ? 'finished' : 'done: ' + done); }, ${LOOP_MS + 5_000});
    })`,
  );
  console.log(`20 workers at once without console output (baseline): longest main stall ${workersOnly.max} ms`);
  expect(workersOnly.result).toBe('finished');
  expect(workersOnly.max).toBeLessThan(5_000);
  const stallBudget = (name: string) =>
    200 +
    (name.startsWith('200 iframes') ? framesOnly.max : 0) +
    (name.startsWith('iframes created and removed') ? churnOnly.max : 0) +
    (name.startsWith('20 workers') ? workersOnly.max : 0);
  // On the 4-vCPU Windows CI runner main also stalls for 0.1–0.9 s at random with no console output at all (the
  // baselines above, measured run to run), so one window cannot show a 200 ms bound there. A limiter bypass stalls
  // main in every window; a runner stall does not. Each case gets up to STALL_ATTEMPTS windows and the best one counts;
  // what reaches main and the result are checked in every window.
  const STALL_ATTEMPTS = 3;
  // `budget`, when given, is measured right before each window (a baseline next to the window it calibrates).
  const bestOf = async (
    name: string,
    measure: () => Promise<Awaited<ReturnType<typeof measureMainStall>>>,
    check: (run: Awaited<ReturnType<typeof measureMainStall>>) => void,
    stall: (run: Awaited<ReturnType<typeof measureMainStall>>) => number,
    budget: () => Promise<number> = async () => stallBudget(name),
  ) => {
    const stalls: number[] = [];
    const budgets: number[] = [];
    for (let attempt = 0; attempt < STALL_ATTEMPTS; attempt += 1) {
      budgets.push(await budget());
      const run = await measure();
      check(run);
      stalls.push(stall(run));
      if (stalls[attempt]! < budgets[attempt]!) break;
    }
    if (stalls.length > 1) {
      console.log(
        `${name}: stalls in ${stalls.length} windows ${JSON.stringify(stalls)} ms, budgets ${JSON.stringify(budgets)} ms`,
      );
    }
    // The best window, measured against its own budget.
    expect(Math.min(...stalls.map((s, k) => s - budgets[k]!)), name).toBeLessThan(0);
  };
  for (const [name, code] of bypasses) {
    await bestOf(
      name,
      () => measureMainStall(app, previewId, code),
      (run) => {
        console.log(
          `${name}: ${run.result} after ${run.ms} ms; ${run.messages} messages reached main; longest main stall ${run.max} ms`,
        );
        expect(run.result, name).toBe('finished');
        expect(run.messages, name).toBeLessThanOrEqual(allowedFor(name));
      },
      (run) => run.max,
    );
  }
  // Nothing needed stopping.
  await expect(page.locator('.preview-console-line[data-notice="console-flood-stopped"]')).toHaveCount(0);

  // The design does not depend on main being fast: with an artificial 0.6 ms of main-thread work per console
  // message (what a loaded Windows CI runner measured), main never has to take more than the limiter's bursts in one
  // go (page-guard.ts: CONSOLE_BURST + MAX_GUARDED_SCOPES × WORKER_CONSOLE_BURST messages, ≤ 156 ms of that work),
  // and the rest of each stall stays within the budget. The simulated work is wall-clock time: on the 3-core macOS
  // runner, where "20 workers" itself runs 8 busy threads, 170–208 messages in one go took 196–250 ms, so the
  // simulated part is checked through the batch size, not the wall-clock total, and "the rest" is the gap minus the
  // time main measurably spent in the simulated work (measureMainStall).
  const MOST_AT_ONCE = CONSOLE_BURST + MAX_GUARDED_SCOPES * WORKER_CONSOLE_BURST;
  // The iframe cases need a baseline under the same slow main. Windows CI (2026-10-16) measured the churn case at
  // 16 ms without the slow main and its console-free baseline at 146 ms, but 405, 518 and 514 ms beyond the simulated
  // work in three windows with it (macOS and the dev machine: 42–58 ms) — every window, yet with 398–399 messages and
  // at most 90–112 between two ticks, inside MOST_AT_ONCE: no more console traffic than the limiter allows, and frame
  // lifecycle work (frame bookkeeping, every frame's DevTools Page events for the guard's session and Playwright's)
  // that piles up behind the simulated work is the likely rest. A console-free baseline has no simulated work, so it
  // cannot calibrate that; one measured in another window cannot either (146 ms here, 94–776 ms run to run). The
  // calibration is therefore the same frames, the same busy loop and the same console volume through the top
  // document's own console — the path "saved console.log in the page" bounds — instead of the frames' consoles,
  // measured right before each window. Whatever only a frame's console adds (a bypass) is still held to 200 ms; the
  // baseline itself is held to the limiter's batch bound and to 1.5 s.
  const throughTop: Record<string, string> = {
    '200 iframes, each with a saved console.log': `(() => {
        const log = console.log;
        const logs = [];
        for (let k = 0; k < 200; k += 1) {
          const f = document.createElement('iframe');
          f.style.display = 'none';
          document.body.append(f);
          logs.push(f.contentWindow.console.log);
        }
        ${loop("for (let k = 0; k < logs.length; k += 1) log('多个框架 ' + i)")}
        document.querySelectorAll('iframe').forEach((f) => f.remove());
        return 'finished';
      })()`,
    'iframes created and removed in a loop, each a saved console.log': `(() => {
        const log = console.log;
        let frames = 0;
        ${loop("const f = document.createElement('iframe'); document.body.append(f); void f.contentWindow.console.log; for (let k = 0; k < 60; k += 1) log('循环框架 ' + k); f.remove(); frames += 1")}
        return frames > 100 ? 'finished' : 'only ' + frames + ' frames';
      })()`,
  };
  const slowMainBaseline = async (name: string, code: string) => {
    const base = await measureMainStall(app, previewId, code, { costMs: 0.6 });
    console.log(
      `${name} (main 0.6 ms per message), the same through the top document's console (baseline): ` +
        `${base.messages} messages; most between two ticks ${base.batch}; most simulated work between two ticks ${base.simulated} ms; ` +
        `longest stall beyond the simulated work ${base.unexplained} ms`,
    );
    expect(base.result, name).toBe('finished');
    expect(base.batch, name).toBeLessThanOrEqual(MOST_AT_ONCE);
    expect(base.unexplained, name).toBeLessThan(1_500);
    return 200 + base.unexplained;
  };
  for (const [name, code] of bypasses.filter(([n]) =>
    /page|worker$|sandboxed|^200 iframes|^20 workers|in a loop/.test(n),
  )) {
    await bestOf(
      name,
      () => measureMainStall(app, previewId, code, { costMs: 0.6 }),
      (run) => {
        console.log(
          `${name} (main 0.6 ms per message): ${run.messages} messages; longest main stall ${run.max} ms; ` +
            `most messages between two 10 ms ticks ${run.batch}; most simulated work between two ticks ${run.simulated} ms; ` +
            `longest stall beyond the simulated work ${run.unexplained} ms`,
        );
        expect(run.result, name).toBe('finished');
        expect(run.batch, name).toBeLessThanOrEqual(MOST_AT_ONCE);
      },
      (run) => run.unexplained,
      throughTop[name] === undefined ? undefined : () => slowMainBaseline(name, throughTop[name]!),
    );
  }

  // Defence in depth (decision 0016, first amendment): output the limiter cannot see — here a DevTools isolated
  // world, which no page can create — still trips main's flood guard, which stops the running script.
  const backstop = await measureMainStall(
    app,
    previewId,
    `(() => { const end = Date.now() + 5000; let i = 0; while (Date.now() < end) { console.log('隔离世界 ' + i); i += 1; } return 'finished'; })()`,
    { isolatedWorld: true },
  );
  console.log(
    `isolated-world flood (backstop): ${backstop.result} after ${backstop.ms} ms; longest main stall ${backstop.max} ms; ` +
      `guard ${JSON.stringify((await previewInfo(app)).floodTrace)}`,
  );
  expect(backstop.result).toBe('stopped');
  expect(backstop.ms).toBeLessThan(5_000);
  expect(await evalInPreview<number>(app, '1 + 1')).toBe(2);
  await expect(
    page
      .locator('.preview-console-line[data-notice="console-flood-stopped"]')
      .filter({ hasText: '停止了正在运行的脚本' }),
  ).toHaveCount(1);
  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');
});

/**
 * Runs `code` in the preview while a 10 ms timer in main records the longest stall; also returns the code's result
 * ('stopped' when its execution was terminated), how long it ran and how many console messages of the preview
 * reached main. `costMs` adds that much main-thread work per message (a slow main); `isolatedWorld` runs the code in
 * a DevTools isolated world of the page (no page guard there) instead of the page's own world.
 */
async function measureMainStall(
  app: ElectronApplication,
  previewId: number,
  code: string,
  options: { costMs?: number; isolatedWorld?: boolean } = {},
): Promise<{
  max: number;
  result: string;
  ms: number;
  messages: number;
  batch: number;
  simulated: number;
  unexplained: number;
}> {
  return app.evaluate(
    async ({ webContents }, { id, js, costMs, isolatedWorld }) => {
      const wc = webContents.fromId(id);
      if (!wc) return { max: 0, result: 'no preview', ms: 0, messages: 0, batch: 0, simulated: 0, unexplained: 0 };
      let messages = 0;
      let sinceTick = 0;
      let batch = 0;
      // Wall-clock time main spent in the simulated work since the last tick. A spin to a deadline ends late when the
      // OS takes the thread off a CPU near the deadline: on the 3-core macOS runner, where "20 workers" runs 8 busy
      // threads, 177–201 messages (≈ 120 ms of nominal work) left 277–398 ms of a gap "unexplained" in every window
      // (CI run of 2026-10-16) with no more messages than the limiter allows. That overrun belongs to the simulation
      // (it only exists because the simulated work spins), so it is measured, not estimated as messages × costMs.
      let simulatedSinceTick = 0;
      let simulated = 0;
      const onMessage = () => {
        messages += 1;
        sinceTick += 1;
        if (costMs > 0) {
          const from = performance.now();
          const until = from + costMs;
          let now = from;
          while (now < until) {
            now = performance.now(); // a slow main thread
          }
          simulatedSinceTick += now - from;
        }
      };
      wc.on('console-message', onMessage);
      let last = performance.now();
      let max = 0;
      let unexplained = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        max = Math.max(max, now - last - 10);
        // The part of this gap that the simulated per-message work does not account for.
        unexplained = Math.max(unexplained, now - last - 10 - simulatedSinceTick);
        last = now;
        batch = Math.max(batch, sinceTick);
        simulated = Math.max(simulated, simulatedSinceTick);
        sinceTick = 0;
        simulatedSinceTick = 0;
      }, 10);
      const evaluate = async (): Promise<string> => {
        if (!isolatedWorld) return String(await wc.executeJavaScript(js));
        const tree = (await wc.debugger.sendCommand('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
        const world = (await wc.debugger.sendCommand('Page.createIsolatedWorld', {
          frameId: tree.frameTree.frame.id,
          worldName: 'e2e-backstop',
        })) as { executionContextId: number };
        const answer = (await wc.debugger.sendCommand('Runtime.evaluate', {
          expression: js,
          contextId: world.executionContextId,
          returnByValue: true,
        })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
        if (answer.exceptionDetails) throw new Error('terminated');
        return String(answer.result?.value);
      };
      const started = Date.now();
      const result = await Promise.race([
        evaluate().then(String, () => 'stopped'),
        new Promise<string>((r) => setTimeout(() => r('timeout'), 15_000)),
      ]);
      const ms = Date.now() - started;
      await new Promise((r) => setTimeout(r, 1_000)); // whatever main still had queued
      clearInterval(timer);
      wc.off('console-message', onMessage);
      return {
        max: Math.round(max),
        result,
        ms,
        messages,
        batch,
        simulated: Math.round(simulated),
        unexplained: Math.round(unexplained),
      };
    },
    { id: previewId, js: code, costMs: options.costMs ?? 0, isolatedWorld: options.isolatedWorld ?? false },
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

  // Decision 0016: the console limiter calls the native method for the page, from a stub at the caller's location,
  // so every way of calling a console method keeps the page's own file and line.
  const attributed: [string, string, number][] = [
    ['保存的引用', 'info', 3],
    ['数组回调', 'info', 4],
    ['通过 call', 'warning', 5],
    ['通过 bind', 'info', 6],
    ['alert: 提示框', 'info', 7],
  ];
  for (const [text, level, line] of attributed) {
    const record = await find((r) => r.source === 'console' && r.message.startsWith(text));
    expect(record, text).toMatchObject({ level, line });
    expect(fileOf(record), text).toBe('/js/console.js');
  }

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
