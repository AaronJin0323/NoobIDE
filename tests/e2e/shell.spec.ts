import { rm } from 'node:fs/promises';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { THEMES } from '../../src/renderer/theme/tokens';
import { launchApp } from './launch';
import { makeProject, openProject, switchLanguage } from './project';

const toRgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-shell-'));
  app = await launchApp();
  page = await app.firstWindow();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.locator('.monaco-editor .view-lines').waitFor();
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

async function setWindowSize(width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
    { width, height },
  );
  await page.waitForFunction((w) => window.innerWidth === w, width);
}

const background = (selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);

test('shell and editor follow the system colour scheme together (S30.1, S30.2)', async () => {
  const seen: Record<string, string> = {};
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await expect
      .poll(
        async () =>
          (await background('.monaco-editor .monaco-editor-background')) ===
          (await background('[data-testid="region-editor"]')),
      )
      .toBe(true);
    seen[scheme] = await background('[data-testid="region-editor"]');
  }
  expect(seen.dark).toBe(toRgb(THEMES.dark.panel));
  expect(seen.light).toBe(toRgb(THEMES.light.panel));
  expect(await background('body')).toBe(toRgb(THEMES.light.bg));
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('a language switch after a scheme change keeps the editor on the current theme (S30.2)', async () => {
  // Regression: re-creating the editor used the scheme from first mount, turning Monaco light inside a dark shell.
  const editorMatchesShell = async () =>
    (await background('.monaco-editor .monaco-editor-background')) ===
    (await background('[data-testid="region-editor"]'));
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await switchLanguage(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect.poll(editorMatchesShell).toBe(true);
    await switchLanguage(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect.poll(editorMatchesShell).toBe(true);
  }
});

test('problems is collapsed into the status strip and toggles from strip, rail and keyboard (S30.3)', async () => {
  const toggle = page.getByTestId('problems-toggle');
  const rail = page.getByTestId('rail-problems');
  const panel = page.getByTestId('problems-panel');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toBeHidden();

  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(rail).toHaveAttribute('aria-expanded', 'true');
  // Opening never moves focus into the panel.
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('problems-toggle');

  await toggle.press('Enter');
  await expect(panel).toBeHidden();
  await rail.focus();
  await rail.press('Space');
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('rail-problems');
  await rail.click();
  await expect(panel).toBeHidden();
});

test('rail toggles the files panel (S30.3)', async () => {
  const files = page.getByTestId('rail-files');
  await expect(files).toHaveAttribute('aria-pressed', 'true');
  await files.click();
  await expect(page.getByTestId('region-files')).toBeHidden();
  await expect(files).toHaveAttribute('aria-pressed', 'false');
  await files.press('Enter');
  await expect(page.getByTestId('region-files')).toBeVisible();
});

test('placeholder states are honest and every control works (S30.3)', async () => {
  await expect(page.getByTestId('sample-badge')).toHaveText('示例 · 未保存到磁盘');
  await expect(page.getByTestId('save-status')).toHaveText('没有打开的文件');
  // S47.2: nothing to preview without a project — the column is not shown instead of showing an empty stage.
  await expect(page.getByTestId('region-preview')).toBeHidden();
  await expect(page.getByTestId('problems-toggle')).toContainText('还没检查');
  await expect(page.getByText('没有发现问题')).toHaveCount(0);
  // Outside Monaco, the shell offers only controls that do something; none is disabled decoration.
  const buttons = page.locator('button:not(.monaco-editor button)');
  expect(await buttons.evaluateAll((els) => els.filter((b) => (b as HTMLButtonElement).disabled).length)).toBe(0);
  expect(
    await buttons.evaluateAll((els) => els.map((b) => b.getAttribute('data-testid') ?? b.getAttribute('aria-label'))),
  ).toEqual([
    'open-palette', // S40.5: command search (opens the command palette)
    'app-menu', // S13 / S47.4: the help/more menu at the end of the bar (theme, language, glossary, logs, settings)
    'rail-files',
    'rail-problems',
    'rail-lessons', // key features: the beginner walkthrough has its own labelled rail button
    'rail-ai', // S33: AI is on by default (decision 0025); without a key the panel explains how to add one
    // S20.2: welcome screen while no project is open (S47.2: it owns Open folder; the files panel has no button)
    'welcome-create',
    'welcome-open-folder',
    'welcome-lessons', // S47.2: Lessons stays reachable from the welcome
    'editor-more', // Editor options: the code font size (and Format, with a file open) in a small panel
    'zoom-out',
    'zoom-reset',
    'zoom-in',
    '收起问题面板',
    'problems-toggle',
    // S43.2 / S47.5: the file's indentation (opens the indentation menu, tests/e2e/smart-editing.spec.ts) at the end
    // of the status strip, after the Problems toggle
    'indent-status',
  ]);
});

/** Bounding boxes of the top-bar controls that must not move when a project opens (S47.2). */
async function topBarBoxes() {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    const bar = document.querySelector('[data-testid="region-topbar"]');
    if (!bar) return out;
    out.topbar = JSON.stringify(bar.getBoundingClientRect());
    for (const id of ['save-status', 'open-palette', 'app-menu']) {
      out[id] = JSON.stringify(bar.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect());
    }
    for (const cls of ['app-mark', 'app-name', 'save-group']) {
      out[cls] = JSON.stringify(bar.querySelector(`.${cls}`)?.getBoundingClientRect());
    }
    return out;
  });
}

