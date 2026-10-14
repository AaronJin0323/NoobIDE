import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';

let app: ElectronApplication;
let page: Page;
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  app = await launchApp();
  page = await app.firstWindow();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  // Listeners attach after the first load; reload so every console message of a full start is observed.
  await page.reload();
  await page.locator('.monaco-editor .view-lines').waitFor();
});

test.afterAll(async () => {
  await app?.close();
});

test('opens one window titled NoobIDE from the noobide:// app origin (S02.1)', async () => {
  expect(await page.title()).toBe('NoobIDE');
  const titles = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
  expect(titles).toEqual(['NoobIDE']);
  expect(page.url()).toBe('noobide://app/index.html');
});

test('renders the five workbench regions (S02.3)', async () => {
  await expect(page.getByTestId('region-topbar')).toBeVisible();
  await expect(page.getByTestId('region-files')).toBeVisible();
  await expect(page.getByTestId('region-editor')).toBeVisible();
  await expect(page.getByTestId('region-preview')).toBeVisible();
  await expect(page.getByTestId('region-problems')).toBeVisible();
  // …and by accessible role + zh-CN name (default locale)
  await expect(page.getByRole('banner', { name: '顶栏' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '文件' })).toBeVisible();
  await expect(page.getByRole('main', { name: '编辑器' })).toBeVisible();
  await expect(page.getByRole('region', { name: '预览' })).toBeVisible();
  await expect(page.getByRole('region', { name: '问题和控制台' })).toBeVisible();
});

test('Monaco highlights HTML with every request local (S02.4, S02.6)', async () => {
  await expect(page.locator('.monaco-editor')).toHaveCount(1);
  await expect(page.locator('.view-lines')).toContainText('<h1 class="title">NoobIDE</h1>');
  const tokenClasses = await page.$$eval('.view-lines .view-line span span', (spans) => [
    ...new Set(spans.flatMap((s) => [...s.classList].filter((c) => /^mtk\d+$/.test(c)))),
  ]);
  expect(tokenClasses.length).toBeGreaterThanOrEqual(3); // tags, attributes, strings and text differ
  // The network guard blocks every http(s)/ws(s) request from the workbench; none may have been attempted.
  const blocked = await app.evaluate(
    () =>
      (globalThis as unknown as { __noobideTestHooks: { blockedRequests: unknown[] } }).__noobideTestHooks
        .blockedRequests,
  );
  expect(blocked).toEqual([]);
});

test('typing into the editor keeps highlighting (S02.4)', async () => {
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('<p class="x">hi</p>');
  await expect(page.locator('.view-lines')).toContainText('<p class="x">hi</p>');
});

test('renderer has no Node, eval is blocked by the CSP, webPreferences are secure (S02.2)', async () => {
  // DevTools-initiated evaluation is exempt from CSP, so let the page itself try to run an inline script and an
  // eval (via a script element) and record the CSP violations the browser reports.
  const errorsBefore = consoleErrors.length;
  const probe = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective));
    const inline = document.createElement('script');
    inline.textContent = 'window.__inlineRan = true; window.__evalRan = eval("true");';
    document.head.append(inline);
    await new Promise((r) => setTimeout(r, 300));
    const w = window as unknown as Record<string, unknown>;
    return {
      require: typeof w.require,
      process: typeof w.process,
      inlineRan: w.__inlineRan === true,
      violations: [...new Set(violations)],
      bridge: Object.keys((w.noobide ?? {}) as object),
      apiVersion: (w.noobide as { apiVersion?: unknown } | undefined)?.apiVersion,
      workspace: Object.keys(((w.noobide as { workspace?: object } | undefined)?.workspace ?? {}) as object),
    };
  });
  expect(probe).toEqual({
    require: 'undefined',
    process: 'undefined',
    inlineRan: false,
    violations: ['script-src-elem'],
    // S03.1: exactly the typed contract — no ipcRenderer, no generic send.
    bridge: ['apiVersion', 'platform', 'workspace'],
    apiVersion: 1,
    workspace: [
      'openFolder',
      'readFile',
      'writeFile',
      'revealProject',
      // S07/S08: file tree, watcher and file operations
      'listDir',
      'onChanged',
      'createEntry',
      'renameEntry',
      'trashEntry',
      'revealEntry',
    ],
  });

  // The violation we just provoked is logged as a console error; drop exactly those so the final check stays strict.
  const provoked = consoleErrors.splice(errorsBefore);
  expect(provoked.every((m) => m.includes('Content Security Policy'))).toBe(true);

  const prefs = await app.evaluate(({ BrowserWindow }) => {
    // getLastWebPreferences() exists at runtime but is missing from electron.d.ts; it reports the live values.
    const wc = BrowserWindow.getAllWindows()[0]?.webContents as unknown as {
      getLastWebPreferences(): Record<string, unknown> | null;
    };
    const p = wc.getLastWebPreferences();
    return (
      p && {
        contextIsolation: p.contextIsolation,
        nodeIntegration: p.nodeIntegration,
        sandbox: p.sandbox,
        webSecurity: p.webSecurity,
      }
    );
  });
  expect(prefs).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true });

  const csp = await page.evaluate(async () =>
    (await fetch('noobide://app/index.html')).headers.get('content-security-policy'),
  );
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self';");
});

test('language switch: zh-CN default, en on click, kept across a reload (S02.5)', async () => {
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await page.getByTestId('switch-language').click();
  await expect(page.getByRole('navigation', { name: 'Files' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Files' })).toBeVisible();
  await page.getByTestId('switch-language').click();
  await expect(page.getByRole('navigation', { name: '文件' })).toBeVisible();
});

test('no console errors during the whole run (S02.6)', async () => {
  expect(consoleErrors).toEqual([]);
});
