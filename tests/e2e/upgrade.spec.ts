import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { repoRoot, tempRoot } from './launch';
import { packagedExecutable } from './packaged';
import { typeAtEnd, switchLanguage, projectMenu } from './project';

/**
 * S28.4 (docs/decisions/0023-upgrade-and-uninstall.md), the macOS half of "vN → vN+1 manual upgrade keeps settings,
 * history, recent projects": two real packaged builds of NoobIDE — out/ (package.json's version) and
 * out/upgrade-next (the same code packaged as the next patch version by scripts/e2e.mjs) — run one after the other
 * on the same app data, exactly as a user who replaces the app would. Then the older one runs again (downgrade).
 *
 * The shipped binary has the Node inspector fuse off, so Playwright drives the workbench page over Chromium's
 * DevTools protocol instead. CFFIXED_USER_HOME gives both builds a throw-away home folder: their default app-data
 * folder (~/Library/Application Support/NoobIDE — no --user-data-dir, so the real default location is tested) and
 * Documents (where the wizard creates the project) live inside it, never in the developer's real home.
 */
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };

function nextExecutable(): string | undefined {
  const macos = path.join(repoRoot, 'out', 'upgrade-next', `NoobIDE-darwin-${process.arch}`, 'NoobIDE.app');
  const exe = path.join(macos, 'Contents', 'MacOS', 'noobide');
  return existsSync(exe) ? exe : undefined;
}

function bundleVersion(exe: string): string | undefined {
  const plist = readFileSync(path.join(path.dirname(exe), '..', 'Info.plist'), 'utf8');
  return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
}

interface Running {
  child: ChildProcess;
  browser: Browser;
  page: Page;
}

let home: string;
const userData = () => path.join(home, 'Library', 'Application Support', 'NoobIDE');

/** Every packaged process this file started; afterAll ends any that a failed or timed-out step left running. */
const running = new Set<ChildProcess>();

/** Ends the process (SIGTERM, then SIGKILL after `graceMs`) and resolves once it has exited. */
async function stop(child: ChildProcess, graceMs = 20_000): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  await exited;
  clearTimeout(timer);
  running.delete(child);
}

/**
 * Starts a packaged build on the throw-away home and connects to its workbench page. Every wait is bounded and fails
 * with what it was waiting for (the first launch of a freshly signed bundle can be slow on a loaded Mac), and on any
 * failure the process is ended here: a launch that never reached the test's try/finally must not keep running.
 */
async function start(exe: string): Promise<Running> {
  const portFile = path.join(userData(), 'DevToolsActivePort');
  await rm(portFile, { force: true });
  const child = spawn(exe, ['--remote-debugging-port=0'], {
    env: { ...process.env, CFFIXED_USER_HOME: home },
    stdio: 'ignore',
  });
  running.add(child);
  let browser: Browser | undefined;
  try {
    let port = '';
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null || child.signalCode !== null) {
            return `exited (${child.exitCode ?? child.signalCode}) before opening its DevTools port`;
          }
          // Chromium writes "<port>\n<browser target path>"; once the second line is there the port line is whole.
          const lines = existsSync(portFile) ? (await readFile(portFile, 'utf8')).split('\n') : [];
          port = lines[1]?.startsWith('/devtools/') ? (lines[0] ?? '') : '';
          return port ? 'listening' : 'starting';
        },
        { message: `DevTools port of ${exe}`, timeout: 90_000 },
      )
      .toBe('listening');
    // connectOverCDP attaches to every page and waits until each one answers. The restored project's preview is a
    // page too, and while its first navigation is still pending it answers nothing (seen for minutes on a loaded
    // Mac): connecting then times out with no hint why. So first wait, over plain HTTP that attaches to nothing,
    // until the workbench is there and no page is between about:blank and its first document.
    const settled = () =>
      expect
        .poll(
          async () => {
            const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
              type: string;
              title: string;
              url: string;
            }[];
            const pages = targets.filter((t) => t.type === 'page');
            if (!pages.some((p) => p.url.startsWith('noobide://app/'))) return 'no workbench page yet';
            const pending = pages.filter((p) => p.title === 'about:blank' && p.url !== 'about:blank');
            return pending.length === 0 ? 'settled' : `still loading: ${pending.map((p) => p.url).join(', ')}`;
          },
          { message: 'pages of the started app', timeout: 90_000 },
        )
        .toBe('settled');
    // Even with every page settled, attaching sometimes hangs after the websocket connects (hosted macOS, twice in a
    // day). A hang is retried with the pages checked again, three times at most, so one stuck attach does not fail
    // the run; a launch that never becomes attachable still fails with the Playwright error.
    for (let attempt = 1; ; attempt += 1) {
      await settled();
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 });
        break;
      } catch (error) {
        if (attempt >= 3) throw error;
        console.log(`upgrade: attaching over CDP timed out (attempt ${attempt}); checking the pages and retrying`);
      }
    }
    let page: Page | undefined;
    await expect
      .poll(
        () => {
          page = browser!
            .contexts()
            .flatMap((c) => c.pages())
            .find((p) => p.url().startsWith('noobide://app/'));
          return page !== undefined;
        },
        { message: 'workbench page', timeout: 60_000 },
      )
      .toBe(true);
    // No unbounded waits on this page: a stuck step fails with its own message instead of the test timeout.
    page!.setDefaultTimeout(30_000);
    await page!.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });
    return { child, browser, page: page! };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await stop(child);
    throw error;
  }
}

/** Quits the way the OS does on logout (SIGTERM → a normal app quit) and waits for the process to end. */
async function quit(app: Running): Promise<void> {
  await app.browser.close().catch(() => undefined);
  await stop(app.child);
}