for (const [width, height] of [
  [1280, 800],
  [640, 480],
] as const) {
  test(`S47.2: at ${width}x${height} the welcome owns the window — one filled button, no preview column`, async () => {
    await setWindowSize(width, height);
    const welcome = page.getByTestId('welcome');
    await expect(welcome).toBeVisible();
    // The welcome's column spans the editor + preview area: no preview column, no editor splitter, no switch.
    await expect(page.getByTestId('region-preview')).toBeHidden();
    await expect(page.getByTestId('splitter-editor')).toHaveCount(0);
    await expect(page.getByTestId('narrow-switch')).toHaveCount(0);
    const editor = await page.getByTestId('region-editor').boundingBox();
    const welcomeBox = await welcome.boundingBox();
    expect(editor).not.toBeNull();
    expect(editor!.x + editor!.width).toBeGreaterThanOrEqual(width - 12); // up to the window's right gutter
    expect(welcomeBox!.width).toBeGreaterThanOrEqual(editor!.width - 24);
    // The sample code is still there, below the welcome (Monaco renders only the lines that fit: the first one).
    await expect(page.locator('.view-lines')).toContainText('<!doctype html>');
    await expect(page.getByTestId('sample-badge')).toBeVisible();

    // Exactly one filled button in the whole window: Create my first webpage. Open folder is secondary and lives on
    // the welcome only (the files panel's empty state has no button); Lessons is reachable from the welcome.
    const filled = page.locator('.primary-button, .save-button');
    await expect(filled).toHaveCount(1);
    await expect(filled).toHaveAttribute('data-testid', 'welcome-create');
    await expect(page.getByTestId('welcome-open-folder')).toHaveClass(/secondary-button/);
    await expect(page.getByTestId('region-files').locator('.empty-state button')).toHaveCount(0);
    await expect(page.getByTestId('open-folder')).toHaveCount(0);
    await expect(page.getByTestId('welcome-lessons')).toHaveText('课程');

    // "The sample is not saved" is said once: the badge next to the sample tab, not the top bar nor the welcome.
    await expect(page.getByText(/保存到磁盘|不会保存/)).toHaveCount(1);
    // S47.4: no project, no project menu and no folder tooltip on the name.
    await expect(page.getByTestId('project-menu')).toHaveCount(0);
    expect(await page.getByTestId('project-name').getAttribute('title')).toBeNull();
  });
}

test('S47.2: narrow window without a project: files collapse into the drawer, the welcome keeps the column', async () => {
  await setWindowSize(800, 600);
  await expect(page.getByTestId('region-files')).toBeHidden();
  await expect(page.getByTestId('region-editor')).toBeVisible();
  await expect(page.getByTestId('narrow-switch')).toHaveCount(0);
  await page.getByTestId('rail-files').click();
  await expect(page.getByTestId('region-files')).toBeVisible();
  await page.getByTestId('rail-files').click();
  await expect(page.getByTestId('region-files')).toBeHidden();
  await setWindowSize(1280, 800);
  await expect(page.getByTestId('region-files')).toBeVisible();
});

test('S47.2: the Lessons button on the welcome opens the walkthrough', async () => {
  await page.getByTestId('welcome-lessons').click();
  await expect(page.getByTestId('walkthrough')).toBeVisible();
  await page.getByTestId('walkthrough-close').click();
  await expect(page.getByTestId('walkthrough')).toHaveCount(0);
});

test('S47.2: opening a project reveals the workbench without a top-bar layout jump (S30.3 split kept)', async () => {
  const before = await topBarBoxes();
  await openProject(app, page, root);
  await expect(page.getByTestId('welcome')).toHaveCount(0);
  await expect(page.getByTestId('region-preview')).toBeVisible();
  await expect(page.getByTestId('project-name')).toHaveAttribute('title', root);
  const after = await topBarBoxes();
  expect(after).toEqual(before);
  // S30.3: editor and preview split the remaining width equally.
  const editor = await page.getByTestId('region-editor').boundingBox();
  const preview = await page.getByTestId('region-preview').boundingBox();
  expect(Math.abs((editor?.width ?? 0) - (preview?.width ?? -10))).toBeLessThanOrEqual(1);
});

