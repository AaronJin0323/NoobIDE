import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';

/**
 * S50.1 end to end: the one Sheet shell.
 * - A sheet never runs taller than calc(100dvh - 2 × max(32px, titlebar inset)) — it stays clear of the window
 *   controls in a short window.
 * - A sheet with another sheet open over it blurs by 2px and dims, and is itself again once the front one closes;
 *   Escape and Tab belong to the front one, Escape closes it first, and focus goes back to where it was.
 * - The command palette is on the same frame (modal, Escape, Tab, focus return).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await launchApp();
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
});

test.afterAll(async () => {
  await app?.close();
});

async function setWindowSize(width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setContentSize(size.width, size.height);
    },
    { width, height },
  );
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(height);
}

const openAbout = () => page.evaluate(() => window.dispatchEvent(new Event('noobide:open-about')));
async function openGlossary(): Promise<void> {
  await page.getByTestId('app-menu').click();
  await page.getByTestId('menu-help-glossary').click();
}

test('a sheet stays within calc(100dvh - 2 × max(32px, 52px)) in a short window', async () => {
  await setWindowSize(900, 520);
  await openGlossary();
  const sheet = page.getByTestId('glossary');
  await expect(sheet).toBeVisible();
  const box = await sheet.evaluate(async (el) => {
    // Measure where it lands, not mid-way through its rise.
    await Promise.all(el.getAnimations().map((animation) => animation.finished));
    const rect = el.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: rect.height, inner: window.innerHeight };
  });
  expect(box.height).toBeLessThanOrEqual(box.inner - 104 + 0.5);
  // Centred: the clear space above is at least the title bar inset.
  expect(box.top).toBeGreaterThanOrEqual(52 - 0.5);
  expect(box.bottom).toBeLessThanOrEqual(box.inner - 52 + 0.5);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-sheet]')).toHaveCount(0);
  await setWindowSize(1024, 700);
});

test('a sheet with another opened over it blurs and dims; Escape closes the front one first', async () => {
  // The native About item (macOS app menu) works while a sheet is open: About opens over the glossary.
  await openGlossary();
  const glossary = page.getByTestId('glossary');
  await expect(glossary).toBeVisible();
  await expect(glossary).not.toHaveAttribute('data-covered');
  expect(await glossary.evaluate((el) => getComputedStyle(el).filter)).toBe('none');
  const opener = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120));

  await openAbout();
  const about = page.getByTestId('about-dialog');
  await expect(about).toBeVisible();
  await expect(page.getByTestId('about-close')).toBeFocused();
  await expect(glossary).toHaveAttribute('data-covered', '');
  const filter = await glossary.evaluate((el) => getComputedStyle(el).filter);
  expect(filter).toContain('blur(2px)');
  expect(filter).toContain('opacity(0.85)');
  expect(await about.evaluate((el) => getComputedStyle(el).filter)).toBe('none');

  // Tab stays in the front sheet.
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press('Tab');
    expect(await about.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(about).toHaveCount(0);
  await expect(glossary).toBeVisible();
  await expect(glossary).not.toHaveAttribute('data-covered');
  await expect.poll(() => glossary.evaluate((el) => getComputedStyle(el).filter)).toBe('none');
  // Focus went back into the glossary, where it was when About opened.
  expect(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))).toBe(opener);

  await page.keyboard.press('Escape');
  await expect(glossary).toHaveCount(0);
});

test('the command palette is on the same frame: modal, Escape closes it, focus goes back', async () => {
  const opener = page.getByTestId('app-menu');
  await opener.focus();
  await page.keyboard.press('ControlOrMeta+Shift+P');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await expect(palette).toHaveAttribute('data-sheet', '');
  await expect(palette).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('palette-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await expect(opener).toBeFocused();
});
