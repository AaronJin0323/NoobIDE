import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { listTemplates, resolveTemplatesDir, type TemplateInfo } from '../../src/workspace/templates';
import { launchApp, repoRoot, tempRoot } from './launch';

/**
 * S20.1: every built-in template, copied into a folder whose path has Chinese characters and spaces, previews in a
 * real Chromium page with zero problems: no console errors, no uncaught exceptions, no failed loads, no network
 * requests (offline), local images decoded, the stylesheet applied, and its buttons work.
 *
 * The real preview (sandboxed WebContentsView + loopback static server) is built in S10/S11; this harness uses an
 * equally locked-down hidden window (sandbox, context isolation, no preload, own in-memory partition) so the check
 * does not depend on that work.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let tmp: string;
let templates: readonly TemplateInfo[];

interface LoadLog {
  requests: string[];
  failures: string[];
}

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(tempRoot(), 'noobide-tpl-'));
  app = await launchApp();
  await app.firstWindow();
  // The running app resolves the same folder the tests read (development layout: <app path>/resources/templates).
  const where = await app.evaluate(({ app: electronApp }) => ({
    isPackaged: electronApp.isPackaged,
    appPath: electronApp.getAppPath(),
    resourcesPath: process.resourcesPath,
  }));
  const dir = resolveTemplatesDir(where);
  expect(dir).toBe(path.join(repoRoot, 'resources', 'templates'));
  const listing = await listTemplates(dir);
  if (!listing.ok) throw new Error(listing.message);
  templates = listing.value.templates;
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

/** Copies exactly the manifest's files, as the create-project wizard (S20.2) will. */
async function copyTemplate(t: TemplateInfo): Promise<string> {
  const project = path.join(tmp, '我的 网页', `${t.name['zh-CN']} 练习`);
  for (const rel of t.files) {
    const target = path.join(project, ...rel.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(t.dir, ...rel.split('/')), target);
  }
  return project;
}

