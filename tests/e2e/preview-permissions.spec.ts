import { rm } from 'node:fs/promises';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { collectConsoleErrors } from './project';
import { copyFixture, evalInPreview, openProject, previewInfo, waitForPreviewState } from './preview-helpers';

/**
 * S25.4 end to end: the preview page asks for every permission a web page can ask for — camera, microphone,
 * location, notifications, MIDI, clipboard, screen capture, HID/serial/USB/Bluetooth devices, fullscreen — and each
 * request is refused at once by the preview session (no OS prompt waits for an answer, the OS media permission state
 * is untouched, no window opens). The console explains each kind once, in the user's language, without blocking.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let consoleErrors: string[];
const temps: string[] = [];

interface Settled {
  outcome: 'granted' | 'denied' | 'timeout';
  value: string;
  ms: number;
}

interface RawRecord {
  source: string;
  level: string;
  message: string;
  notice?: { kind: string; permission?: string };
}

const mediaAccess = () =>
  app.evaluate(({ systemPreferences }) =>
    process.platform === 'linux'
      ? null
      : {
          camera: systemPreferences.getMediaAccessStatus('camera'),
          microphone: systemPreferences.getMediaAccessStatus('microphone'),
        },
  );

test.beforeAll(async () => {
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
});

test.afterAll(async () => {
  await app?.close();
  for (const tmp of temps) await rm(tmp, { recursive: true, force: true });
});

test('every permission request of the page is refused at once, without an OS prompt (S25.4)', async () => {
  const { tmp, root } = await copyFixture('预览 权限');
  temps.push(tmp);
  await openProject(app, page, root);
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
  const accessBefore = await mediaAccess();
  const windowsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

  const names = await evalInPreview<string[]>(app, 'window.permissionNames');
  expect(names).toEqual([
    'camera',
    'microphone',
    'location',
    'notifications',
    'midi',
    'clipboard',
    'screen',
    'hid',
    'serial',
    'usb',
    'bluetooth',
    'fullscreen',
  ]);
  const results: Record<string, Settled> = {};
  for (const name of names) {
    // Each request runs with a user gesture (evalInPreview), as a click on the page would.
    results[name] = await evalInPreview<Settled>(app, `window.requestPermission(${JSON.stringify(name)})`);
  }
  console.log(`permission requests: ${JSON.stringify(results)}`);
  for (const [name, result] of Object.entries(results)) {
    expect(result.outcome, name).toBe('denied');
    // Answered in main at once: nothing waited for a person to answer a system prompt.
    expect(result.ms, name).toBeLessThan(2_000);
  }
  expect(results['camera']?.value).toBe('NotAllowedError');
  expect(results['microphone']?.value).toBe('NotAllowedError');
  expect(results['location']?.value).toBe('PERMISSION_DENIED');
  expect(results['notifications']?.value).toBe('denied');
  expect(await evalInPreview<string>(app, 'Notification.permission')).toBe('denied');
  expect(results['midi']?.value).toBe('NotAllowedError');
  expect(results['screen']?.value).toBe('NotAllowedError');
  expect(results['hid']?.value).toBe('no-device');
  expect(results['serial']?.value).toBe('NotFoundError');
  expect(results['usb']?.value).toBe('NotFoundError');
  // Web Bluetooth is switched off for the preview: on macOS Chromium would touch CoreBluetooth before any
  // permission handler, and the system ends the whole IDE for that (crash reproduced before the fix).
  expect(results['bluetooth']?.value).toBe('unsupported:bluetooth');
  expect(results['fullscreen']?.value).toBe('not-fullscreen');
  // The page's own view of the permissions (permission check handler).
  const states = await evalInPreview<Record<string, string>>(
    app,
    `Promise.all(['camera', 'microphone', 'geolocation', 'notifications', 'midi'].map((name) =>
      navigator.permissions.query({ name }).then((s) => [name, s.state], () => [name, 'error']))).then(Object.fromEntries)`,
  );
  for (const [name, state] of Object.entries(states)) expect(state, name).not.toBe('granted');

  // No OS permission state changed and no window (prompt, chooser) opened.
  expect(await mediaAccess()).toEqual(accessBefore);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windowsBefore);
  expect((await previewInfo(app)).status.state).toBe('running');

  // Explained once per kind, as page notices (not problems), localised in the console.
  const records = ((await previewInfo(app)) as unknown as { recentRecords: RawRecord[] }).recentRecords;
  const notices = records.filter((r) => r.notice?.kind === 'permission-denied');
  const kinds = notices.map((r) => r.notice?.permission);
  console.log(`permission notices: ${JSON.stringify(kinds)}`);
  for (const kind of ['camera', 'microphone', 'location', 'notifications', 'midi', 'clipboard', 'screen']) {
    expect(kinds, kind).toContain(kind);
  }
  expect(new Set(kinds).size).toBe(kinds.length); // once per kind
  for (const r of notices) expect(r).toMatchObject({ source: 'page-load', level: 'warning' });

  const line = page.locator('.preview-console-line[data-notice="permission-denied"]');
  await expect(line.filter({ hasText: '网页请求了摄像头权限，预览中默认拒绝' })).toHaveCount(1);
  await expect(line.filter({ hasText: '位置（定位）' })).toHaveCount(1);
  await expect(line.first()).toContainText('警告'); // level spelled out, not colour alone

  // Asking again in the same page load adds no second notice.
  await evalInPreview(app, `window.requestPermission('camera')`);
  await expect(line.filter({ hasText: '摄像头权限' })).toHaveCount(1);
  expect(consoleErrors).toEqual([]);
  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');
});
