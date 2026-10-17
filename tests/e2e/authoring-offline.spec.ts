import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { tempRoot } from './launch';
import { packagedExecutable } from './packaged';
import { documentText, focusEditor, openFile } from './project';
import { projectKey } from '../../src/recovery/keys';

/**
 * S53.5: the HTML/CSS authoring aids in the PACKAGED app with the network disabled — Emmet on Tab, linked tag
 * editing, the colour picker and the comment toggle, typed into the real workbench editor, and not one request leaves
 * the machine.
 *
 * The packaged binary has Node's inspector fused off (forge.config.ts), so Playwright's Electron driver cannot attach.
 * The test starts the binary itself and drives its window through Chromium's DevTools protocol on a loopback port.
 * The project opens through the normal session restore (a session.json in the run's own app-data folder).
 * "Network disabled": all of Chromium's traffic goes to a proxy on a closed loopback port and every name but localhost
 * resolves to "not found"; every resource the window loaded (Performance API, from its start) and every request seen
 * while driving it must be the app's own or loopback.
 */
test.describe.configure({ mode: 'serial' });

const OFFLINE_SWITCHES = [
  '--proxy-server=http://127.0.0.1:9',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
];

const PAGE = '<!DOCTYPE html>\n<html>\n<body>\n  <h1>标题</h1>\n</body>\n</html>\n';
const STYLE = 'h1 {\n  color: #c0392b;\n}\n';

let child: ChildProcess | undefined;
let browser: Browser | undefined;
let page: Page;
let tmp: string;
let root: string;
const requests: string[] = [];

/** A loopback port nobody listens on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** Whether a URL stays on this machine: the app's own schemes or a loopback host. */
function local(url: string): boolean {
  const parsed = new URL(url);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return true; // file:, data:, blob:, app schemes
  return ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
}

const editor = () => page.locator('.monaco-editor').first();
const onDisk = (name: string) => readFile(path.join(root, name), 'utf8');

test.beforeAll(async () => {
  const exe = packagedExecutable();
  test.skip(!exe, 'packaged app in out/ (npm run test:e2e packages first)');
  tmp = await mkdtemp(path.join(tempRoot(), 'noobide-authoring-offline-'));
  root = path.join(tmp, '离线 练习');
  await mkdir(root);
  await writeFile(path.join(root, 'index.html'), PAGE);
  await writeFile(path.join(root, 'style.css'), STYLE);
  const userData = path.join(tmp, 'userdata');
  await mkdir(userData);
  // The project the app "had open last time", with its tab: the normal session restore opens it.
  await writeFile(
    path.join(userData, 'session.json'),
    JSON.stringify({
      version: 1,
      lastProject: root,
      layout: null,
      projects: {
        [projectKey(root)]: { rootPath: root, savedAt: Date.now(), tabs: ['index.html'], active: 'index.html' },
      },
    }),
  );
  const port = await freePort();
  child = spawn(exe!, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, ...OFFLINE_SWITCHES], {
    stdio: 'ignore',
  });
  const endpoint = `http://127.0.0.1:${port}`;
  await expect
    .poll(
      () =>
        fetch(`${endpoint}/json/version`).then(
          (r) => r.ok,
          () => false,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  browser = await chromium.connectOverCDP(endpoint);
  await expect
    .poll(
      async () => {
        for (const context of browser!.contexts())
          for (const candidate of context.pages())
            if ((await candidate.locator('[data-testid="file-tree"]').count()) > 0) {
              page = candidate;
              return true;
            }
        return false;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  for (const context of browser.contexts()) context.on('request', (request) => requests.push(request.url()));
  await page.locator('[data-testid="tab"][data-path="index.html"] [role="tab"][aria-selected="true"]').waitFor();
});

test.afterAll(async () => {
  await browser?.close().catch(() => undefined);
  child?.kill();
  if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

test('Emmet, linked tags and the comment toggle work in the packaged app offline (S53.5)', async () => {
  // Emmet on Tab, on a new line inside <body>.
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowDown'); // the <h1> line
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('ul>li*2');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect.poll(() => documentText(editor())).toContain('<li></li>');
  await expect(page.getByTestId('emmet-hint')).toBeVisible();
  await page.keyboard.press('Escape');

  // Linked tag editing: "h1" → "h2" in the opening tag renames the closing tag.
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home'); // before "<h1>" (after the indentation)
  await page.keyboard.press('ArrowRight'); // after "<"
  await page.keyboard.press('ArrowRight'); // after "<h"
  await page.keyboard.press('Shift+ArrowRight'); // "1" selected
  await page.waitForTimeout(500); // linked editing ranges are computed after the cursor rests
  await page.keyboard.type('2');
  await expect.poll(() => documentText(editor())).toContain('<h2>标题</h2>');

  // Comment toggle on the same line.
  await page.keyboard.press('ControlOrMeta+Slash');
  await expect.poll(() => documentText(editor())).toContain('<!-- <h2>标题</h2> -->');
  await page.keyboard.press('ControlOrMeta+S');
  await expect.poll(() => onDisk('index.html')).toContain('<!-- <h2>标题</h2> -->');
  expect(await onDisk('index.html')).toContain('<li></li>');
});

test('the colour picker edits a CSS colour in the packaged app offline (S53.5)', async () => {
  await openFile(page, 'style.css');
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft'); // inside "#c0392b"
  await expect(editor().locator('.colorpicker-color-decoration')).toHaveCount(1);
  await expect(page.getByTestId('cursor-color-swatch')).toHaveAccessibleName('颜色：#c0392b');
  await page.getByTestId('cursor-color-edit').click();
  await expect(page.getByTestId('color-h')).toBeFocused();
  await page.getByTestId('color-value').fill('#2e86de');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('color-picker')).toBeHidden();
  await page.keyboard.press('ControlOrMeta+S');
  await expect.poll(() => onDisk('style.css')).toBe('h1 {\n  color: #2e86de;\n}\n');
});

test('nothing reached the network: every load and request stayed on the machine (S53.5)', async () => {
  // The page itself (navigation) and everything it loaded since it started (resources, workers included).
  const loaded = await page.evaluate(() =>
    [...performance.getEntriesByType('navigation'), ...performance.getEntriesByType('resource')].map((e) => e.name),
  );
  expect(loaded.length).toBeGreaterThan(0);
  expect([...loaded, ...requests].filter((url) => !local(url))).toEqual([]);
  // The cut is real: the same window cannot reach the internet.
  const outcome = await page.evaluate(() =>
    fetch('https://example.com/', { cache: 'no-store' }).then(
      () => 'reached',
      () => 'failed',
    ),
  );
  expect(outcome).toBe('failed');
});
