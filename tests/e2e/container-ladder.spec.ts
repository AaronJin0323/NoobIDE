import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { makeProject, openProject } from './project';
import { waitForPreviewState } from './preview-helpers';

/**
 * S49.6 end to end: the preview header, the preview toolbar row and the chat composer's chin follow their own width
 * through four tiers (>= 576 full; < 480 no keyboard hint or secondary action; < 384 icon-only with 4rem labels;
 * < 320 4px padding and capped fields), and every control drawn shorter than 32px there has a 32px hit target
 * without making its row taller. The containers are narrowed directly (their width is what the queries read).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-ladder-'));
  await writeFile(path.join(root, 'index.html'), '<!doctype html>\n<meta charset="utf-8">\n<h1>你好</h1>\n');
  app = await launchApp({ NOOBIDE_AI_FAKE: '1' });
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

/** Sets the inline width of the containers matching `selector` ('' gives them back their natural width). */
async function narrow(selector: string, width: number | null) {
  await page.evaluate(
    ({ selector, width }) => {
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        el.style.width = width === null ? '' : `${width}px`;
        el.style.flex = width === null ? '' : 'none';
      }
    },
    { selector, width },
  );
}

const shown = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).display !== 'none');
const labelClipped = (button: Locator) =>
  button.locator('.cq-label').evaluate((el) => el.getBoundingClientRect().width <= 1);

/** Border box (the hit target) and the room it takes in its row (border box plus block margins). */
const hitBox = (locator: Locator) =>
  locator.evaluate((el) => {
    const style = getComputedStyle(el);
    const height = el.getBoundingClientRect().height;
    return { height, room: height + parseFloat(style.marginTop) + parseFloat(style.marginBottom) };
  });

test('the preview header and toolbar row step down through the tiers', async () => {
  const rows = '[data-testid="preview-header"], [data-testid="preview-toolbar"]';
  const external = page.getByTestId('preview-open-external');
  const advanced = page.getByTestId('preview-advanced');
  const reload = page.getByTestId('preview-reload');

  await narrow(rows, 600); // >= 576: everything
  expect(await shown(external)).toBe(true);
  expect(await shown(advanced)).toBe(true);
  expect(await labelClipped(reload)).toBe(false);

  await narrow(rows, 470); // < 480: no secondary actions
  expect(await shown(external)).toBe(false);
  expect(await shown(advanced)).toBe(false);
  expect(await labelClipped(reload)).toBe(false);

  await narrow(rows, 370); // < 384: icon-only buttons, 4rem labels with an ellipsis
  expect(await labelClipped(reload)).toBe(true);
  await expect(reload).toHaveAccessibleName('刷新');
  const remPx = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  for (const id of ['viewport-desktop', 'viewport-mobile']) {
    const box = await page.getByTestId(id).evaluate((el) => ({
      width: el.getBoundingClientRect().width,
      overflow: getComputedStyle(el).textOverflow,
    }));
    expect(box.width, id).toBeLessThanOrEqual(4 * remPx + 0.5);
    expect(box.overflow).toBe('ellipsis');
  }

  await narrow(rows, 300); // < 320: 4px padding, capped fields
  const select = await page.getByTestId('preview-entry').evaluate((el) => ({
    padding: getComputedStyle(el).paddingLeft,
    maxWidth: getComputedStyle(el).maxWidth,
  }));
  expect(select.padding).toBe('4px');
  // cqw is a share of the container's content box (the row minus its own padding).
  const content = await page.getByTestId('preview-toolbar').evaluate((el) => {
    const style = getComputedStyle(el);
    return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  });
  expect(parseFloat(select.maxWidth)).toBeCloseTo(Math.max(6 * remPx, content - 4 * remPx), 0);
  expect(await reload.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('4px');

  // The rows still keep every key control inside them at the narrowest tier.
  for (const id of ['preview-reload', 'preview-stop', 'preview-entry', 'viewport-desktop', 'viewport-mobile']) {
    const inside = await page.getByTestId(id).evaluate((el) => {
      const row = el.closest('[data-testid="preview-header"], [data-testid="preview-toolbar"]') as HTMLElement;
      const r = el.getBoundingClientRect();
      const p = row.getBoundingClientRect();
      return r.left >= p.left - 0.5 && r.right <= p.right + 0.5;
    });
    expect(inside, id).toBe(true);
  }
  await narrow(rows, null);
});

test('28px controls in those rows have a 32px hit target without growing the row', async () => {
  await narrow('[data-testid="preview-header"], [data-testid="preview-toolbar"]', 640);
  const controls = [
    page.getByTestId('preview-open-external'),
    page.getByTestId('preview-entry'),
    page.getByTestId('viewport-desktop'),
    page.getByTestId('viewport-mobile'),
    page.getByTestId('preview-advanced'),
  ];
  for (const control of controls) {
    const box = await hitBox(control);
    expect(box.height, (await control.getAttribute('data-testid')) ?? '').toBeGreaterThanOrEqual(32 - 0.5);
    expect(box.room, (await control.getAttribute('data-testid')) ?? '').toBeLessThanOrEqual(28 + 0.5);
  }
  // The visual row: the viewport choices still draw a 24px outline (the hit area is transparent).
  const drawn = await page
    .getByTestId('viewport-desktop')
    .evaluate((el) => el.getBoundingClientRect().height - parseFloat(getComputedStyle(el).borderTopWidth) * 2);
  expect(drawn).toBeCloseTo(24, 0);
  // A click on the transparent band of the hit area reaches the control.
  const mobile = await page.getByTestId('viewport-mobile').boundingBox();
  if (!mobile) throw new Error('no box');
  await page.mouse.click(mobile.x + mobile.width / 2, mobile.y + 1);
  await expect(page.getByTestId('viewport-mobile')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('viewport-desktop').click();
  await narrow('[data-testid="preview-header"], [data-testid="preview-toolbar"]', null);
});

test('the composer chin drops the keyboard hint below 480px and shows Send as an icon below 384px', async () => {
  await page.evaluate(async () => {
    const ai = (window.noobide as unknown as { ai: { setKey(r: { provider: string; key: string }): Promise<unknown> } })
      .ai;
    await ai.setKey({ provider: 'anthropic', key: 'fake-key-for-tests' });
    window.dispatchEvent(new Event('noobide:ai-status-changed'));
  });
  await page.getByTestId('rail-ai').click();
  const panel = page.getByTestId('region-ai');
  await expect(panel).toBeVisible();
  const chin = '.ai-composer-row';
  const hint = panel.locator('.ai-composer-row .ai-hint');
  const send = panel.getByTestId('ai-send');

  await narrow(chin, 600);
  expect(await shown(hint)).toBe(true);
  expect(await labelClipped(send)).toBe(false);
  await narrow(chin, 470);
  expect(await shown(hint)).toBe(false);
  expect(await labelClipped(send)).toBe(false);
  await narrow(chin, 370);
  expect(await labelClipped(send)).toBe(true);
  await expect(send).toHaveAccessibleName('发送');
  await narrow(chin, 300);
  expect(await send.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('4px');
  expect((await hitBox(send)).height).toBeGreaterThanOrEqual(32 - 0.5);
  // The input still describes the hint (screen readers keep it while it is not drawn).
  await expect(panel.getByTestId('ai-input')).toHaveAttribute('aria-describedby', 'ai-input-hint');
  await narrow(chin, null);
  await page.getByTestId('rail-ai').click();
});
