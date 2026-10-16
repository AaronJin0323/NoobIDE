import { rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { makeProject, openFile, openProject, treeRow } from './project';

/**
 * S45.6 foundations (HIG Typography, Accessibility, Color): on the welcome, the workbench, the More menu, the tree's
 * context menu, the command palette and the AI panel, in the light and the dark theme,
 * - axe-core reports no `color-contrast` and no `target-size` violation (any impact), and
 * - every visible control of the shell (top bar, rail, files pane, menus, status strip, welcome) is at least
 *   24×24 CSS px — the HIG macOS minimum of 20 pt plus spacing, and WCAG 2.5.8.
 * Keyboard focus draws the same ring everywhere in the shell.
 */
test.describe.configure({ mode: 'serial' });

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-hig-'));
  app = await launchApp();
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor({ state: 'attached' });
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

/** The shell's own chrome; the editor, preview and AI chat content are measured by their own features. */
const SHELL =
  '[data-testid="region-topbar"], [data-testid="rail"], [data-testid="region-files"], #app-menu-list, ' +
  '.context-menu, .status-strip, [data-testid="welcome"]';
const CONTROLS = 'button, [role="button"], [role^="menuitem"], [role="tab"], [role="treeitem"], a[href], select';

async function settle() {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.timeline instanceof DocumentTimeline && a.playState === 'running')
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

/** axe-core with only the two rules this feature owns, at every impact level. */
async function axeContrastAndTargets(): Promise<string[]> {
  await settle();
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<AxeResults> } }).axe;
    interface AxeResults {
      violations: { id: string; nodes: { target: string[]; failureSummary?: string }[] }[];
    }
    const results = await axe.run(
      { exclude: [['.monaco-editor']] },
      { resultTypes: ['violations'], runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } },
    );
    return results.violations.flatMap((v) =>
      v.nodes.map((n) => `${v.id} ${n.target.join(' ')} — ${(n.failureSummary ?? '').replace(/\s+/g, ' ')}`),
    );
  });
}

/** The visible shell controls (how many were measured) and those smaller than 24×24 CSS px. */
async function measureTargets(): Promise<{ measured: number; small: string[] }> {
  return page.evaluate(
    ({ shell, controls }) => {
      const small: string[] = [];
      let measured = 0;
      for (const scope of document.querySelectorAll(shell)) {
        for (const el of scope.querySelectorAll<HTMLElement>(controls)) {
          if (el.closest('.monaco-editor, [hidden], .sr-only')) continue;
          const box = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || style.display === 'none')
            continue;
          measured += 1;
          if (box.width < 24 || box.height < 24) {
            const name = el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.textContent?.trim();
            small.push(
              `${el.tagName.toLowerCase()}.${el.className} "${name}" ${box.width.toFixed(1)}×${box.height.toFixed(1)}`,
            );
          }
        }
      }
      return { measured, small };
    },
    { shell: SHELL, controls: CONTROLS },
  );
}

async function checkState(state: string, minControls: number): Promise<string[]> {
  const findings: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    for (const f of await axeContrastAndTargets()) findings.push(`${state}/${scheme}: ${f}`);
    const targets = await measureTargets();
    expect(targets.measured, `${state}/${scheme}: shell controls measured`).toBeGreaterThanOrEqual(minControls);
    for (const f of targets.small) findings.push(`${state}/${scheme}: under 24×24: ${f}`);
  }
  return findings;
}

test('welcome: contrast and hit targets in light and dark', async () => {
  await expect(page.getByTestId('welcome')).toBeVisible();
  expect(await checkState('welcome', 5)).toEqual([]);
});

test('workbench, More menu, tree menu, palette and AI: contrast and hit targets in light and dark', async () => {
  await openProject(app, page, root);
  await openFile(page, 'index.html');
  expect(await checkState('workbench', 12)).toEqual([]);

  await page.getByTestId('app-menu').click();
  await expect(page.getByRole('menu')).toBeVisible();
  expect(await checkState('menu', 20)).toEqual([]);
  await page.keyboard.press('Escape');

  await treeRow(page, 'index.html').click({ button: 'right' });
  await expect(page.locator('.context-menu')).toBeVisible();
  expect(await checkState('tree-menu', 15)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('.context-menu')).toHaveCount(0);

  await page.getByTestId('open-palette').click();
  await page.getByTestId('palette-input').fill('them');
  expect(await checkState('palette', 8)).toEqual([]);
  await page.keyboard.press('Escape');

  await page.getByTestId('rail-ai').click();
  await expect(page.getByTestId('region-ai')).toBeVisible();
  expect(await checkState('ai', 12)).toEqual([]);
  await page.getByTestId('rail-ai').click();
  await page.emulateMedia({ colorScheme: null });
});

test("keyboard focus draws the same ring on shell controls, in the theme's focus colour", async () => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    for (const id of ['app-menu', 'open-palette', 'rail-files', 'new-file', 'problems-toggle']) {
      await page.keyboard.press('Shift'); // the last input is the keyboard, so a focus move shows the ring
      await page.getByTestId(id).focus();
      const ring = await page.getByTestId(id).evaluate((el) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--focus)';
        document.body.append(probe);
        const focus = getComputedStyle(probe).color;
        probe.remove();
        const s = getComputedStyle(el);
        return {
          visible: el.matches(':focus-visible'),
          style: s.outlineStyle,
          width: s.outlineWidth,
          isFocusColour: s.outlineColor === focus,
        };
      });
      expect(ring, `${scheme} ${id}`).toEqual({ visible: true, style: 'solid', width: '2px', isFocusColour: true });
    }
  }
  await page.emulateMedia({ colorScheme: null });
});
