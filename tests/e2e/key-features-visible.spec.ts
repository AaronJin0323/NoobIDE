import { chmod, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { collectConsoleErrors, makeProject, openFile, openProject, treeRow, typeAtEnd } from './project';

/**
 * Key features are never pushed off screen (owner request): with the walkthrough band and the Problems panel open,
 * the status strip, the Problems toggle, the Save button, the rail buttons and the walkthrough's Back / Next stay fully
 * inside the window — at a common laptop size and down to the 640×480 minimum window. The top-bar Save button saves
 * through the same path as Ctrl+S, and a narrow window offers New file without opening the files drawer first.
 * S47.3: the save state lives in a fixed slot and the Save button shows only while a save cannot happen on its own,
 * so nothing in the top bar or the tab strip moves during a typing → autosave cycle.
 * S50.4: the window-size checks run at both densities; the compact one is chosen from the palette and the
 * comfortable one again from the native View menu, both persisted in the settings.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-key-features-'));
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await openFile(page, 'index.html');
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

async function setContentSize(width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
    { width, height },
  );
  // At the minimum size a frameless Windows window (S46.9) can round up by a pixel or two at fractional scaling
  // (150 %: 640×480 becomes 640×482); never smaller than asked.
  await page.waitForFunction(
    (size) =>
      window.innerWidth >= size.width &&
      window.innerWidth <= size.width + 2 &&
      window.innerHeight >= size.height &&
      window.innerHeight <= size.height + 2,
    { width, height },
  );
}

/** The element's whole box is inside the window's viewport. */
async function expectInViewport(locator: Locator, what: string) {
  await expect(locator, what).toBeVisible();
  const inside = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.left >= 0 &&
      r.top >= 0 &&
      r.right <= window.innerWidth + 0.5 &&
      r.bottom <= window.innerHeight + 0.5
    );
  });
  expect(inside, `${what} is fully inside the window`).toBe(true);
}

/**
 * Bounding boxes of every element of the top bar and of the tab strip, keyed by its place in the DOM, with the save
 * state they were taken in (one evaluate, so the state and the boxes belong together).
 */
