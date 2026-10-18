import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { collectConsoleErrors, makeProject, openFile, openProject, tabOf, treeRow, typeAtEnd } from './project';
import { DOC_END, DOC_START } from './keys';

/**
 * S09.1 model registry and S09.2 tab bar, end to end in the real editor: switching tabs keeps cursor, scroll,
 * folding and undo; closing disposes; tabs show unsaved / failed with icon and text; mouse and keyboard work.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const LONG_JS = [
  'function outer() {',
  "  const inner = 'inner body line';",
  '  return inner;',
  '}',
  ...Array.from({ length: 196 }, (_, i) => `const value${i + 5} = ${i + 5};`),
  "const lastLine = 'END OF FILE';",
].join('\n');

const lines = () => page.locator('.monaco-editor .view-lines');
const cursor = () => page.getByTestId('cursor-position');
const status = () => page.getByTestId('save-status');

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-tabs-'));
  await writeFile(path.join(root, 'long.js'), LONG_JS);
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
});

test.afterAll(async () => {
  await chmod(path.join(root, 'script.js'), 0o644).catch(() => undefined);
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('each opened file becomes a tab in a tablist with a single tab stop (S09.2)', async () => {
  await openFile(page, 'index.html');
  await openFile(page, 'style.css');
  await openFile(page, 'long.js');
  const tabs = page.getByRole('tablist', { name: '打开的文件' }).getByRole('tab');
  await expect(tabs).toHaveText(['index.html', 'style.css', 'long.js']);
  await expect(tabOf(page, 'long.js')).toHaveAttribute('aria-selected', 'true');
  expect(await tabs.evaluateAll((els) => els.map((el) => el.getAttribute('tabindex')))).toEqual(['-1', '-1', '0']);
  // Opening an open file again shows its tab instead of adding a second one.
  await treeRow(page, 'index.html').click();
  await expect(tabs).toHaveCount(3);
  await expect(tabOf(page, 'index.html')).toHaveAttribute('aria-selected', 'true');
});

test('folding, cursor and scroll position survive a tab switch (S09.1)', async () => {
  await tabOf(page, 'long.js').click();
  await expect(lines()).toContainText('inner body line');
  await page.locator('.margin-view-overlays .codicon-folding-expanded').first().click();
  await expect(lines()).not.toContainText('inner body line');
  await lines().click();
  await page.keyboard.press(DOC_END);
  await expect(cursor()).toHaveText('行 201, 列 32');
  await expect(lines()).toContainText('END OF FILE');
  await expect(lines()).not.toContainText('function outer');

  await tabOf(page, 'index.html').click();
  await expect(lines()).toContainText('你好，我是林小雨');
  await tabOf(page, 'long.js').click();
  await expect(cursor()).toHaveText('行 201, 列 32');
  await expect(lines()).toContainText('END OF FILE');
  await expect(lines()).not.toContainText('function outer');
  await lines().click();
  await page.keyboard.press(DOC_START);
  await expect(lines()).toContainText('function outer');
  await expect(lines()).not.toContainText('inner body line'); // still folded
});

test('the undo stack survives a tab switch (S09.1)', async () => {
  await tabOf(page, 'style.css').click();
  await typeAtEnd(page, 'UNDOME');
  await expect(lines()).toContainText('UNDOME');
  await tabOf(page, 'index.html').click();
  await expect(lines()).toContainText('你好，我是林小雨');
  await tabOf(page, 'style.css').click();
  await lines().click();
  for (let i = 0; i < 10 && ((await lines().textContent()) ?? '').includes('UNDOME'); i += 1) {
    await page.keyboard.press('ControlOrMeta+Z');
  }
  await expect(lines()).not.toContainText('UNDOME');
  await expect(lines()).toContainText('#2f5d43');
  // The undo is an edit like any other: it is saved, and disk matches the editor again.
  await page.keyboard.press('ControlOrMeta+S');
  await expect(status()).toHaveText('已保存');
  await expect.poll(() => readFile(path.join(root, 'style.css'), 'utf8')).not.toContain('UNDOME');
});

test('closing a tab disposes its model: reopening starts from disk with a fresh undo stack (S09.1)', async () => {
  await tabOf(page, 'style.css').click();
  await typeAtEnd(page, 'CLOSEME');
  await page.keyboard.press('ControlOrMeta+S');
  await expect(status()).toHaveText('已保存');
  await page.locator('[data-testid="tab"][data-path="style.css"] [data-testid="tab-close"]').click();
  await expect(tabOf(page, 'style.css')).toHaveCount(0);
  await openFile(page, 'style.css');
  await expect(lines()).toContainText('CLOSEME');
  await lines().click();
  await page.keyboard.press('ControlOrMeta+Z');
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(lines()).toContainText('CLOSEME');
  await expect(status()).toHaveText('无改动');
});

test('an unsaved tab says so with an icon and text (S09.2)', async () => {
  await tabOf(page, 'index.html').click();
  await lines().click();
  await page.keyboard.press(DOC_END);
  // An open IME composition holds autosave (S09.4), so the unsaved state stays visible for the assertion.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
  const state = page.locator('[data-testid="tab"][data-path="index.html"] [data-testid="tab-state"]');
  await expect(state).toHaveText('未保存');
  await expect(state.locator('svg')).toHaveCount(1);
  await expect(status()).toHaveText('未保存');
  await cdp.send('Input.insertText', { text: '你' });
  await expect(status()).toHaveText('已保存');
  await expect(state).toHaveCount(0);
  expect(await readFile(path.join(root, 'index.html'), 'utf8')).toContain('你');
  expect(await readFile(path.join(root, 'index.html'), 'utf8')).not.toContain('ni');
});

test('a failed save shows on its tab with an icon and text, not colour alone (S09.2)', async () => {
  const file = path.join(root, 'script.js');
  await openFile(page, 'script.js');
  await chmod(file, 0o444);
  await typeAtEnd(page, 'readonly edit');
  const state = page.locator('[data-testid="tab"][data-path="script.js"] [data-testid="tab-state"]');
  await expect(state).toHaveText('保存失败');
  await expect(state.locator('svg')).toHaveCount(1);
  await chmod(file, 0o644);
  await page.getByTestId('save-retry').click();
  await expect(state).toHaveCount(0);
  await expect(status()).toHaveText('已保存');
});

test('Ctrl+Tab and Ctrl+Shift+Tab cycle through tabs (S09.2)', async () => {
  await tabOf(page, 'index.html').click();
  const order = ['index.html', 'long.js', 'style.css', 'script.js'];
  await expect(page.getByRole('tab')).toHaveText(order);
  await page.keyboard.press('Control+Tab');
  await expect(tabOf(page, 'long.js')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+Shift+Tab');
  await page.keyboard.press('Control+Shift+Tab');
  await expect(tabOf(page, 'script.js')).toHaveAttribute('aria-selected', 'true');
});

test('arrow keys move between tabs and Delete closes the focused one (S09.2)', async () => {
  await tabOf(page, 'index.html').click();
  await tabOf(page, 'index.html').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabOf(page, 'long.js')).toBeFocused();
  await expect(tabOf(page, 'long.js')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(tabOf(page, 'script.js')).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(tabOf(page, 'script.js')).toHaveCount(0);
  await expect(tabOf(page, 'style.css')).toHaveAttribute('aria-selected', 'true');
  // The keyboard focus stays in the tab strip (on the tab shown next), so the arrows keep working.
  await expect(tabOf(page, 'style.css')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tabOf(page, 'long.js')).toBeFocused();
});

test('middle-click closes a tab (S09.2)', async () => {
  await tabOf(page, 'long.js').click({ button: 'middle' });
  await expect(tabOf(page, 'long.js')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveText(['index.html', 'style.css']);
});

test('when the tabs overflow the strip, the active tab is scrolled into view and every tab takes clicks (S09.2)', async () => {
  // The narrowest window that keeps the three-column layout (NARROW_QUERY is max-width 959px): with six tabs the strip
  // overflows on every platform and font.
  const original = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const bounds = win.getBounds();
    const [, height] = win.getContentSize();
    win.setContentSize(960, height ?? bounds.height);
    return bounds;
  });
  try {
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(960);
    const files = ['index.html', 'style.css', 'long.js', 'script.js', 'README.md', '子 文件夹/页面 二.html'];
    for (const file of files) await openFile(page, file);
    const bar = page.getByTestId('tab-bar');
    expect(await bar.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const fullyVisible = (relPath: string) =>
      page.locator(`[data-testid="tab"][data-path="${relPath}"]`).evaluate((tab) => {
        const strip = (tab.closest('[role="tablist"]') as HTMLElement).getBoundingClientRect();
        const r = tab.getBoundingClientRect();
        return r.left >= strip.left - 0.5 && r.right <= strip.right + 0.5;
      });
    await expect.poll(() => fullyVisible('子 文件夹/页面 二.html')).toBe(true);
    // An overflow cue on the side where tabs are hidden (a chevron, not colour alone); it scrolls the strip.
    await expect(page.getByTestId('tabs-scroll-start')).toBeEnabled();
    await expect(page.getByTestId('tabs-scroll-end')).toBeDisabled(); // nothing hidden on the right
    await page.getByTestId('tabs-scroll-start').click();
    await expect(page.getByTestId('tabs-scroll-end')).toBeEnabled();
    // Clicking along the strip, both ways: a click right after the strip scrolled must reach the tab (a macOS overlay
    // scrollbar once covered the lower half of the tabs and swallowed these clicks).
    for (const file of [...files].reverse().concat(files)) {
      await tabOf(page, file).click();
      await expect(tabOf(page, file)).toHaveAttribute('aria-selected', 'true');
      await expect.poll(() => fullyVisible(file)).toBe(true);
    }
  } finally {
    await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]?.setBounds(bounds), original);
  }
});

test('at the default 1280×800 window the tabs keep the header; Format and zoom sit behind Editor options', async () => {
  const original = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const bounds = win.getBounds();
    // The page's size: with no native title bar (S46.9) the window is its content, and Windows reports frameless
    // window sizes with a pixel of rounding at fractional scaling.
    win.setContentSize(1280, 800);
    return bounds;
  });
  try {
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280);
    for (const file of ['index.html', 'style.css', 'script.js']) await openFile(page, file);
    // The strip gets most of the editor header (it was 159 px next to History, Format and zoom). S49.5: the strip is
    // the tabs with their overflow controls (the chevrons and the All-tabs button shown while the tabs overflow).
    const widths = await page.evaluate(() => ({
      strip: document.querySelector('.tabs-strip')!.getBoundingClientRect().width,
      header: document.querySelector('.tabs-header')!.getBoundingClientRect().width,
    }));
    expect(widths.strip, JSON.stringify(widths)).toBeGreaterThan(widths.header * 0.55);
    for (const file of ['index.html', 'style.css', 'script.js']) await expect(tabOf(page, file)).toBeVisible();

    // Editor options from the keyboard: Enter opens it and moves focus in, Escape closes it and returns focus.
    const more = page.getByTestId('editor-more');
    const panel = page.getByTestId('editor-more-panel');
    await expect(more).toHaveAccessibleName('编辑器选项');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('format-document')).toBeFocused();
    await expect(panel.getByTestId('zoom-reset')).toHaveText('16');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab'); // format → zoom-out → zoom-reset → zoom-in
    await expect(panel.getByTestId('zoom-in')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(panel.getByTestId('zoom-reset')).toHaveText('17');
    await expect(panel).toBeVisible(); // zoom steps keep it open
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(more).toBeFocused();
    // Ctrl/Cmd+0 still works without the panel; a click outside closes an open panel.
    await page.keyboard.press('ControlOrMeta+0');
    await expect(page.getByTestId('zoom-reset')).toHaveText('16');
    await more.click();
    await expect(panel).toBeVisible();
    await page.getByTestId('project-name').click();
    await expect(panel).toBeHidden();
  } finally {
    await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]?.setBounds(bounds), original);
  }
});

test('no console errors during the tab run', async () => {
  expect(consoleErrors).toEqual([]);
});
