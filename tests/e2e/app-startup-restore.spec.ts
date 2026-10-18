import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, tempRoot } from './launch';
import { loadCpu } from './load-cpu';
import { launchInspected } from './inspector-launch';
import { copyFixture, openProject, waitForPreviewState } from './preview-helpers';

/**
 * S05.8: a preview restored at startup always leaves "Starting", with its page guard. Session 12 saw a restored
 * preview stay Starting under load (its first navigation held before any request). Playwright's DevTools connection to
 * every view hid that, so the restarts here run without Playwright: only the main process's Node inspector drives the
 * app (inspector-launch.ts). The machine is kept busy meanwhile: on an idle machine
 * the first document of a new view appears at once, under load it could take 30–45 s and the page then ran without its
 * guard (measured on Windows x64), which the pageGuarded check below catches.
 */
const RESTARTS = 5;

let fixture: { tmp: string; root: string };
let userData: string;

test.beforeAll(async () => {
  fixture = await copyFixture('预览 多文件');
  userData = await mkdtemp(path.join(tempRoot(), 'noobide-restore-userdata-'));
});

test.afterAll(async () => {
  await rm(fixture.tmp, { recursive: true, force: true }).catch(() => undefined);
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

const previewState = `globalThis.__noobideTestHooks.preview().status.state`;

test('a project reopened at startup gets a running preview every time, without Playwright attached (S05.8)', async () => {
  test.setTimeout(RESTARTS * 120_000 + 60_000);

  // First run (Playwright): open the project and trust its preview, then quit normally so the session is kept.
  const app = await launchApp({}, { userDataDir: userData });
  const page = await app.firstWindow();
  await openProject(app, page, fixture.root);
  // S14.4: opening a project offers an automatic start; wait for main's decision (consent asked, or started).
  const consent = page.getByTestId('preview-consent');
  await expect
    .poll(
      async () =>
        (await consent.count()) > 0 ? 'consent' : await page.getByTestId('preview-state').getAttribute('data-state'),
      { timeout: 30_000 },
    )
    .toMatch(/^(consent|starting|running)$/);
  if ((await consent.count()) > 0) await page.getByTestId('preview-consent-start').click();
  await waitForPreviewState(page, 'running', 60_000);
  await expect(page.getByTestId('project-name')).toHaveText(path.basename(fixture.root));
  await page.waitForTimeout(800); // the session is written 300 ms after the last change
  await app.close();

  const unload = loadCpu();
  try {
    for (let i = 0; i < RESTARTS; i += 1) await restartOnce(i);
  } finally {
    await unload();
  }
});

async function restartOnce(i: number) {
  const launched = Date.now();
  const restarted = await launchInspected(userData);
  try {
    await expect
      .poll(() => restarted.evaluate<string>(previewState).catch(() => 'no hooks yet'), {
        message: `restart ${i + 1}: the restored preview reaches running`,
        timeout: 90_000, // the product waits at most 30 s for the first document and 45 s for the guard
      })
      .toBe('running');
    // Evidence for S05.8's timing criterion, from launch to a running preview (shown in the e2e output).
    console.log(`S05.8 restart ${i + 1}: running after ${Date.now() - launched} ms`);
    // The page really loaded from the project's server, with the page guard (S05.7) in place.
    const loaded = await restarted.evaluate<{
      title: string;
      url: string;
      guarded: boolean | null;
      trace: unknown;
      noBackgrounding: boolean;
    }>(`(async () => {
      const info = globalThis.__noobideTestHooks.preview();
      const contents = process.mainModule.require('electron').webContents.fromId(info.previewWebContentsId);
      const { app } = process.mainModule.require('electron');
      return { title: await contents.executeJavaScript('document.title'), url: contents.getURL(), guarded: info.pageGuarded, trace: info.guardTrace, noBackgrounding: app.commandLine.hasSwitch('disable-renderer-backgrounding') };
    })()`);
    expect(loaded.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/index\.html$|^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(loaded.title).not.toBe('');
    // The preview's renderer is never lowered to background priority while its guard is installed (CHROMIUM_SWITCHES).
    expect(loaded.noBackgrounding).toBe(true);
    console.log(`S05.8 restart ${i + 1}: page guard ${JSON.stringify(loaded.trace)}`);
    expect(loaded.guarded, `restart ${i + 1}: page guard ${JSON.stringify(loaded.trace)}`).toBe(true);
  } finally {
    await restarted.quit();
  }
}
