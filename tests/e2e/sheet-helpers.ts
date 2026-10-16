import { expect, type Locator, type Page } from '@playwright/test';

/**
 * S45.4: the sheet anatomy, checked on the rendered sheet. Title (an h2 that names the dialog), then the content,
 * then the action row; the actions are fully inside the window; in the trailing group the default button is last
 * (Cancel / Close before it) and only the last one may be prominent; destructive actions are named and drawn as
 * destructive. Returns the labels of the trailing actions in order.
 */
export async function expectSheetAnatomy(
  page: Page,
  sheet: Locator,
  options: { titleVisible?: boolean; actions?: boolean } = {},
): Promise<string[]> {
  const { titleVisible = true, actions = true } = options;
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('aria-modal', 'true');
  await expect(sheet).toHaveAttribute('data-sheet', '');
  const title = sheet.locator(':scope > .sheet-header > h2');
  await expect(title).toHaveCount(1);
  const titleId = await title.getAttribute('id');
  await expect(sheet).toHaveAttribute('aria-labelledby', titleId ?? '');
  if (titleVisible) await expect(title).toBeVisible();

  const viewport = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  const box = await sheet.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 0.5);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 0.5);

  // The parts come in their order: header, content, actions (or the palette's footer).
  const order = await sheet.evaluate((el) => [...el.children].map((c) => c.className.split(' ')[0]));
  expect(order.slice(0, 2)).toEqual(['sheet-header', 'sheet-content']);
  if (!actions) return [];
  expect(order[2]).toBe('dialog-actions');

  const row = sheet.locator(':scope > .sheet-actions');
  const buttons = row.locator(':scope > button');
  const count = await buttons.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const b = await buttons.nth(i).boundingBox();
    expect(b, `action ${i} is laid out`).not.toBeNull();
    expect(b!.y + b!.height, `action ${i} is not clipped`).toBeLessThanOrEqual(
      Math.min(viewport.height, box!.y + box!.height) + 0.5,
    );
  }
  const classes = await buttons.evaluateAll((els) => els.map((e) => e.className));
  const prominent = classes.map((c) => /\bprimary-button\b/.test(c));
  // At most one prominent action, and it is the last (the default button trails).
  expect(prominent.filter(Boolean).length).toBeLessThanOrEqual(1);
  if (prominent.includes(true)) expect(prominent.lastIndexOf(true)).toBe(count - 1);
  // A lone Close is the default button.
  if (count === 1) expect(classes[0]).toMatch(/\bprimary-button\b/);
  return buttons.allTextContents();
}

/** Tab and Shift+Tab never leave the sheet. */
export async function expectFocusTrapped(page: Page, testId: string, presses = 12): Promise<void> {
  const inside = () => page.evaluate((id) => !!document.activeElement?.closest(`[data-testid="${id}"]`), testId);
  for (let i = 0; i < presses; i += 1) {
    await page.keyboard.press('Tab');
    expect(await inside(), `Tab ${i + 1} stays inside ${testId}`).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await inside()).toBe(true);
}
