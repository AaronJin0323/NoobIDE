import { rm } from 'node:fs/promises';
import { expect, test, type CDPSession, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { focusEditor, makeProject, openFile, openProject } from './project';
import { axeScan } from './a11y-helpers';
import { commandShortcutLabel } from '../../src/shared/commands';

/**
 * S40.7 end to end: the command palette (S40.5) and the overlay materials (S40.2–S40.4, narrowed by S46.3).
 * - The palette opens from the keyboard, the top bar button and the native View menu; it searches in both interface
 *   languages, lists only commands that can run, runs the chosen one after it closed and returns focus.
 * - Materials: content (editor, preview) never sits under a backdrop-filter while nothing floats; menus and the
 *   palette blur while open; persistent chrome (rail, top bar, its groups, files sidebar, status strip) is opaque or
 *   has no background, never blurred; reduced transparency, increased contrast and forced colours make every overlay
 *   solid; reduced motion replaces movement with a cross-fade. Both themes.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-glass-e2e-'));
  app = await launchApp();
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await openFile(page, 'index.html');
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

const palette = () => page.getByTestId('command-palette');
const input = () => page.getByTestId('palette-input');
const html = () => page.locator('html');

async function openPaletteByKey(): Promise<void> {
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await expect(palette()).toBeVisible();
  await expect(input()).toBeFocused();
}

async function closePalette(): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(palette()).toHaveCount(0);
}

async function setScheme(scheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await expect(html()).toHaveAttribute('data-theme', scheme);
}

/** The computed style of the first element matching `selector`. */
const styleOf = (selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        backdropFilter: style.backdropFilter,
        background: style.backgroundColor,
        animationName: style.animationName,
      };
    });

/** The alpha of a computed CSS colour: rgb(), rgba() or color(srgb … / a). */
function alphaOf(color: string): number {
  const rgba = /^rgba?\(([^)]+)\)$/.exec(color);
  if (rgba) {
    const parts = rgba[1]!.split(/[\s,/]+/).filter(Boolean);
    return parts.length >= 4 ? Number(parts[3]) : 1;
  }
  const fn = /\/\s*([\d.]+)\s*\)$/.exec(color);
  if (fn) return Number(fn[1]);
  if (color === 'transparent') return 0;
  return 1;
}

/** Opens the in-window app menu and returns the computed style of its list; closes it again. */
async function appMenuStyle() {
  await page.getByTestId('app-menu').click();
  await expect(page.locator('.app-menu-list')).toBeVisible();
  const style = await styleOf('.app-menu-list');
  await page.keyboard.press('Escape');
  await expect(page.locator('.app-menu-list')).toHaveCount(0);
  return style;
}

/** Opens the palette from the top bar and returns the computed style of its sheet; closes it again. */
async function paletteStyle() {
  await page.getByTestId('open-palette').click();
  await expect(palette()).toBeVisible();
  const style = await styleOf('.palette');
  await closePalette();
  return style;
}

/** Opens the glossary (a .dialog sheet) from the app menu and returns its computed style; closes it again. */
async function dialogStyle() {
  await page.getByTestId('app-menu').click();
  await page.getByTestId('menu-help-glossary').click();
  const glossary = page.getByTestId('glossary');
  await expect(glossary).toBeVisible();
  await expect(glossary).toHaveClass(/\bdialog\b/);
  const style = await styleOf('[data-testid="glossary"]');
  await page.keyboard.press('Escape');
  await expect(glossary).toHaveCount(0);
  return style;
}

/**
 * Whether the OS itself asks for solid materials (macOS "Reduce transparency" / "Increase contrast"). glass.css
 * honours both, so the app is right to draw solid chrome then; GitHub's macos-14 runner image ships with Reduce
 * transparency turned on. Read before any emulation of these features.
 */
const systemAsksForSolid = () =>
  page.evaluate(
    () =>
      matchMedia('(prefers-reduced-transparency: reduce)').matches || matchMedia('(prefers-contrast: more)').matches,
  );

/** Persistent chrome (S46.3): flat on the window background, so no material and no blur of its own. */
const CHROME = ['.rail', '.topbar', '.toolbar-group', '[data-testid="region-files"]', '.status-strip'] as const;

