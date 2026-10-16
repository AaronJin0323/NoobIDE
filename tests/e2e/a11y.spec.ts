import { rm } from 'node:fs/promises';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { makeProject, openFile, openProject, tabOf } from './project';
import { axeScan } from './a11y-helpers';

/**
 * S24.3 accessibility pass, end to end:
 * - an axe-core scan of the main workbench states (welcome, project with a file, problems panel, command menu,
 *   create wizard, local history) in the light and the dark theme reports no serious or critical issue;
 * - the focus order follows the visual order of the regions, and F6 / Shift+F6 move between regions (Tab stays in
 *   the code editor, where it indents);
 * - key actions work from the keyboard alone.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-a11y-'));
  app = await launchApp();
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

/** Scans in both themes; returns the serious and critical findings, labelled with the state and theme. */
async function scanBothThemes(state: string): Promise<string[]> {
  const findings: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    for (const f of await axeScan(page))
      findings.push(`${state}/${scheme}: ${f.id} (${f.impact}) ${f.targets.join(', ')}`);
  }
  return findings;
}

const focused = () =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const region = el?.closest('[data-testid^="region-"], [data-testid="rail"]')?.getAttribute('data-testid');
    return {
      region: region ?? null,
      testId: el?.getAttribute('data-testid') ?? null,
      inEditor: el?.closest('.monaco-editor') != null,
    };
  });

test('axe finds no serious or critical issue on the welcome screen and in the create wizard', async () => {
  expect(await scanBothThemes('welcome')).toEqual([]);
  // ⌘N / Ctrl+N opens the wizard from the keyboard; focus moves into the modal dialog.
  await page.keyboard.press('ControlOrMeta+N');
  const wizard = page.getByTestId('create-wizard');
  await expect(wizard).toBeVisible();
  await expect.poll(() => wizard.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  expect(await scanBothThemes('wizard')).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(wizard).toHaveCount(0);
});

test('axe finds no serious or critical issue with a project, the problems panel, the menu and history', async () => {
  await openProject(app, page, root);
  await openFile(page, 'index.html');
  await openFile(page, 'style.css');
  await page.keyboard.press('ControlOrMeta+Shift+M');
  await expect(page.getByTestId('problems-toggle')).toHaveAttribute('aria-expanded', 'true');
  expect(await scanBothThemes('project')).toEqual([]);

  // The two in-window menus (S47.4), opened and used with the keyboard only: the project menu next to the name
  // opens on Close project, the help/more menu at the end of the bar on the theme choice.
  await page.getByTestId('project-menu').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByTestId('menu-close-project')).toBeFocused();
  expect(await scanBothThemes('project-menu')).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('project-menu')).toBeFocused();
  await page.getByTestId('app-menu').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByTestId('menu-theme-system')).toBeFocused();
  expect(await scanBothThemes('menu')).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('app-menu')).toBeFocused();

  await page.getByTestId('rail-history').press('Enter');
  const history = page.getByTestId('history-dialog');
  await expect(history).toBeVisible();
  expect(await scanBothThemes('history')).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(history).toHaveCount(0);
  await page.emulateMedia({ colorScheme: null });
});

test('Tab visits the regions in their visual order', async () => {
  // S47.4: the project menu is the top bar's first control; the help/more menu is its last.
  await page.getByTestId('project-menu').focus();
  const visited: string[] = [];
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press('Tab');
    const { region } = await focused();
    if (region && visited.at(-1) !== region) visited.push(region);
    if (region === 'region-editor' && (await focused()).inEditor) break;
  }
  expect(visited).toEqual(['region-topbar', 'rail', 'region-files', 'region-editor']);
});

test('F6 / Shift+F6 move between regions, also out of the code editor', async () => {
  await tabOf(page, 'style.css').click();
  await page.locator('.monaco-editor .view-lines').click();
  expect((await focused()).inEditor).toBe(true);
  await page.keyboard.press('F6');
  expect((await focused()).region).toBe('region-preview');
  await page.keyboard.press('F6');
  expect((await focused()).region).toBe('region-problems');
  await page.keyboard.press('F6');
  expect((await focused()).region).toBe('region-status'); // S47.5: the editor's end of the status strip
  await page.keyboard.press('F6');
  expect((await focused()).region).toBe('region-topbar');
  await page.keyboard.press('F6');
  expect((await focused()).region).toBe('rail');
  await page.keyboard.press('F6');
  expect(await focused()).toMatchObject({ region: 'region-files' });
  expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('treeitem');
  await page.keyboard.press('F6');
  expect(await focused()).toMatchObject({ region: 'region-editor', inEditor: true });
  await page.keyboard.press('Shift+F6');
  expect((await focused()).region).toBe('region-files');
});

test('key actions work from the keyboard alone', async () => {
  // Tabs: arrows move between tabs, Delete closes the focused one.
  await tabOf(page, 'style.css').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tabOf(page, 'index.html')).toBeFocused();
  await expect(tabOf(page, 'index.html')).toHaveAttribute('aria-keyshortcuts', 'Delete');
  // Theme from the command menu: arrows to the light theme, Enter chooses it.
  await page.getByTestId('app-menu').focus();
  await page.keyboard.press('Enter');
  for (
    let i = 0;
    i < 6 && !(await page.getByTestId('menu-theme-light').evaluate((el) => el === document.activeElement));
    i += 1
  ) {
    await page.keyboard.press('ArrowDown');
  }
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme-choice', 'light');
  // Zoom, panels and closing the project.
  await page.keyboard.press('ControlOrMeta+=');
  await expect(page.getByTestId('zoom-reset')).toHaveText('17');
  await page.keyboard.press('ControlOrMeta+0');
  await expect(page.getByTestId('zoom-reset')).toHaveText('16');
  await page.keyboard.press('ControlOrMeta+B');
  await expect(page.getByTestId('region-files')).toBeHidden();
  await page.keyboard.press('ControlOrMeta+B');
  await expect(page.getByTestId('region-files')).toBeVisible();
  await page.getByTestId('rail-files').focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('region-files')).toBeHidden();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('region-files')).toBeVisible();
});
