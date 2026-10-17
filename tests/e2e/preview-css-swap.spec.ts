import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, tempRoot } from './launch';
import { collectConsoleErrors, openFile } from './project';
import { evalInPreview, openProject, previewInfo, replaceEditorText, waitForPreviewState } from './preview-helpers';

/**
 * S54 end to end (docs/decisions/0037): a save that touches only linked stylesheets updates them in place — no
 * navigation, typed input and scroll position survive — through the page guard's protocol session; everything else
 * is a full reload, and the toolbar says which happened. Project path with Chinese characters and spaces.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[] = [];

const THEME = '样式 表/主题.css';
const INDEX = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>样式热更新</title>
<link rel="stylesheet" href="样式 表/主题.css">
<link rel="stylesheet" href="with-import.css">
</head>
<body>
<h1 id="title">标题</h1>
<h2 id="sub">副标题</h2>
<label>名字 <input id="name"></label>
<div style="height: 3000px"></div>
<script src="app.js"></script>
</body>
</html>
`;
// Counts every DOM change the page could observe; a style swap must cause none.
const APP_JS = `window.__mutations = 0;
new MutationObserver((list) => { window.__mutations += list.length; }).observe(document, {
  subtree: true, childList: true, attributes: true, characterData: true,
});
document.body.dataset.ready = 'yes';
`;

async function makeSite(): Promise<string> {
  const site = path.join(tmp, '网页 练习', '样式 项目');
  await mkdir(path.join(site, '样式 表'), { recursive: true });
  await writeFile(path.join(site, 'index.html'), INDEX);
  await writeFile(path.join(site, 'app.js'), APP_JS);
  await writeFile(path.join(site, THEME), '#title { color: rgb(255, 0, 0); }\n');
  await writeFile(path.join(site, 'with-import.css'), '@import url("deep.css");\n');
  await writeFile(path.join(site, 'deep.css'), '#sub { color: rgb(1, 2, 3); }\n');
  await writeFile(path.join(site, 'unused.css'), 'p { color: red; }\n');
  return site;
}

const info = () => previewInfo(app) as Promise<Awaited<ReturnType<typeof previewInfo>> & Record<string, unknown>>;
const navigations = async () => (await info()).navigations as number;
const cssSwaps = async () => (await info()).cssSwaps as number;
const timeOrigin = () => evalInPreview<number>(app, 'performance.timeOrigin');
const titleColor = () => evalInPreview<string>(app, `getComputedStyle(document.getElementById('title')).color`);
const update = () => page.getByTestId('preview-save-update');

async function saveFile(relPath: string, text: string, saved = '已保存'): Promise<void> {
  await openFile(page, relPath);
  await replaceEditorText(app, page, text);
  await page.keyboard.press('ControlOrMeta+S');
  await expect(page.getByTestId('save-status')).toHaveText(saved);
}

/** Types into the page's input the way a user would (text input into the focused element, not a script). */
async function typeIntoPage(text: string): Promise<void> {
  await evalInPreview(app, `document.getElementById('name').focus()`);
  const id = (await previewInfo(app)).previewWebContentsId;
  await app.evaluate(
    ({ webContents }, [wcId, value]) => webContents.fromId(wcId as number)?.insertText(value as string),
    [id, text] as const,
  );
}

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(tempRoot(), 'noobide-css-e2e-'));
  root = await makeSite();
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
  await expect.poll(() => evalInPreview<string>(app, 'document.body.dataset.ready ?? ""')).toBe('yes');
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('a CSS-only save swaps the linked stylesheet: no navigation, typed input and scroll survive (S54.2)', async () => {
  expect(await titleColor()).toBe('rgb(255, 0, 0)');
  await typeIntoPage('张三');
  expect(await evalInPreview<string>(app, `document.getElementById('name').value`)).toBe('张三');
  await evalInPreview(app, 'window.scrollTo(0, 800)');
  await expect.poll(() => evalInPreview<number>(app, 'Math.round(window.scrollY)')).toBe(800);
  const loaded = await timeOrigin();
  const navs = await navigations();
  const mutations = await evalInPreview<number>(app, 'window.__mutations');
  const generation = await page.getByTestId('preview-state').getAttribute('data-generation');

  await saveFile(THEME, '#title { color: rgb(0, 128, 0); background-image: url("../图.svg"); }\n');
  await expect.poll(titleColor, { timeout: 5_000 }).toBe('rgb(0, 128, 0)');
  await expect(update()).toHaveAttribute('data-kind', 'styles');
  await expect(update()).toContainText('样式已更新（页面没有重新加载）');

  // No navigation of any kind: same document, same load counter, nothing the page could observe.
  expect(await timeOrigin()).toBe(loaded);
  expect(await navigations()).toBe(navs);
  expect(await cssSwaps()).toBe(1);
  await expect(page.getByTestId('preview-state')).toHaveAttribute('data-generation', generation ?? '');
  expect(await evalInPreview<string>(app, `document.getElementById('name').value`)).toBe('张三');
  expect(await evalInPreview<number>(app, 'Math.round(window.scrollY)')).toBe(800);
  expect(await evalInPreview<number>(app, 'window.__mutations')).toBe(mutations);
  // The <link> is untouched and the sheet keeps its URL, so relative url(...) resolves against the CSS file.
  const origin = (await previewInfo(app)).origin ?? '';
  expect(await evalInPreview<string>(app, `document.querySelector('link').getAttribute('href')`)).toBe(
    '样式 表/主题.css',
  );
  expect(await evalInPreview<string>(app, `getComputedStyle(document.getElementById('title')).backgroundImage`)).toBe(
    `url("${origin}/${encodeURI('图.svg')}")`,
  );
  // Still isolated: no Node, no IDE bridge, no new globals of ours in the page.
  expect(
    await evalInPreview<string[]>(
      app,
      `[typeof require, typeof process, typeof window.noobide, typeof window.electron].concat(
        Object.keys(window).filter((k) => /noobide|devtools/i.test(k)))`,
    ),
  ).toEqual(['undefined', 'undefined', 'undefined', 'undefined']);
  await waitForPreviewState(page, 'running');
});