/** Every piece of persistent chrome has an opaque background or none (alpha 1 or 0) and no backdrop-filter. */
async function expectFlatChrome(label: string): Promise<void> {
  for (const selector of CHROME) {
    const style = await styleOf(selector);
    expect(style.backdropFilter, `${label} ${selector}`).toBe('none');
    expect([0, 1], `${label} ${selector} ${style.background}`).toContain(alphaOf(style.background));
  }
  // No ambient colour fields behind the chrome: the window is one flat colour.
  const image = await page.locator('.workbench').evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(image, label).toBe('none');
}

/** Pins the colour scheme and the default (glass) material preferences, whatever the OS is set to. */
async function setSchemeWithGlass(cdp: CDPSession, scheme: 'light' | 'dark'): Promise<void> {
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: scheme },
      { name: 'prefers-reduced-transparency', value: 'no-preference' },
      { name: 'prefers-contrast', value: 'no-preference' },
    ],
  });
  await expect(html()).toHaveAttribute('data-theme', scheme);
}

test('the palette opens from the keyboard, searches, moves with the arrows and runs the chosen command', async () => {
  await setScheme('dark');
  await focusEditor(page);
  await openPaletteByKey();
  await input().fill('主题');
  const options = palette().getByRole('option');
  await expect(palette().getByTestId('palette-theme-light')).toBeVisible();
  await expect(palette().getByTestId('palette-theme-dark')).toBeVisible();
  await expect(palette().getByTestId('palette-theme-system')).toBeVisible();
  // The current choice is marked as checked (not only coloured).
  await expect(palette().getByTestId('palette-theme-system')).toHaveAttribute('aria-checked', 'true');
  // The best match is the active option, and the combobox points at it.
  const first = options.nth(0);
  const second = options.nth(1);
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(input()).toHaveAttribute('aria-activedescendant', (await first.getAttribute('id'))!);
  await page.keyboard.press('ArrowDown');
  await expect(first).toHaveAttribute('aria-selected', 'false');
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await expect(input()).toHaveAttribute('aria-activedescendant', (await second.getAttribute('id'))!);
  await page.keyboard.press('ArrowUp');
  await expect(palette().getByTestId('palette-theme-light')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(palette()).toHaveCount(0);
  await expect(html()).toHaveAttribute('data-theme', 'light'); // even though the system is dark
  await expect(html()).toHaveAttribute('data-theme-choice', 'light');
  // Focus is back in the code editor, where it was before opening.
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.monaco-editor') != null)).toBe(true);

  // Escape closes without running anything.
  await openPaletteByKey();
  await input().fill('深色');
  await expect(palette().getByTestId('palette-theme-dark')).toHaveAttribute('aria-selected', 'true');
  await closePalette();
  await expect(html()).toHaveAttribute('data-theme-choice', 'light');
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.monaco-editor') != null)).toBe(true);

  // English in the Chinese interface finds the command and shows its English name as a hint.
  await openPaletteByKey();
  await input().fill('save');
  const save = palette().getByTestId('palette-save');
  await expect(save).toBeVisible();
  await expect(save).toContainText('保存');
  await expect(save).toContainText('英文：Save');
  // Nonsense: an empty state in words, and a count of 0.
  await input().fill('zqxjv');
  await expect(palette().getByTestId('palette-empty')).toBeVisible();
  await expect(palette().getByRole('option')).toHaveCount(0);
  await expect(palette().getByTestId('palette-count')).toHaveText('找到 0 个命令');
  await expect(input()).not.toHaveAttribute('aria-activedescendant');
  await closePalette();

  // The top bar button: its accessible name carries the shortcut; focus returns to it.
  const button = page.getByTestId('open-palette');
  const shortcut = commandShortcutLabel('command-palette', process.platform === 'darwin' ? 'mac' : 'windows');
  expect(shortcut).toMatch(/P/);
  await expect(button).toHaveAccessibleName(`搜索命令 (${shortcut})`);
  await button.focus();
  await button.press('Enter');
  await expect(palette()).toBeVisible();
  await expect(input()).toBeFocused();
  await closePalette();
  await expect(button).toBeFocused();

  // A click outside closes it too.
  await button.click();
  await expect(palette()).toBeVisible();
  await page.mouse.click(5, 300);
  await expect(palette()).toHaveCount(0);

  // Back to following the system, through the palette.
  await openPaletteByKey();
  await input().fill('跟随系统');
  await page.keyboard.press('Enter');
  await expect(html()).toHaveAttribute('data-theme-choice', 'system');
  await expect(html()).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: null });
});

