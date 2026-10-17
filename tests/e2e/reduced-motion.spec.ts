import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { makeProject, openFile, openProject } from './project';

/**
 * S47.1 end to end: the reduced-motion gate. With `prefers-reduced-motion: reduce` every --dur-* token is 0ms, so no
 * transition or animation runs when a menu or a dialog opens, the tab strip scrolls or a panel is toggled; the tab
 * strip scrolls at once instead of gliding and Monaco's smooth scrolling is off. A control run without the preference
 * proves the recorder sees the motion it is asked to rule out.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;

interface Motion {
  type: string;
  name: string;
  target: string;
  duration: string;
}

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-motion-e2e-'));
  // Enough files that their tabs overflow a 960 px wide window on every platform and font.
  for (const name of ['long name one.js', 'long name two.js']) await writeFile(path.join(root, name), '// x\n');
  app = await launchApp();
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await openFile(page, 'index.html');
  // Records every transition that is created and every animation that starts, with its computed duration.
  await page.evaluate(() => {
    const log: Motion[] = [];
    (window as unknown as { __motion: Motion[] }).__motion = log;
    const describe = (el: EventTarget | null) =>
      el instanceof Element
        ? `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}.${el.className}`
        : String(el);
    document.addEventListener(
      'transitionrun',
      (e) => {
        const style = getComputedStyle(e.target as Element);
        log.push({
          type: 'transition',
          name: e.propertyName,
          target: describe(e.target),
          duration: style.transitionDuration,
        });
      },
      true,
    );
    document.addEventListener(
      'animationstart',
      (e) => {
        const style = getComputedStyle(e.target as Element);
        log.push({
          type: 'animation',
          name: e.animationName,
          target: describe(e.target),
          duration: style.animationDuration,
        });
      },
      true,
    );
  });
});

test.afterAll(async () => {
  await page?.emulateMedia({ reducedMotion: null });
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

/** Runs `action`, waits a few frames, and returns the motion recorded meanwhile that actually takes time. */
async function motionDuring(action: () => Promise<void>): Promise<Motion[]> {
  await page.evaluate(() => {
    (window as unknown as { __motion: Motion[] }).__motion.length = 0;
  });
  await action();
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
  const log = await page.evaluate(() => (window as unknown as { __motion: Motion[] }).__motion.slice());
  // An animation of 0s settles on its end state at once: it fires animationstart but never runs.
  return log.filter((m) => m.duration.split(',').some((d) => parseFloat(d) > 0));
}

/** Computed transition and animation durations of an element. */
const durationsOf = (selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const style = getComputedStyle(el);
      return { transition: style.transitionDuration, animation: style.animationDuration, name: style.animationName };
    });
/** Two painted frames, so animation events of what just appeared are dispatched before it goes away. */
const frames = () =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const allZero = (value: string) => value.split(',').every((d) => parseFloat(d) === 0);

async function openAndCloseMenu(): Promise<void> {
  await page.getByTestId('app-menu').hover();
  await page.getByTestId('app-menu').click();
  await expect(page.locator('.app-menu-list')).toBeVisible();
  await frames();
  await page.keyboard.press('Escape');
  await expect(page.locator('.app-menu-list')).toHaveCount(0);
}

async function openAndCloseDialog(): Promise<void> {
  await page.getByTestId('app-menu').click();
  await page.getByTestId('menu-help-glossary').click();
  const glossary = page.getByTestId('glossary');
  await expect(glossary).toBeVisible();
  await frames();
  await page.keyboard.press('Escape');
  await expect(glossary).toHaveCount(0);
}

async function togglePanel(): Promise<void> {
  await page.keyboard.press('ControlOrMeta+B');
  await expect(page.getByTestId('region-files')).toBeHidden();
  await page.keyboard.press('ControlOrMeta+B');
  await expect(page.getByTestId('region-files')).toBeVisible();
}