/** Waits for the reload a save caused and checks the reason the toolbar gives. */
async function expectReload(loaded: number, reason: string): Promise<void> {
  await expect.poll(timeOrigin, { timeout: 5_000 }).not.toBe(loaded);
  await waitForPreviewState(page, 'running');
  await expect(update()).toHaveAttribute('data-kind', 'reload');
  await expect(update()).toHaveAttribute('data-reason', reason);
  await expect.poll(() => evalInPreview<string>(app, 'document.body.dataset.ready ?? ""')).toBe('yes');
}

interface ListedProblem {
  originalMessage: string;
  file?: string;
  line?: number;
  stale?: boolean;
}

/** The problems list exactly as the workbench gets it over the restricted bridge. */
const problems = () =>
  page.evaluate(async () => {
    const bridge = (
      window as unknown as { noobide: { problems: { list(): Promise<{ ok: boolean; value?: ListedProblem[] }> } } }
    ).noobide;
    const result = await bridge.problems.list();
    return result.ok ? [...(result.value ?? [])] : [];
  });

test('a save with HTML or JavaScript reloads, and the toolbar says so (S54.3)', async () => {
  await typeIntoPage('李四');
  let loaded = await timeOrigin();
  await saveFile('index.html', INDEX.replace('<h1 id="title">标题</h1>', '<h1 id="title">新标题</h1>'));
  await expectReload(loaded, 'not-css');
  await expect(update()).toContainText('页面已重新加载');
  await expect(update()).toHaveAttribute('title', '保存的文件里有 HTML、JavaScript 或其他文件，需要重新加载。');
  // A reload starts over: the typed text is gone (this is what the swap avoids).
  expect(await evalInPreview<string>(app, `document.getElementById('name').value`)).toBe('');
  loaded = await timeOrigin();
  await saveFile('app.js', `${APP_JS}// changed\n`);
  await expectReload(loaded, 'not-css');
});

test('CSS the swap cannot handle reloads: @import chains and files the page does not link (S54.3)', async () => {
  let loaded = await timeOrigin();
  await saveFile('with-import.css', '@import url("deep.css");\n/* changed */\n');
  await expectReload(loaded, 'import');
  // deep.css is linked only through the @import of another sheet.
  loaded = await timeOrigin();
  await saveFile('deep.css', '#sub { color: rgb(4, 5, 6); }\n');
  await expectReload(loaded, 'import');
  expect(await evalInPreview<string>(app, `getComputedStyle(document.getElementById('sub')).color`)).toBe(
    'rgb(4, 5, 6)',
  );
  loaded = await timeOrigin();
  await saveFile('unused.css', 'p { color: blue; }\n');
  await expectReload(loaded, 'not-linked');
  await expect(update()).toHaveAttribute('title', '页面没有用 <link> 引用保存的 CSS 文件。');
});