test('only commands that can run are listed', async () => {
  await openPaletteByKey();
  const count = await palette().getByRole('option').count();
  expect(count).toBeGreaterThan(5);
  await expect(palette().getByTestId('palette-count')).toHaveText(`找到 ${count} 个命令`);
  // The palette never lists itself; with a project open, closing it is listed.
  await expect(palette().getByTestId('palette-command-palette')).toHaveCount(0);
  await expect(palette().getByTestId('palette-close-project')).toHaveCount(1);
  await expect(palette().getByTestId('palette-save')).toHaveCount(1); // a tab is open
  await closePalette();
});

test('the native View menu opens the palette', async () => {
  const exists = await app.evaluate(
    ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('command-palette') != null,
  );
  expect(exists).toBe(true);
  await app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.getMenuItemById('command-palette')?.click as () => void)(),
  );
  await expect(palette()).toBeVisible();
  await expect(input()).toBeFocused();
  await closePalette();
});

test('materials: content never under blur, overlays blur, chrome is flat — in both themes', async () => {
  const systemSolid = await systemAsksForSolid();
  if (systemSolid) {
    // The OS asks for solid materials: the app must honour it, in both themes, before we emulate the default.
    test.info().annotations.push({ type: 'system materials', description: 'OS asks for solid materials' });
    for (const scheme of ['light', 'dark'] as const) {
      await setScheme(scheme);
      await expectFlatChrome(`${scheme} system-solid`);
      const menu = await appMenuStyle();
      expect(menu.backdropFilter, scheme).toBe('none');
      expect(alphaOf(menu.background), `${scheme} system-solid menu ${menu.background}`).toBe(1);
      const sheet = await paletteStyle();
      expect(sheet.backdropFilter, scheme).toBe('none');
      expect(alphaOf(sheet.background), `${scheme} system-solid palette ${sheet.background}`).toBe(1);
    }
  }
  const cdp: CDPSession = await page.context().newCDPSession(page);
  try {
    await runMaterialChecks(cdp);
  } finally {
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await cdp.detach();
    await page.emulateMedia({ colorScheme: null });
  }
});

/** The default-preference material checks, with the OS material preferences pinned to "no preference". */
async function runMaterialChecks(cdp: CDPSession): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await setSchemeWithGlass(cdp, scheme);
    expect(await systemAsksForSolid(), `${scheme}: emulation pins no-preference`).toBe(false);
    // Nothing floating: no element over the editor or the preview stage has a backdrop-filter.
    const blurred = await page.evaluate(() => {
      const regions = ['[data-testid="region-editor"]', '[data-testid="preview-stage"]']
        .map((s) => document.querySelector(s)?.getBoundingClientRect())
        .filter((r): r is DOMRect => r !== undefined && r.width > 0 && r.height > 0);
      if (regions.length === 0) return ['no editor region'];
      const hits: string[] = [];
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const filter = getComputedStyle(el).backdropFilter;
        if (!filter || filter === 'none') continue;
        const r = el.getBoundingClientRect();
        const overlaps = regions.some(
          (g) => r.left < g.right && r.right > g.left && r.top < g.bottom && r.bottom > g.top,
        );
        if (overlaps) hits.push(`${el.tagName.toLowerCase()}.${el.className}: ${filter}`);
      }
      return hits;
    });
    expect(blurred, scheme).toEqual([]);

    // Persistent chrome: opaque or no background, no blur.
    await expectFlatChrome(scheme);

    // Overlays blur what is behind them while open.
    expect((await appMenuStyle()).backdropFilter, scheme).toContain('blur');
    const sheet = await paletteStyle();
    expect(sheet.backdropFilter, scheme).toContain('blur');
    expect(alphaOf(sheet.background), `${scheme} palette ${sheet.background}`).toBeLessThan(1);
  }
}

/**
 * How much sharp detail the window shows inside `rect` (CSS px): the mean luminance step between horizontally adjacent
 * pixels, captured by main (what the user sees, compositing included).
 */