async function chromeBoxes() {
  return page.evaluate(() => {
    const boxes: Record<string, string> = {};
    const walk = (el: Element, key: string) => {
      const r = el.getBoundingClientRect();
      boxes[key] = [r.left, r.top, r.width, r.height].map((n) => n.toFixed(1)).join(',');
      if (el.tagName.toLowerCase() === 'svg') return; // an icon's box is the element; the drawing inside is not layout
      Array.from(el.children).forEach((child, i) => walk(child, `${key}/${i}:${child.tagName.toLowerCase()}`));
    };
    const topbar = document.querySelector('[data-testid="region-topbar"]');
    const tabs = document.querySelector('.tabs-strip');
    if (topbar) walk(topbar, 'topbar');
    if (tabs) walk(tabs, 'tabs');
    return { state: document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state'), boxes };
  });
}

test('S47.3: the Save button shows only while a save cannot happen on its own, and saves like Ctrl+S', async () => {
  const status = page.getByTestId('save-status');
  await expect(page.getByTestId('topbar-save')).toHaveCount(0);
  // Ordinary typing: the state word changes in its slot and the file saves itself; no button flashes.
  await typeAtEnd(page, 'AUTOSAVED');
  await expect(status).toHaveAttribute('data-state', /^(dirty|saving|saved)$/);
  await expect(page.getByTestId('topbar-save')).toHaveCount(0);
  await expect(status).toHaveText('已保存');
  await expect(page.getByTestId('topbar-save')).toHaveCount(0);
  await expect.poll(() => readFile(path.join(root, 'index.html'), 'utf8')).toContain('AUTOSAVED');

  // A save that failed needs the user: the Save button appears (short pill word; the sentence is in the banner),
  // runs the same save command as Ctrl+S, and leaves once the file is saved — the focus stays on the state word.
  const file = path.join(root, 'index.html');
  await chmod(file, 0o444);
  await typeAtEnd(page, 'SAVEDBYBUTTON');
  const save = page.getByTestId('topbar-save');
  await expect(save).toBeVisible();
  await expect(status).toHaveText('保存失败');
  await expect(page.getByTestId('save-error')).toContainText('你的修改还在编辑器里');
  await expect(save).toHaveAccessibleName(/^保存/);
  // Keyboard path (a mouse click blurs the editor first, and the blur autosave already retries): the button takes the
  // focus while the file is still read-only (that retry fails too, so the button stays), then Enter runs the save
  // command once the file is writable again.
  await save.focus();
  await expect(save).toBeFocused();
  await expect(status).toHaveText('保存失败');
  await chmod(file, 0o644);
  await page.keyboard.press('Enter');
  await expect.poll(() => readFile(file, 'utf8')).toContain('SAVEDBYBUTTON');
  await expect(status).toHaveText('已保存');
  await expect(page.getByTestId('topbar-save')).toHaveCount(0);
  // S45: the focus stays in the save group (on the state word) when the button leaves.
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('save-status');
});

test('S47.3: nothing in the top bar or the tab strip changes its bounding box during a typing → autosave cycle', async () => {
  await setContentSize(1280, 800);
  await openFile(page, 'style.css'); // two tabs: the active one changes state, the other must not move either
  await openFile(page, 'index.html');
  const status = page.getByTestId('save-status');
  await expect(status).toHaveAttribute('data-state', /^(clean|saved)$/);
  const before = await chromeBoxes();
  await typeAtEnd(page, 'STABLE');
  const during = await chromeBoxes(); // taken within the 1 s autosave pause: normally 'dirty'
  await expect(status).toHaveText('已保存');
  await expect(status).toHaveAttribute('data-state', 'saved');
  const after = await chromeBoxes();
  expect(during.state, 'the middle sample is taken while the file is unsaved or being written').toMatch(
    /^(dirty|saving|saved)$/,
  );
  // Every element that was there keeps its box while the state changes (the tab's state icon appears inside a
  // fixed slot; the pill's word changes inside its fixed slot); once saved the set of elements is the same again.
  const same = (sample: Record<string, string>) =>
    Object.fromEntries(Object.keys(before.boxes).map((key) => [key, sample[key]]));
  expect(same(during.boxes)).toEqual(before.boxes);
  expect(after.boxes).toEqual(before.boxes);
  // The tab's state is an icon with a tooltip, never a label that resizes the tab (S47.5: the tooltip's second line
  // is the file's role, which stays there after the hint above the code collapsed).
  const tab = page.locator('[data-testid="tab"][data-path="index.html"] [role="tab"]');
  await expect(tab).toHaveAttribute('title', /^index\.html\n页面结构：/);
  await expect(tab.locator('.tab-state-slot')).toHaveCount(1);
});

/** The band or region the focused element is in (the walkthrough band and the notice stack are F6 stops too). */
const focusedRegion = () =>
  page.evaluate(
    () =>
      document.activeElement
        ?.closest(
          '[data-testid^="region-"], [data-testid="rail"], [data-testid="walkthrough"], [data-testid="app-notice-stack"]',
        )
        ?.getAttribute('data-testid') ?? null,
  );

test('S47.5: one status row — the editor has no bottom row; F6 reaches the strip, the walkthrough band and the notice stack', async () => {
  await setContentSize(1280, 800);
  // The editor's former bottom row is gone; its controls sit at the end of the global status strip, in one row with
  // the Problems toggle, and the strip keeps its height.
  await expect(page.locator('[data-testid="region-editor"] .editor-status')).toHaveCount(0);
  const status = page.getByTestId('region-status');
  await expect(status).toBeVisible();
  await expect(status.getByTestId('indent-status')).toBeVisible();
  await expect(status.getByTestId('cursor-position')).toHaveText(/^行 \d+, 列 \d+$/);
  if ((await page.getByTestId('editor-ai-edit').count()) > 0) {
    await expect(status.getByTestId('editor-ai-edit')).toBeVisible();
    await expect(status.getByTestId('editor-ai-explain')).toBeVisible();
  }
  const strip = await page.locator('.status-strip').boundingBox();
  const group = await status.boundingBox();
  const toggle = await page.getByTestId('problems-toggle').boundingBox();
  expect(strip && group && Math.abs(group.y - strip.y) <= 0.5 && Math.abs(group.height - strip.height) <= 0.5).toBe(
    true,
  );
  expect(toggle && group && toggle.x + toggle.width <= group.x + 0.5, 'the group never reaches the toggle').toBe(true);

  // At most one persistent band above the code: the role hint on a file's first showing; nothing else.
  await expect(
    page.locator('[data-testid="region-editor"] > .inline-alert, [data-testid="region-editor"] > .file-role-hint'),
  ).toHaveCount(await page.getByTestId('file-role-hint').count());

  // A notice (set as entry page) anchors above the strip, below the code: it covers neither.
  if ((await page.getByTestId('walkthrough').count()) === 0) await page.getByTestId('rail-lessons').click();
  await treeRow(page, 'index.html').click({ button: 'right' });
  await page.getByTestId('tree-menu').getByRole('menuitem', { name: '设为入口页面' }).click();
  const notice = page.getByTestId('entry-notice');
  await expect(notice).toHaveAttribute('data-state', 'set');
  const noticeBox = await notice.boundingBox();
  const editorBox = await page.getByTestId('region-editor').boundingBox();
  const stripBox = await page.locator('.status-strip').boundingBox();
  expect(noticeBox && editorBox && noticeBox.y >= editorBox.y + editorBox.height - 0.5, 'below the code').toBe(true);
  expect(noticeBox && stripBox && noticeBox.y + noticeBox.height <= stripBox.y + 0.5, 'above the strip').toBe(true);
  await expect(page.getByTestId('walkthrough-next')).toBeVisible();

  // F6 from the code: preview, the walkthrough band, the notice stack, Problems, the strip's editor group, top bar.
  await page.locator('.monaco-editor .view-lines').click();
  const visited: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('F6');
    const region = await focusedRegion();
    if (region) visited.push(region);
    if (region === 'region-editor') break;
  }
  expect(visited).toEqual([
    'region-preview',
    'walkthrough',
    'app-notice-stack',
    'region-problems',
    'region-status',
    'region-topbar',
    'rail',
    'region-files',
    'region-editor',
  ]);
  // S50.2: no notice has a timer (the unit test checks the sources); it stays until the user dismisses it.
  await page.mouse.move(5, 5);
  await page.waitForTimeout(1_000);
  await expect(notice).toHaveCount(1);
  await page.getByTestId('entry-notice-dismiss').click();
  await expect(notice).toHaveCount(0);
});