test('S47.4: the path is a tooltip and a project-menu line, the language lives in the help menu, nothing moves', async () => {
  const bar = page.getByTestId('region-topbar');
  // Not a line of the bar: the path shows on hover (title) and in the project menu only.
  await expect(bar.locator('.project-detail')).toHaveCount(0);
  await expect(bar.getByText(root)).toHaveCount(0);
  await expect(page.getByTestId('project-name')).toHaveText('中文 路径 项目');
  await expect(page.getByTestId('project-name')).toHaveAttribute('title', root);
  await expect(page.getByTestId('switch-language')).toHaveCount(0);
  await expect(page.getByTestId('reveal-project')).toHaveCount(0);

  const before = await topBarBoxes();
  // The project menu: the folder line, then close, reveal, history, lessons.
  await page.getByTestId('project-menu').click();
  const projectMenu = page.locator('#project-menu-list');
  await expect(projectMenu).toBeVisible();
  await expect(projectMenu.getByTestId('project-path')).toHaveText(root);
  await expect(projectMenu.getByRole('menuitem')).toHaveText([
    /^关闭项目$/,
    /显示$/,
    /^历史版本…$/,
    /^项目检查点…$/, // S56.2
    /^课程$/,
  ]);
  await projectMenu.getByTestId('menu-help-walkthrough').click();
  await expect(page.getByTestId('walkthrough')).toBeVisible();
  await page.getByTestId('walkthrough-close').click();
  await expect(page.getByTestId('walkthrough')).toHaveCount(0);

  // The help/more menu at the end of the bar: theme and language are radio choices; the language switch works.
  await page.getByTestId('app-menu').click();
  const helpMenu = page.locator('#app-menu-list');
  await expect(helpMenu).toBeVisible();
  await expect(helpMenu.getByRole('menuitemradio')).toHaveText([
    /跟随系统/, // the current choice carries a ✓ (S24.4)
    /^浅色主题$/,
    /^深色主题$/,
    /中文$/,
    /^English$/,
    /宽松密度$/, // S50.4: the density choice (comfortable is the default, checked)
    /^紧凑密度$/,
  ]);
  await expect(helpMenu.getByTestId('menu-language-zh-CN')).toHaveAttribute('aria-checked', 'true');
  await helpMenu.getByTestId('menu-language-en').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByTestId('rail-files')).toHaveText('Files');
  await expect(page.getByTestId('app-menu')).toHaveAttribute('title', 'Help and more');
  await page.getByTestId('app-menu').click();
  await expect(helpMenu.getByTestId('menu-language-en')).toHaveAttribute('aria-checked', 'true');
  await helpMenu.getByTestId('menu-language-zh-CN').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByTestId('rail-files')).toHaveText('文件');
  // Opening and closing the menus and switching the language back left every top-bar box where it was.
  expect(await topBarBoxes()).toEqual(before);
});

test('narrow window: files collapse and a Code / Preview switch shows one view (S30.4)', async () => {
  await setWindowSize(800, 600);
  const narrowSwitch = page.getByTestId('narrow-switch');
  const code = narrowSwitch.getByRole('button', { name: '代码' });
  const preview = narrowSwitch.getByRole('button', { name: '预览' });
  await expect(narrowSwitch).toBeVisible();
  await expect(page.getByTestId('region-files')).toBeHidden();
  await expect(page.getByTestId('region-editor')).toBeVisible();
  await expect(page.getByTestId('region-preview')).toBeHidden();
  await expect(code).toHaveAttribute('aria-pressed', 'true');

  await preview.click();
  await expect(preview).toHaveAttribute('aria-pressed', 'true');
  await expect(code).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('region-preview')).toBeVisible();
  await expect(page.getByTestId('region-editor')).toBeHidden();

  await page.getByTestId('rail-files').click();
  await expect(page.getByTestId('region-files')).toBeVisible();
  await code.press('Enter');
  await expect(page.getByTestId('region-files')).toBeHidden();
  await expect(page.getByTestId('region-editor')).toBeVisible();

  await setWindowSize(1280, 800);
  await expect(narrowSwitch).toBeHidden();
  await expect(page.getByTestId('region-files')).toBeVisible();
  await expect(page.getByTestId('region-preview')).toBeVisible();
});

test('no console errors during the shell run', async () => {
  expect(consoleErrors).toEqual([]);
});