async function sharpness(rect: { x: number; y: number; width: number; height: number }): Promise<number> {
  return app.evaluate(async ({ BrowserWindow }, r) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const image = await win.webContents.capturePage({
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap(); // BGRA
    const stride = bitmap.length / height;
    let sum = 0;
    let count = 0;
    for (let y = 0; y < height; y += 1) {
      let previous = -1;
      for (let x = 0; x < width; x += 1) {
        const i = y * stride + x * 4;
        const l = 0.0722 * bitmap[i]! + 0.7152 * bitmap[i + 1]! + 0.2126 * bitmap[i + 2]!;
        if (previous >= 0) {
          sum += Math.abs(l - previous);
          count += 1;
        }
        previous = l;
      }
    }
    return count === 0 ? 0 : sum / count;
  }, rect);
}

test('a dialog sheet is frosted: the code behind it does not show through sharp (both themes)', async () => {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  try {
    for (const scheme of ['light', 'dark'] as const) {
      await setSchemeWithGlass(cdp, scheme);
      // The code lines (sharp text) at the top of the editor.
      const lines = await page.locator('.monaco-editor .view-lines').boundingBox();
      if (!lines) throw new Error('no editor lines');
      const area = { x: lines.x + 8, y: lines.y + 4, width: Math.min(260, lines.width - 16), height: 90 };
      const behind = await sharpness(area);
      expect(behind, `${scheme}: the code itself has detail`).toBeGreaterThan(2);
      // An empty sheet with the real dialog classes, exactly over that code.
      await page.evaluate((a) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'dialog-backdrop';
        backdrop.id = 'frost-test';
        const sheet = document.createElement('div');
        sheet.className = 'dialog';
        Object.assign(sheet.style, {
          position: 'fixed',
          left: `${a.x - 30}px`,
          top: `${a.y - 30}px`,
          width: `${a.width + 60}px`,
          height: `${a.height + 60}px`,
        });
        backdrop.append(sheet);
        document.body.append(backdrop);
      }, area);
      await page.waitForTimeout(700); // the scrim and the sheet finish their entrance
      const through = await sharpness(area);
      await page.evaluate(() => document.getElementById('frost-test')?.remove());
      // Measured on Windows at 150 %: a see-through sheet (the blur sampling only the scrim) keeps about a tenth of the
      // detail (0.11); a frosted one almost none (0.002).
      expect(through / behind, `${scheme}: detail left behind the sheet (${through} of ${behind})`).toBeLessThan(0.03);
    }
  } finally {
    await page.evaluate(() => document.getElementById('frost-test')?.remove());
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await cdp.detach();
    await page.emulateMedia({ colorScheme: null });
  }
});

test('reduced transparency makes every material solid', async () => {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const supported = { value: false };
  try {
    for (const scheme of ['light', 'dark'] as const) {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [
          { name: 'prefers-reduced-transparency', value: 'reduce' },
          { name: 'prefers-color-scheme', value: scheme },
        ],
      });
      await expect(html()).toHaveAttribute('data-theme', scheme);
      supported.value = await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches);
      if (!supported.value) {
        // This Chromium does not know the media feature: the app's own switch (data-transparency, which the same
        // rules in glass.css honour) stands in for it.
        await page.evaluate(() => {
          document.documentElement.dataset.transparency = 'reduce';
        });
      }
      await expectFlatChrome(`${scheme} reduced transparency`);
      const menu = await appMenuStyle();
      expect(menu.backdropFilter, scheme).toBe('none');
      expect(alphaOf(menu.background), `${scheme} menu ${menu.background}`).toBe(1);
      const sheet = await paletteStyle();
      expect(sheet.backdropFilter, scheme).toBe('none');
      expect(alphaOf(sheet.background), `${scheme} palette ${sheet.background}`).toBe(1);
      const dialog = await dialogStyle();
      expect(dialog.backdropFilter, scheme).toBe('none');
      expect(alphaOf(dialog.background), `${scheme} dialog ${dialog.background}`).toBe(1);
    }
    test.info().annotations.push({
      type: 'prefers-reduced-transparency',
      description: supported.value ? 'supported by this Chromium' : 'not supported; data-transparency used',
    });
    // The app's own switch works on its own as well, without the media feature (pinned off: the OS may set it).
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-reduced-transparency', value: 'no-preference' },
        { name: 'prefers-contrast', value: 'no-preference' },
      ],
    });
    await page.evaluate(() => {
      document.documentElement.dataset.transparency = 'reduce';
    });
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches)).toBe(false);
    const menu = await appMenuStyle();
    expect(menu.backdropFilter).toBe('none');
    expect(alphaOf(menu.background), `menu ${menu.background}`).toBe(1);
    const sheet = await paletteStyle();
    expect(sheet.backdropFilter).toBe('none');
    expect(alphaOf(sheet.background), `palette ${sheet.background}`).toBe(1);
  } finally {
    await page.evaluate(() => {
      delete document.documentElement.dataset.transparency;
    });
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await cdp.detach();
    await page.emulateMedia({ colorScheme: null });
  }
  // Back to what the OS asks for: frosted overlays, or solid ones when the system itself reduces transparency (macOS
  // CI runner).
  const sheet = await paletteStyle();
  if (await systemAsksForSolid()) {
    expect(sheet.backdropFilter, 'system-solid palette').toBe('none');
    expect(alphaOf(sheet.background), `system-solid palette ${sheet.background}`).toBe(1);
  } else {
    expect(sheet.backdropFilter, 'palette').toContain('blur');
    expect(alphaOf(sheet.background), `palette ${sheet.background}`).toBeLessThan(1);
  }
});