test('the Lessons rail button opens the walkthrough', async () => {
  await page.getByTestId('rail-lessons').click();
  await expect(page.getByTestId('walkthrough')).toBeVisible();
});

/** Runs a native menu item (main's application menu, the View menu on macOS) by its command id. */
const clickMenuItem = (id: string) =>
  app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`no menu item ${itemId}`);
    (item.click as () => void)();
  }, id);

const densityTokens = () =>
  page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      density: document.documentElement.dataset.density,
      control: style.getPropertyValue('--control-h').trim(),
      row: style.getPropertyValue('--row-h').trim(),
      radius: style.getPropertyValue('--radius-control').trim(),
    };
  });

/** S50.4: the persisted density in the app-data settings file. */
const storedDensity = async () => {
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  // Not written yet (a fresh profile writes it on the first change): keep polling.
  const text = await readFile(path.join(userData, 'settings.json'), 'utf8').catch(() => '{}');
  return (JSON.parse(text) as { density?: string }).density;
};

for (const density of ['comfortable', 'compact'] as const) {
  if (density === 'compact') {
    test('S50.4: the palette switches to the compact density, persisted in the settings', async () => {
      await setContentSize(1280, 800);
      expect(await densityTokens()).toEqual({ density: 'comfortable', control: '32px', row: '32px', radius: '8px' });
      await page.keyboard.press('ControlOrMeta+Shift+P');
      await page.getByTestId('palette-input').fill('紧凑');
      await expect(page.getByTestId('palette-density-compact')).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('command-palette')).toHaveCount(0);
      await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
      expect(await densityTokens()).toEqual({ density: 'compact', control: '28px', row: '28px', radius: '6px' });
      await expect.poll(storedDensity).toBe('compact');
      // The native View menu follows (it is rebuilt from the context the renderer reports).
      await expect
        .poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('density-compact')?.checked))
        .toBe(true);
    });
  }

  for (const [width, height] of [
    [1280, 800],
    [1366, 768],
    [1280, 720],
    [960, 600],
    [640, 480],
  ] as const) {
    test(`${density}: at ${width}x${height} with the walkthrough and Problems open, every key control is on screen`, async () => {
      await expect(page.locator('html')).toHaveAttribute('data-density', density);
      await setContentSize(width, height);
      if ((await page.getByTestId('walkthrough').count()) === 0) await page.getByTestId('rail-lessons').click();
      if (await page.getByTestId('problems-panel').isHidden()) await page.getByTestId('problems-toggle').click();
      await expect(page.getByTestId('problems-panel')).toBeVisible();

      await expectInViewport(page.locator('.status-strip'), 'status strip');
      await expectInViewport(page.getByTestId('problems-toggle'), 'Problems toggle');
      for (const id of ['rail-files', 'rail-problems', 'rail-history', 'rail-lessons']) {
        await expectInViewport(page.getByTestId(id), id);
      }
      if ((await page.getByTestId('rail-ai').count()) > 0)
        await expectInViewport(page.getByTestId('rail-ai'), 'rail-ai');
      await expectInViewport(page.getByTestId('walkthrough-back'), 'walkthrough Back');
      await expectInViewport(page.getByTestId('walkthrough-next'), 'walkthrough Next');
      await expectInViewport(page.getByTestId('save-status'), 'save status');
      // S47.5: the editor's controls at the end of the status strip, next to the toggle, never over it.
      await expectInViewport(page.getByTestId('indent-status'), 'indent status');
      await expectInViewport(page.getByTestId('cursor-position'), 'caret position');
      if ((await page.getByTestId('editor-ai-edit').count()) > 0) {
        await expectInViewport(page.getByTestId('editor-ai-edit'), 'Edit with AI');
        await expectInViewport(page.getByTestId('editor-ai-explain'), 'Explain');
      }
      const toggle = await page.getByTestId('problems-toggle').boundingBox();
      const group = await page.getByTestId('region-status').boundingBox();
      expect(
        toggle && group && toggle.x + toggle.width <= group.x + 0.5,
        'the editor group never reaches the toggle',
      ).toBe(true);
      // Nothing overflows the window vertically: the frame fits, it never needs a scroll.
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 0.5)).toBe(true);

      // S47.3: typing never adds a Save button; the fixed save slot stays on screen through the autosave cycle.
      if (width >= 960) {
        await typeAtEnd(page, `K${width}`);
        await expect(page.getByTestId('topbar-save')).toHaveCount(0);
        await expectInViewport(page.getByTestId('save-status'), 'save status');
        await expect(page.getByTestId('save-status')).toHaveText('已保存');
      }
    });
  }
}

test('S50.4: the View menu switches back to the comfortable density', async () => {
  await clickMenuItem('density-comfortable');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable');
  expect(await densityTokens()).toEqual({ density: 'comfortable', control: '32px', row: '32px', radius: '8px' });
  await expect.poll(storedDensity).toBe('comfortable');
  await setContentSize(1280, 800);
});

test('a narrow window offers New file in the top bar, which opens the drawer and names the new file', async () => {
  await setContentSize(800, 600);
  await expect(page.getByTestId('region-files')).toBeHidden();
  await expectInViewport(page.getByTestId('topbar-new-file'), 'New file (top bar)');
  await page.getByTestId('topbar-new-file').click();
  await expect(page.getByTestId('region-files')).toBeVisible();
  await expect(page.locator('#region-files input').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await setContentSize(1280, 800);
});

test('the files panel names New file in words when it has room', async () => {
  await expect(page.getByTestId('new-file').locator('.files-action-label')).toBeVisible();
  await expect(page.getByTestId('new-file')).toHaveAccessibleName('新建文件');
});

test('no console errors', async () => {
  expect(consoleErrors).toEqual([]);
});
