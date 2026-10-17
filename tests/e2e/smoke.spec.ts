import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { DOC_END } from './keys';
import { documentText, switchLanguage } from './project';

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
  // S47.2: without a project the welcome owns the window — the preview column exists but is hidden until a project opens.
  await expect(page.getByTestId('region-preview')).toBeHidden();
  await expect(page.getByTestId('region-problems')).toBeVisible();
  // …and by accessible role + zh-CN name (default locale)
  await expect(page.getByRole('banner', { name: '顶栏' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '文件' })).toBeVisible();
  await expect(page.getByRole('main', { name: '编辑器' })).toBeVisible();
  await expect(page.getByRole('region', { name: '预览' })).toBeHidden();
  await expect(page.getByRole('region', { name: '问题和控制台' })).toBeVisible();
});

test('Monaco highlights HTML with every request local (S02.4, S02.6)', async () => {
  await expect(page.locator('.monaco-editor')).toHaveCount(1);
  await expect.poll(() => documentText(page.locator('.monaco-editor'))).toContain('<h1 class="title">NoobIDE</h1>');
  // Tokenization is asynchronous; on a cold start (fresh app-data directory, no code cache) it can trail the text.
  const tokenClasses = () =>
    page.$$eval('.view-lines .view-line span span', (spans) => [
      ...new Set(spans.flatMap((s) => [...s.classList].filter((c) => /^mtk\d+$/.test(c)))),
    ]);
  await expect.poll(async () => (await tokenClasses()).length).toBeGreaterThanOrEqual(3); // tags, attributes, strings and text differ
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
  await page.keyboard.press(DOC_END);
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
      app: Object.keys(((w.noobide as { app?: object } | undefined)?.app ?? {}) as object),
      recovery: Object.keys(((w.noobide as { recovery?: object } | undefined)?.recovery ?? {}) as object),
      // S13 app data
      settings: Object.keys(((w.noobide as { settings?: object } | undefined)?.settings ?? {}) as object),
      logs: Object.keys(((w.noobide as { logs?: object } | undefined)?.logs ?? {}) as object),
      projectConfig: Object.keys(
        ((w.noobide as { projectConfig?: object } | undefined)?.projectConfig ?? {}) as object,
      ),
      recentProjects: Object.keys(
        ((w.noobide as { recentProjects?: object } | undefined)?.recentProjects ?? {}) as object,
      ),
      lifecycle: Object.keys(((w.noobide as { lifecycle?: object } | undefined)?.lifecycle ?? {}) as object),
      session: Object.keys(((w.noobide as { session?: object } | undefined)?.session ?? {}) as object),
      createProject: Object.keys(
        ((w.noobide as { createProject?: object } | undefined)?.createProject ?? {}) as object,
      ),
      history: Object.keys(((w.noobide as { history?: object } | undefined)?.history ?? {}) as object),
      walkthrough: Object.keys(((w.noobide as { walkthrough?: object } | undefined)?.walkthrough ?? {}) as object),
      problems: Object.keys(((w.noobide as { problems?: object } | undefined)?.problems ?? {}) as object),
      ai: Object.keys(((w.noobide as { ai?: object } | undefined)?.ai ?? {}) as object),
      aiHistory: Object.keys(((w.noobide as { aiHistory?: object } | undefined)?.aiHistory ?? {}) as object),
      annotations: Object.keys(((w.noobide as { annotations?: object } | undefined)?.annotations ?? {}) as object),
      checkpoints: Object.keys(((w.noobide as { checkpoints?: object } | undefined)?.checkpoints ?? {}) as object),
      fileOps: Object.keys(((w.noobide as { fileOps?: object } | undefined)?.fileOps ?? {}) as object),
    };
  });
  expect(probe).toEqual({
    require: 'undefined',
    process: 'undefined',
    inlineRan: false,
    violations: ['script-src-elem'],
    // S03.1: exactly the typed contract — no ipcRenderer, no generic send.
    bridge: [
      'apiVersion',
      'platform',
      'workspace',
      'app',
      'preview',
      'recovery',
      'settings',
      'logs',
      'notices',
      'projectConfig',
      'recentProjects',
      'lifecycle',
      'session',
      'portability', // S13.5: cross-platform transfer check (report only)
      'createProject',
      'history',
      'commands', // S24.2: command context + native menu choices
      'walkthrough',
      'problems', // S16.2: runtime problems of the preview (read-only list + clear resolved)
      'ai', // S31: AI assistant (decision 0025); the key is write-only, never returned
      'aiHistory', // S39: saved chats (app data, by project id) and token usage
      'annotations', // S41: preview annotations (decision 0030); targets stay in main, saved by pick id
      'checkpoints', // S56: project checkpoints (app data, decision 0041); restores go through the save pipeline
      'fileOps', // S52: move, copy, multi-select trash, image sizes; every path realpath-checked in main
    ],
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
      // S10.3: save elsewhere
      'saveCopy',
    ],
    // S10.6: close requests arrive as a listener registration only; the IPC event object never reaches the page.
    app: ['onCloseRequested', 'answerClose', 'closeDiscarding'],
    // S12: crash-recovery journal calls.
    // Decision 0033: crash copies of a moved or missing folder, by journal key (no path crosses the bridge).
    recovery: [
      'record',
      'discardSaved',
      'listPending',
      'openProject',
      'read',
      'discard',
      'clear',
      'readPending',
      'discardPending',
      'savePendingAs',
      'relocate',
      'relocateConfirm',
    ],
    // S13.1: settings in app data.
    settings: ['get', 'update'],
    // S13.6: open the log folder (no path crosses the bridge).
    logs: ['openFolder'],
    // S13.2: .noobide/project.json by project id.
    projectConfig: ['get', 'setEntry'],
    // S13.3: recent projects by opaque id (the welcome screen's shape) and closing a project.
    recentProjects: ['list', 'open', 'remove'],
    lifecycle: ['closeProject'],
    // S13.4: session restore (tabs by relative path, layout sizes).
    session: ['restore', 'tabs', 'saveTabs', 'saveLayout'],
    // S20.2: create-project wizard (locations are opaque ids chosen in main).
    createProject: ['options', 'chooseLocation', 'check', 'create'],
    // S21.3/S21.4: local history (files by project id + relative path, other histories by opaque key).
    history: [
      'files',
      'versions',
      'read',
      'beforeRestore',
      'beforeFormat',
      'restoreDeleted',
      'overview',
      'clear',
      'cleanup',
      'reveal',
      'groupBefore',
      'groupRecord',
      'groups',
      'groupUndone',
    ],
    // S23: onboarding walkthrough progress (step ids and short signatures only).
    walkthrough: ['get', 'save'],
    problems: ['list', 'clearResolved', 'onChanged'],
    // S31: AI keys, config, consent and requests (contract src/shared/ipc/ai-contract.ts).
    ai: [
      'status',
      'setKey',
      'clearKey',
      'testKey',
      'listModels',
      'setConfig',
      'setConsent',
      'request',
      'cancel',
      'resolveProposal',
      'previewSnapshot', // S38.2: what the running preview shows, built in main (decision 0026)
      'onEvent',
    ],
    // S39.1/S39.2: saved chats and token use (contract src/shared/ipc/ai-history-contract.ts).
    aiHistory: [
      'listChats',
      'getChat',
      'saveChat',
      'deleteChat',
      'deleteProjectChats',
      'countRecentChats',
      'deleteRecentChats',
      'usage',
      'setDailyBudget',
    ],
    // S41: preview annotations (contract src/shared/ipc/annotations-contract.ts).
    annotations: [
      'list',
      'pick',
      'cancelPick',
      'candidates',
      'regionShot',
      'resolve',
      'save',
      'update',
      'remove',
      'highlight',
      'context',
    ],
    // S56: project checkpoints (contract src/shared/ipc/checkpoints-contract.ts).
    checkpoints: ['list', 'create', 'rename', 'delete', 'compare', 'readText', 'restoreFile'],
    fileOps: [
      'moveEntries',
      'copyEntries',
      'trashEntries',
      'imageInfo',
      'chooseImport',
      'importEntries',
      'registerDropped',
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
  await switchLanguage(page);
  await expect(page.getByRole('navigation', { name: 'Files' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Files' })).toBeVisible();
  await switchLanguage(page);
  await expect(page.getByRole('navigation', { name: '文件' })).toBeVisible();
});

test('no console errors during the whole run (S02.6)', async () => {
  expect(consoleErrors).toEqual([]);
});