test('reduced motion swaps the menu pop for a cross-fade', async () => {
  for (const scheme of ['light', 'dark'] as const) {
    await setScheme(scheme);
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'no-preference' });
    expect((await appMenuStyle()).animationName, scheme).toBe('glass-pop');
    expect((await paletteStyle()).animationName, scheme).toBe('glass-pop');
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    expect((await appMenuStyle()).animationName, scheme).toBe('glass-fade');
    expect((await paletteStyle()).animationName, scheme).toBe('glass-fade');
  }
  await page.emulateMedia({ colorScheme: null, reducedMotion: null });
});

test('increased contrast makes every material solid', async () => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, contrast: 'more' });
    await expect(html()).toHaveAttribute('data-theme', scheme);
    expect(await page.evaluate(() => matchMedia('(prefers-contrast: more)').matches)).toBe(true);
    await expectFlatChrome(`${scheme} increased contrast`);
    const menu = await appMenuStyle();
    expect(menu.backdropFilter, scheme).toBe('none');
    expect(alphaOf(menu.background), `${scheme} menu ${menu.background}`).toBe(1);
    const sheet = await paletteStyle();
    expect(sheet.backdropFilter, scheme).toBe('none');
    expect(alphaOf(sheet.background), `${scheme} palette ${sheet.background}`).toBe(1);
    const dialog = await dialogStyle();
    expect(dialog.backdropFilter, scheme).toBe('none');
    expect(alphaOf(dialog.background), `${scheme} dialog ${dialog.background}`).toBe(1);
  }
  await page.emulateMedia({ colorScheme: null, contrast: null });
});

test('forced colours (Windows contrast themes) drop every blur and keep the palette selection visible', async () => {
  await page.emulateMedia({ forcedColors: 'active' });
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
  const rail = await styleOf('.rail');
  expect(rail.backdropFilter).toBe('none');
  const menu = await appMenuStyle();
  expect(menu.backdropFilter).toBe('none');
  expect(alphaOf(menu.background), `menu ${menu.background}`).toBe(1);
  await page.getByTestId('open-palette').click();
  await expect(palette()).toBeVisible();
  const sheet = await styleOf('.palette');
  expect(sheet.backdropFilter).toBe('none');
  expect(alphaOf(sheet.background), `palette ${sheet.background}`).toBe(1);

  // The active option keeps a system highlight (not the accent fill, which forced colours would drop).
  const selected = await styleOf('.palette-option[aria-selected="true"]');
  const other = await styleOf('.palette-option[aria-selected="false"]');
  expect(alphaOf(selected.background)).toBe(1);
  expect(selected.background).not.toBe(other.background);
  await closePalette();

  // Dialogs (sheets) are solid too.
  const dialog = await dialogStyle();
  expect(dialog.backdropFilter).toBe('none');
  expect(alphaOf(dialog.background), `dialog ${dialog.background}`).toBe(1);
  await page.emulateMedia({ forcedColors: null });
});

test('axe finds no serious or critical issue on the open palette in both themes', async () => {
  const findings: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await setScheme(scheme);
    await openPaletteByKey();
    await input().fill('主题');
    await expect(palette().getByRole('option').first()).toBeVisible();
    // Let the opening animation finish so colours are measured at full opacity.
    await page.waitForTimeout(400);
    for (const f of await axeScan(page)) findings.push(`${scheme}: ${f.id} (${f.impact}) ${f.targets.join(', ')}`);
    await closePalette();
  }
  expect(findings).toEqual([]);
  await page.emulateMedia({ colorScheme: null });
});
