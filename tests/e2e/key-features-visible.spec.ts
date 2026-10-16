import { chmod, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { collectConsoleErrors, makeProject, openFile, openProject, typeAtEnd } from './project';

/**
 * Key features are never pushed off screen (owner request): with the walkthrough band and the Problems panel open,
 * the status strip, the Problems toggle, the Save button, the rail buttons and the walkthrough's Back / Next stay fully
 * inside the window — at a common laptop size and down to the 640×480 minimum window. The top-bar Save button saves
 * through the same path as Ctrl+S, and a narrow window offers New file without opening the files drawer first.
 * S47.3: the save state lives in a fixed slot and the Save button shows only while a save cannot happen on its own,
 * so nothing in the top bar or the tab strip moves during a typing → autosave cycle.
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
  // The tab's state is an icon with a tooltip, never a label that resizes the tab.
  const tab = page.locator('[data-testid="tab"][data-path="index.html"] [role="tab"]');
  await expect(tab).toHaveAttribute('title', 'index.html');
  await expect(tab.locator('.tab-state-slot')).toHaveCount(1);
});

test('the Lessons rail button opens the walkthrough', async () => {
  await page.getByTestId('rail-lessons').click();
  await expect(page.getByTestId('walkthrough')).toBeVisible();
});

for (const [width, height] of [
  [1280, 800],
  [1366, 768],
  [1280, 720],
  [960, 600],
  [640, 480],
] as const) {
  test(`at ${width}x${height} with the walkthrough and Problems open, every key control is on screen`, async () => {
    await setContentSize(width, height);
    if ((await page.getByTestId('walkthrough').count()) === 0) await page.getByTestId('rail-lessons').click();
    if (await page.getByTestId('problems-panel').isHidden()) await page.getByTestId('problems-toggle').click();
    await expect(page.getByTestId('problems-panel')).toBeVisible();

    await expectInViewport(page.locator('.status-strip'), 'status strip');
    await expectInViewport(page.getByTestId('problems-toggle'), 'Problems toggle');
    for (const id of ['rail-files', 'rail-problems', 'rail-history', 'rail-lessons']) {
      await expectInViewport(page.getByTestId(id), id);
    }
    if ((await page.getByTestId('rail-ai').count()) > 0) await expectInViewport(page.getByTestId('rail-ai'), 'rail-ai');
    await expectInViewport(page.getByTestId('walkthrough-back'), 'walkthrough Back');
    await expectInViewport(page.getByTestId('walkthrough-next'), 'walkthrough Next');
    await expectInViewport(page.getByTestId('save-status'), 'save status');
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
