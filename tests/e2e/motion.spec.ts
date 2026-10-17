import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { makeProject, openFile, openProject } from './project';

/**
 * S47.2 end to end: panels, the walkthrough band and the narrow files drawer enter with a token-timed opacity /
 * translate animation and leave with an exit (a hidden panel keeps its `display` for the fade; a removed band leaves
 * an inert copy that is gone once its exit has played); collapsible groups fold with grid-template-rows. Under reduced
 * motion none of it runs.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-panel-motion-'));
  app = await launchApp();
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await openFile(page, 'index.html');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test.afterAll(async () => {
  await page?.emulateMedia({ reducedMotion: null });
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

/** The names of the CSS animations / transitions running on the first element matching `selector`. */
const running = (selector: string) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return el
      ? el.getAnimations().map((a) => (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty)
      : null;
  }, selector);

async function setContentSize(width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
    { width, height },
  );
  await page.waitForFunction((w) => window.innerWidth >= w && window.innerWidth <= w + 2, width);
}

test('the Problems panel enters with the enter keyframes and keeps its display while it fades out', async () => {
  const panel = page.getByTestId('problems-panel');
  if (await panel.isVisible()) {
    await page.getByTestId('problems-toggle').click();
    await expect(panel).toBeHidden();
  }
  // Toggle and sample in the same task, so the animation is still running.
  const opened = await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[data-testid="problems-toggle"]')!.click();
    return new Promise<string[]>((resolve) =>
      requestAnimationFrame(() => {
        const el = document.querySelector('[data-testid="problems-panel"]')!;
        resolve(el.getAnimations().map((a) => (a as CSSAnimation).animationName));
      }),
    );
  });
  expect(opened).toContain('motion-enter-up');
  await expect(panel).toBeVisible();
  await expect.poll(() => running('[data-testid="problems-panel"]')).toEqual([]);
  const closing = await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[data-testid="problems-toggle"]')!.click();
    return new Promise<{ display: string; props: string[] }>((resolve) =>
      requestAnimationFrame(() => {
        const el = document.querySelector('[data-testid="problems-panel"]')!;
        resolve({
          display: getComputedStyle(el).display,
          props: el.getAnimations().map((a) => (a as CSSTransition).transitionProperty),
        });
      }),
    );
  });
  expect(closing.props).toEqual(expect.arrayContaining(['opacity', 'display']));
  expect(closing.display).not.toBe('none');
  await expect(panel).toBeHidden();
  expect(await running('[data-testid="problems-panel"]')).toEqual([]);
});

test('the walkthrough band enters, and leaves an inert copy that goes once its exit has played', async () => {
  await page.getByTestId('rail-lessons').click();
  const band = page.getByTestId('walkthrough');
  await expect(band).toBeVisible();
  const ghost = await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[data-testid="walkthrough-close"]')!.click();
    return new Promise<{ count: number; inert: boolean; hidden: string | null; ids: number; animation: string }>(
      (resolve) =>
        requestAnimationFrame(() => {
          const copies = document.querySelectorAll('.workbench > .walkthrough[data-motion="exit"]');
          const copy = copies[0];
          resolve({
            count: copies.length,
            inert: copy?.hasAttribute('inert') ?? false,
            hidden: copy?.getAttribute('aria-hidden') ?? null,
            ids: copy ? copy.querySelectorAll('[id], [data-testid]').length : -1,
            animation: copy ? getComputedStyle(copy).animationName : '',
          });
        }),
    );
  });
  expect(ghost).toEqual({ count: 1, inert: true, hidden: 'true', ids: 0, animation: 'motion-exit-down' });
  await expect(band).toHaveCount(0);
  await expect(page.locator('.walkthrough')).toHaveCount(0);
});

test('the preview Advanced group and a Problems section fold with grid-template-rows', async () => {
  const advanced = page.getByTestId('preview-advanced');
  await expect(advanced).toHaveAttribute('aria-expanded', 'false');
  const fold = page.locator('.preview-advanced-fold');
  await expect(fold).toHaveAttribute('data-open', 'false');
  expect(await fold.evaluate((el) => getComputedStyle(el).gridTemplateRows)).toBe('0px');
  await expect(page.getByTestId('preview-advanced-panel')).toBeHidden();
  await advanced.click();
  await expect(fold).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('preview-advanced-panel')).toBeVisible();
  await expect.poll(() => fold.evaluate((el) => parseFloat(getComputedStyle(el).gridTemplateRows))).toBeGreaterThan(20);
  await advanced.click();
  await expect(page.getByTestId('preview-advanced-panel')).toBeHidden();
  await expect(fold).toHaveAttribute('inert', '');

  await page.getByTestId('problems-toggle').click();
  const toggle = page.getByTestId('problems-section-toggle-static');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const items = page.locator('#problems-section-static-items');
  await expect(items).toHaveAttribute('data-open', 'false');
  await expect.poll(() => items.evaluate((el) => getComputedStyle(el).gridTemplateRows)).toBe('0px');
  await expect(page.getByTestId('problems-badge-static')).toBeVisible();
  await toggle.click();
  await expect(items).toHaveAttribute('data-open', 'true');
  await page.getByTestId('problems-toggle').click();
});

