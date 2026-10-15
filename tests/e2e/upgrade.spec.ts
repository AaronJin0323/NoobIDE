import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { repoRoot, tempRoot } from './launch';
import { packagedExecutable } from './packaged';
import { typeAtEnd } from './project';

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

async function start(exe: string): Promise<Running> {
  const portFile = path.join(userData(), 'DevToolsActivePort');
  await rm(portFile, { force: true });
  const child = spawn(exe, ['--remote-debugging-port=0'], {
    env: { ...process.env, CFFIXED_USER_HOME: home },
    stdio: 'ignore',
  });
  let port = '';
  await expect
    .poll(async () => {
      port = existsSync(portFile) ? ((await readFile(portFile, 'utf8')).split('\n')[0] ?? '') : '';
      return port;
    })
    .not.toBe('');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page: Page | undefined;
  await expect
    .poll(() => {
      page = browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().startsWith('noobide://app/'));
      return page !== undefined;
    })
    .toBe(true);
  await page!.locator('.monaco-editor .view-lines').first().waitFor();
  return { child, browser, page: page! };
}

/** Quits the way the OS does on logout (SIGTERM → a normal app quit) and waits for the process to end. */
async function quit(app: Running): Promise<void> {
  await app.browser.close().catch(() => undefined);
  if (app.child.exitCode !== null) return;
  const exited = new Promise((resolve) => app.child.once('exit', resolve));
  app.child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 20_000))]);
  if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill('SIGKILL');
}

async function aboutVersion(page: Page): Promise<string> {
  await page.evaluate(() => window.dispatchEvent(new Event('noobide:open-about')));
  const text = (await page.getByTestId('about-version').textContent()) ?? '';
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('about-dialog')).toHaveCount(0);
  return text;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  home = await mkdtemp(path.join(tempRoot(), 'noobide-upgrade-home-'));
});

test.afterAll(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
});

test('packaged vN → vN+1 keeps settings, session, history and recent projects; vN again still reads them', async () => {
  test.skip(process.platform !== 'darwin', 'macOS packaged upgrade; Windows: harness/MANUAL-CHECKS.md#S28.4');
  test.setTimeout(240_000);
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
    await page.getByTestId('switch-language').click();
    expect(await aboutVersion(page)).toBe(`Version ${pkg.version}`);

    await page.getByTestId('welcome-create').click();
    project = ((await page.getByTestId('wizard-folder').textContent()) ?? '').trim();
    // (The app shows the temp folder as /var/…, a link to /private/var/….)
    const unprivate = (p: string) => p.replace(/^\/private\//, '/');
    expect(unprivate(project).startsWith(unprivate(path.join(home, 'Documents'))), project).toBe(true);
    project = path.join(home, path.relative(unprivate(home), unprivate(project))); // the real path the app opens
    await page.getByTestId('wizard-create').click();
    await expect(page.getByTestId('project-path')).toHaveText(project);
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
    await expect(page.getByTestId('project-path')).toHaveText(project);
    await expect(page.locator('[data-testid="tab"][data-path="index.html"]')).toBeVisible();
    // Local history from vN.
    await page.getByTestId('show-history').click();
    await expect(page.getByTestId('history-dialog')).toBeVisible();
    await expect(page.getByTestId('history-file').filter({ hasText: 'index.html' })).toBeVisible();
    expect(await page.getByTestId('history-version').count()).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('history-dialog')).toHaveCount(0);
    // Recent projects from vN.
    await page.getByTestId('app-menu').click();
    await page.getByTestId('menu-close-project').click();
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