async function aboutVersion(page: Page): Promise<string> {
  await page.evaluate(() => window.dispatchEvent(new Event('noobide:open-about')));
  const text = (await page.getByTestId('about-version').textContent()) ?? '';
  // The dialog installs its Escape handler and then moves focus to Close (effects that run after it renders), so
  // Escape pressed as soon as the text is there can reach the page before the handler exists.
  await expect(page.getByTestId('about-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('about-dialog')).toHaveCount(0);
  return text;
}

test.describe.configure({ mode: 'serial' });

/**
 * Playwright's trace of a browser it connected to over CDP: the runner starts a trace on the packaged app's context as
 * soon as it is connected, and with DOM snapshots and screenshots on, that start installs hooks (init script, screencast)
 * in every page of the app — including a page whose first navigation is still pending, which answers no CDP command
 * until it commits (the restored project's preview on a loaded Mac: run 39033368439 hung there for the whole test
 * timeout, outside any test step). The action timeline is kept; the per-page capture is not (docs/testing.md).
 */
test.use({ trace: { mode: 'retain-on-failure', snapshots: false, screenshots: false } });

test.beforeAll(async () => {
  home = await mkdtemp(path.join(tempRoot(), 'noobide-upgrade-home-'));
});

test.afterAll(async () => {
  // A step that timed out never reached its finally: end its app before removing the home it writes to.
  await Promise.all([...running].map((child) => stop(child, 5_000)));
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
});

test('packaged vN → vN+1 keeps settings, session, history and recent projects; vN again still reads them', async () => {
  test.skip(process.platform !== 'darwin', 'macOS packaged upgrade; Windows: harness/MANUAL-CHECKS.md#S28.4');
  test.setTimeout(360_000); // three launches, each allowed up to three CDP attach attempts
  const current = packagedExecutable();
  const next = nextExecutable();
  expect(current, 'packaged vN in out/ (npm run test:e2e builds it)').toBeDefined();
  expect(next, 'packaged vN+1 in out/upgrade-next (npm run test:e2e builds it)').toBeDefined();
  const nextVersion = bundleVersion(next!)!;
  expect(bundleVersion(current!)).toBe(pkg.version);
  expect(nextVersion).not.toBe(pkg.version);

  // --- vN: change a setting, create a project, edit and save twice (local history), quit. ---
  const vN = await start(current!);
  let project: string;
  try {
    const { page } = vN;
    expect(await aboutVersion(page)).toBe(`版本 ${pkg.version}`);
    await switchLanguage(page);
    expect(await aboutVersion(page)).toBe(`Version ${pkg.version}`);

    await page.getByTestId('welcome-create').click();
    project = ((await page.getByTestId('wizard-folder').textContent()) ?? '').trim();
    // (The app shows the temp folder as /var/…, a link to /private/var/….)
    const unprivate = (p: string) => p.replace(/^\/private\//, '/');
    expect(unprivate(project).startsWith(unprivate(path.join(home, 'Documents'))), project).toBe(true);
    project = path.join(home, path.relative(unprivate(home), unprivate(project))); // the real path the app opens
    await page.getByTestId('wizard-create').click();
    await expect(page.getByTestId('project-name')).toHaveAttribute('title', project);
    await expect(
      page.locator('[data-testid="tab"][data-path="index.html"] [role="tab"][aria-selected="true"]'),
    ).toBeVisible();
    for (const mark of ['upgrade-mark-1', 'upgrade-mark-2']) {
      await typeAtEnd(page, mark);
      await page.keyboard.press('ControlOrMeta+S');
      await expect.poll(() => readFile(path.join(project, 'index.html'), 'utf8')).toContain(mark);
      await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', /saved|clean/);
    }
  } finally {
    await quit(vN);
  }
  const settingsFile = JSON.parse(await readFile(path.join(userData(), 'settings.json'), 'utf8')) as {
    locale: string;
  };
  expect(settingsFile.locale).toBe('en');

  // --- vN+1 on the same app data: everything is there. ---
  const vN1 = await start(next!);
  try {
    const { page } = vN1;
    expect(await aboutVersion(page)).toBe(`Version ${nextVersion}`); // the setting (English) was kept
    await expect(page.getByTestId('settings-notice')).toHaveCount(0);
    // The session reopened the project and its tab.
    await expect(page.getByTestId('project-name')).toHaveAttribute('title', project);
    await expect(page.locator('[data-testid="tab"][data-path="index.html"]')).toBeVisible();
    // Local history from vN.
    await page.getByTestId('show-history').click();
    await expect(page.getByTestId('history-dialog')).toBeVisible();
    await expect(page.getByTestId('history-file').filter({ hasText: 'index.html' })).toBeVisible();
    expect(await page.getByTestId('history-version').count()).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('history-dialog')).toHaveCount(0);
    // Recent projects from vN.
    await projectMenu(page, 'close-project');
    await expect(page.getByTestId('welcome')).toBeVisible();
    await expect(page.getByTestId('welcome-recent-item').filter({ hasText: path.basename(project) })).toBeVisible();
  } finally {
    await quit(vN1);
  }

  // --- vN again (downgrade) on what vN+1 left: still readable, nothing reset. ---
  const again = await start(current!);
  try {
    const { page } = again;
    expect(await aboutVersion(page)).toBe(`Version ${pkg.version}`);
    await expect(page.getByTestId('settings-notice')).toHaveCount(0);
    await expect(page.getByTestId('welcome-recent-item').filter({ hasText: path.basename(project) })).toBeVisible();
  } finally {
    await quit(again);
  }

  // Nothing was backed up as corrupt or newer, and the project folder holds only the user's files.
  expect((await readdir(userData())).filter((n) => /corrupt|newer/.test(n))).toEqual([]);
  expect((await readdir(project)).filter((n) => /recovery|history|settings/.test(n))).toEqual([]);
});