test('the narrow files drawer slides in from the rail and fades out', async () => {
  await setContentSize(800, 600);
  try {
    await expect(page.locator('.workbench.narrow')).toHaveCount(1);
    // A narrow window starts with the drawer closed (the wide sidebar fades out as the window narrows).
    const drawer = page.getByTestId('region-files');
    await expect(drawer).toBeHidden();
    const opened = await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="rail-files"]')!.click();
      return new Promise<string[]>((resolve) =>
        requestAnimationFrame(() =>
          resolve(
            document
              .querySelector('[data-testid="region-files"]')!
              .getAnimations()
              .map((a) => (a as CSSAnimation).animationName),
          ),
        ),
      );
    });
    expect(opened).toContain('motion-enter-start');
    await page.getByTestId('rail-files').click();
    await expect(drawer).toBeHidden();
  } finally {
    await setContentSize(1280, 800);
  }
});

test('under reduced motion nothing enters or leaves with motion and no copy is left behind', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByTestId('rail-lessons').click();
  await expect(page.getByTestId('walkthrough')).toBeVisible();
  const motion = await page.evaluate(() => {
    const el = document.querySelector('.workbench > .walkthrough')!;
    return el.getAnimations().filter((a) => Number(a.effect?.getComputedTiming().duration) > 0).length;
  });
  expect(motion).toBe(0);
  const copies = await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[data-testid="walkthrough-close"]')!.click();
    return new Promise<number>((resolve) =>
      requestAnimationFrame(() => resolve(document.querySelectorAll('[data-motion="exit"]').length)),
    );
  });
  expect(copies).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

/** The fade lengths of a masked scroller, as the engine computes them. */
const edges = (selector: string) =>
  page.locator(selector).evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      top: style.getPropertyValue('--edge-top').trim(),
      bottom: style.getPropertyValue('--edge-bottom').trim(),
      mask: style.maskImage || style.getPropertyValue('-webkit-mask-image'),
      scrolls: el.scrollHeight > el.clientHeight + 2,
    };
  });

for (const scheme of ['light', 'dark'] as const) {
  test(`S47.3 (${scheme}): the scroll-edge mask is absent at the top of a short list and present once scrolled`, async () => {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    const tree = '.tree-scroll';
    if (scheme === 'light') {
      // The fixture's tree is short: nothing scrolls, no edge fades.
      const short = await edges(tree);
      expect(short.scrolls).toBe(false);
      expect([short.top, short.bottom]).toEqual(['0px', '0px']);
      // A long folder: the tree now scrolls.
      for (let i = 0; i < 80; i++) await writeFile(path.join(root, `item ${String(i).padStart(2, '0')}.txt`), '');
      await expect(page.getByTestId('file-tree').locator('[data-path="item 79.txt"]')).toHaveCount(1);
    }
    const scroller = page.locator('.tree-scroll');
    await scroller.evaluate((el) => el.scrollTo({ top: 0, behavior: 'instant' }));
    await expect.poll(async () => (await edges(tree)).scrolls).toBe(true);
    // At the top: no fade on the top edge, the full seven-stop fade on the bottom one.
    await expect.poll(async () => (await edges(tree)).top).toBe('0px');
    await expect.poll(async () => (await edges(tree)).bottom).toBe('28px');
    await scroller.evaluate((el) => el.scrollTo({ top: 200, behavior: 'instant' }));
    await expect.poll(async () => (await edges(tree)).top).toBe('28px');
    const scrolled = await edges(tree);
    // The ladder's first stop (5 % at 15 % of 28 px) is in the computed mask.
    expect(scrolled.mask).toMatch(/rgba\(0, 0, 0, 0\.05\)/);
    // At the bottom end the bottom fade is gone.
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
    await expect.poll(async () => (await edges(tree)).bottom).toBe('0px');
    await scroller.evaluate((el) => el.scrollTo({ top: 0, behavior: 'instant' }));
  });
}