test('without the preference, menus and dialogs move (control for the recorder)', async () => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);
  const menu = await motionDuring(openAndCloseMenu);
  expect(menu.map((m) => m.name)).toContain('glass-pop');
  const dialog = await motionDuring(openAndCloseDialog);
  expect(dialog.some((m) => m.type === 'animation')).toBe(true);
  await expect(page.getByTestId('code-editor')).toHaveAttribute('data-smooth-scrolling', 'true');
});

test('with reduced motion, the duration tokens are 0ms and overlays fade instead of moving', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return ['instant', 'fast', 'base', 'sheet', 'slow'].map((n) => style.getPropertyValue(`--dur-${n}`).trim());
  });
  expect(
    tokens.map((d) => parseFloat(d)),
    tokens.join(),
  ).toEqual([0, 0, 0, 0, 0]);

  await page.getByTestId('app-menu').click();
  const list = await durationsOf('.app-menu-list');
  expect(list.name).toBe('glass-fade');
  expect(allZero(list.animation), list.animation).toBe(true);
  expect(allZero((await durationsOf('.app-menu-item, .app-menu-list [role="menuitem"]')).transition)).toBe(true);
  await page.keyboard.press('Escape');

  await page.getByTestId('app-menu').click();
  await page.getByTestId('menu-help-glossary').click();
  const dialog = await durationsOf('[data-testid="glossary"]');
  expect(dialog.name).toBe('glass-fade');
  expect(allZero(dialog.animation), dialog.animation).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('glossary')).toHaveCount(0);
});

test('with reduced motion, no transition or animation runs on a menu, a dialog or a panel toggle', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await motionDuring(openAndCloseMenu)).toEqual([]);
  expect(await motionDuring(openAndCloseDialog)).toEqual([]);
  expect(await motionDuring(togglePanel)).toEqual([]);
  // The rail buttons that toggle panels change colour without a transition.
  const rail = await durationsOf('.rail button');
  expect(allZero(rail.transition), rail.transition).toBe(true);
});

test('with reduced motion, the tab strip scrolls at once and Monaco does not scroll smoothly', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByTestId('code-editor')).toHaveAttribute('data-smooth-scrolling', 'false');
  const original = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const bounds = win.getBounds();
    const [, height] = win.getContentSize();
    win.setContentSize(960, height ?? bounds.height);
    return bounds;
  });
  try {
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(960);
    for (const file of [
      'style.css',
      'long name one.js',
      'long name two.js',
      'script.js',
      'README.md',
      '子 文件夹/页面 二.html',
    ]) {
      await openFile(page, file);
    }
    const bar = page.getByTestId('tab-bar');
    expect(await bar.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(page.getByTestId('tabs-scroll-start')).toBeEnabled();
    // Click and read the position in the same task: an instant scroll has already moved, a smooth one has not.
    const moved = await page.evaluate(() => {
      const strip = document.querySelector<HTMLElement>('[data-testid="tab-bar"]')!;
      const before = strip.scrollLeft;
      document.querySelector<HTMLButtonElement>('[data-testid="tabs-scroll-start"]')!.click();
      return before - strip.scrollLeft;
    });
    expect(moved).toBeGreaterThan(0);
    expect(await motionDuring(() => page.getByTestId('tabs-scroll-end').click())).toEqual([]);

    // The preference is live: lifting it brings the glide back (nothing has moved yet in the same task) and Monaco's
    // smooth scrolling with it.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.getByTestId('code-editor')).toHaveAttribute('data-smooth-scrolling', 'true');
    await expect(page.getByTestId('tabs-scroll-start')).toBeEnabled();
    const glide = await page.evaluate(() => {
      const strip = document.querySelector<HTMLElement>('[data-testid="tab-bar"]')!;
      const before = strip.scrollLeft;
      document.querySelector<HTMLButtonElement>('[data-testid="tabs-scroll-start"]')!.click();
      return { before, now: strip.scrollLeft };
    });
    expect(glide.now).toBe(glide.before);
    await expect.poll(() => bar.evaluate((el) => el.scrollLeft)).toBeLessThan(glide.before);
  } finally {
    await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]!.setBounds(bounds), original);
  }
});