/** Opens a hidden, sandboxed window on its own offline session and returns its Playwright page. */
async function openPreviewWindow(id: string): Promise<Page> {
  const [page] = await Promise.all([
    app.waitForEvent('window'),
    app.evaluate(({ BrowserWindow, session }, partition) => {
      const ses = session.fromPartition(partition);
      const log: LoadLog = { requests: [], failures: [] };
      (globalThis as unknown as { __tplLog: LoadLog }).__tplLog = log;
      ses.webRequest.onBeforeRequest((details, callback) => {
        log.requests.push(details.url);
        // Offline: anything that is not a local file is refused (and recorded, which fails the test).
        callback({ cancel: !details.url.startsWith('file:') });
      });
      ses.webRequest.onErrorOccurred((details) => log.failures.push(`${details.error} ${details.url}`));
      ses.webRequest.onCompleted((details) => {
        if (details.statusCode >= 400) log.failures.push(`${details.statusCode} ${details.url}`);
      });
      const win = new BrowserWindow({
        show: false,
        width: 900,
        height: 700,
        webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      (globalThis as unknown as { __tplWin: typeof win }).__tplWin = win;
      void win.loadURL('about:blank');
    }, `templates-e2e-${id}`),
  ]);
  await page.waitForLoadState();
  return page;
}

for (const id of ['personal-intro', 'product-showcase', 'button-counter']) {
  test(`${id} previews offline with zero problems and working buttons (S20.1)`, async () => {
    const t = templates.find((x) => x.id === id);
    expect(t, `template ${id}`).toBeDefined();
    const project = await copyTemplate(t!);
    expect(existsSync(path.join(project, t!.entry))).toBe(true);

    const page = await openPreviewWindow(id);
    const problems: string[] = [];
    page.on('console', (msg) => {
      // Electron's own "Electron Security Warning" (unpackaged builds, page without a CSP) concerns the host app,
      // not the template; the real preview (S10/S11) sets its own CSP.
      const hostWarning = msg.type() === 'warning' && msg.text().includes('Electron Security Warning');
      if ((msg.type() === 'error' || msg.type() === 'warning') && !hostWarning) {
        problems.push(`${msg.type()}: ${msg.text()}`);
      }
    });
    page.on('pageerror', (e) => problems.push(`exception: ${String(e)}`));

    await app.evaluate(
      async (_electron, file) => {
        const win = (globalThis as unknown as { __tplWin: Electron.BrowserWindow }).__tplWin;
        await win.loadFile(file);
      },
      path.join(project, t!.entry),
    );
    // Playwright learns about the navigation from its own protocol events, which can trail main's loadFile (seen on
    // the Windows runner): wait until it has the template's document, or evaluate() runs in the old about:blank.
    await page.waitForURL((url) => url.protocol === 'file:', { waitUntil: 'load' });

    // Images decoded, stylesheet applied (body background differs from the browser default).
    const state = await page.evaluate(() => ({
      images: [...document.images].map((img) => ({
        src: img.getAttribute('src'),
        ok: img.complete && img.naturalWidth > 0,
      })),
      background: getComputedStyle(document.body).backgroundColor,
      title: document.title,
      h1: document.querySelector('h1')?.textContent ?? '',
    }));
    expect(state.images.length).toBeGreaterThan(0);
    expect(state.images.filter((i) => !i.ok)).toEqual([]);
    expect(state.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(state.title).not.toBe('');
    expect(state.h1).not.toBe('');

    // The buttons do what the template promises.
    if (id === 'personal-intro') {
      await expect(page.locator('#message')).toHaveText('');
      await page.getByRole('button', { name: '打个招呼' }).click();
      await expect(page.locator('#message')).toContainText('小雨');
    } else if (id === 'product-showcase') {
      await page.getByRole('button', { name: '加入心愿单' }).click();
      await expect(page.locator('#like-button')).toHaveText('已加入心愿单');
      await expect(page.locator('#like-button')).toHaveClass(/liked/);
      await page.locator('#like-button').click();
      await expect(page.locator('#like-button')).toHaveText('加入心愿单');
    } else {
      await page.getByRole('button', { name: '加 1' }).click();
      await page.getByRole('button', { name: '加 1' }).click();
      await page.getByRole('button', { name: '减 1' }).click();
      await expect(page.locator('#count')).toHaveText('1');
      await page.getByRole('button', { name: '归零' }).click();
      await expect(page.locator('#count')).toHaveText('0');
    }

    const log = await app.evaluate(() => {
      const g = globalThis as unknown as { __tplLog: LoadLog; __tplWin: Electron.BrowserWindow };
      g.__tplWin.destroy();
      return g.__tplLog;
    });
    expect(problems).toEqual([]);
    expect(log.failures).toEqual([]);
    expect(log.requests.filter((u) => !u.startsWith('file:'))).toEqual([]);
    // Every file the page loaded lies inside the copied project.
    const projectUrl = `${pathToFileURL(project).href}/`;
    expect(log.requests.filter((u) => !decodeURI(u).startsWith(decodeURI(projectUrl)))).toEqual([]);
  });
}

test('packaged app contains the templates as plain files next to app.asar (S20.1)', async () => {
  // npm run test:e2e runs `electron-forge package` first, which writes out/<name>-<platform>-<arch>/.
  const outDir = path.join(repoRoot, 'out');
  const builds = existsSync(outDir) ? (await readdir(outDir)).filter((d) => d.startsWith('NoobIDE-')) : [];
  test.skip(builds.length === 0, 'no packaged build in out/ (run npm run test:e2e, which packages first)');
  for (const build of builds) {
    const base = path.join(outDir, build);
    const app = (await readdir(base)).find((d) => d.endsWith('.app'));
    const resourcesPath = app ? path.join(base, app, 'Contents', 'Resources') : path.join(base, 'resources');
    expect(existsSync(path.join(resourcesPath, 'app.asar')), `${build} app.asar`).toBe(true);
    const dir = resolveTemplatesDir({ isPackaged: true, resourcesPath, appPath: path.join(resourcesPath, 'app.asar') });
    const listing = await listTemplates(dir);
    if (!listing.ok) throw new Error(`${build}: ${listing.message}`);
    expect(listing.value.problems).toEqual([]);
    expect(listing.value.templates.map((x) => x.id)).toEqual(['personal-intro', 'product-showcase', 'button-counter']);
  }
});