test('fault: broken CSS or a failed swap reloads and the problem reaches Problems (S54.3)', async () => {
  let loaded = await timeOrigin();
  const swaps = await cssSwaps();
  await saveFile(THEME, '#title {\n  color: rgb(0, 0, 255);\n');
  await expectReload(loaded, 'syntax');
  await expect(update()).toHaveAttribute('title', 'CSS 里有语法错误，请看“问题”面板。');
  expect(await cssSwaps()).toBe(swaps);
  const isSyntax = (p: ListedProblem) =>
    p.originalMessage.startsWith('NoobIDE：') && p.originalMessage.includes('语法错误');
  await expect.poll(async () => (await problems()).find(isSyntax)).toMatchObject({ file: THEME, line: 1 });
  const syntax = (await problems()).find(isSyntax);
  expect(syntax?.stale).not.toBe(true); // it belongs to the page load that is showing
  expect(syntax?.originalMessage).not.toContain('rgb('); // names file and line, never the CSS itself

  // A swap that fails (fault injection: as if a protocol command failed) reloads too, and says so.
  await app.evaluate(() =>
    (globalThis as unknown as { __noobideTestHooks: { failNextCssSwap(): void } }).__noobideTestHooks.failNextCssSwap(),
  );
  loaded = await timeOrigin();
  await saveFile(THEME, '#title { color: rgb(0, 0, 255); }\n');
  await expectReload(loaded, 'failed');
  expect(await titleColor()).toBe('rgb(0, 0, 255)');
  await expect
    .poll(async () => (await problems()).some((p) => p.originalMessage.startsWith('NoobIDE：没能直接换上')))
    .toBe(true);

  // Fixed CSS swaps again.
  loaded = await timeOrigin();
  await saveFile(THEME, '#title { color: rgb(0, 128, 0); }\n');
  await expect.poll(titleColor, { timeout: 5_000 }).toBe('rgb(0, 128, 0)');
  await expect(update()).toHaveAttribute('data-kind', 'styles');
  expect(await timeOrigin()).toBe(loaded);
});

test('en: the toolbar says "Styles updated" or "Page reloaded" (S54.3)', async () => {
  await page.getByTestId('switch-language').click();
  try {
    let loaded = await timeOrigin();
    await saveFile(THEME, '#title { color: rgb(10, 20, 30); }\n', 'Saved');
    await expect.poll(titleColor, { timeout: 5_000 }).toBe('rgb(10, 20, 30)');
    await expect(update()).toContainText('Styles updated (page not reloaded)');
    expect(await timeOrigin()).toBe(loaded);
    await saveFile('index.html', INDEX, 'Saved');
    await expectReload(loaded, 'not-css');
    await expect(update()).toContainText('Page reloaded');
    await expect(update()).toHaveAttribute('title', 'The save included HTML, JavaScript or other files.');
    loaded = await timeOrigin();
    await saveFile(THEME, '#title { color: rgb(10, 20, 30);\n', 'Saved');
    await expectReload(loaded, 'syntax');
    await expect(update()).toHaveAttribute('title', 'The CSS has a syntax error; see Problems.');
  } finally {
    await page.getByTestId('switch-language').click(); // back to zh-CN
  }
  await saveFile(THEME, '#title { color: rgb(0, 128, 0); }\n');
  await expect.poll(titleColor, { timeout: 5_000 }).toBe('rgb(0, 128, 0)');
});

test('manual refresh mode waits for the user; the swap respects it (S54.3)', async () => {
  const auto = page.getByTestId('preview-auto-refresh');
  await auto.uncheck();
  await expect
    .poll(() => readFile(path.join(root, '.noobide', 'project.json'), 'utf8').catch(() => ''))
    .toContain('autoRefresh');
  try {
    const loaded = await timeOrigin();
    const swaps = await cssSwaps();
    await saveFile(THEME, '#title { color: rgb(200, 100, 0); }\n');
    await expect(page.getByTestId('preview-state')).toHaveAttribute('data-outdated', 'true');
    await page.waitForTimeout(1_500);
    expect(await titleColor()).toBe('rgb(0, 128, 0)');
    expect(await cssSwaps()).toBe(swaps);
    expect(await timeOrigin()).toBe(loaded);
    // The user's Refresh is a full reload, as before; it is not an update after a save, so there is no note.
    await page.getByTestId('preview-reload').click();
    await expect.poll(timeOrigin).not.toBe(loaded);
    await waitForPreviewState(page, 'running');
    expect(await titleColor()).toBe('rgb(200, 100, 0)');
    await expect(update()).toHaveCount(0);
  } finally {
    await auto.check();
  }
});

test('no console errors in the workbench during the CSS swap run', () => {
  expect(consoleErrors).toEqual([]);
});
