import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { axeScan } from './a11y-helpers';
import { launchApp } from './launch';
import { makeProject, openFile, openProject } from './project';

/**
 * S49.2 end to end: the rail, the Code/Preview switch, the viewport switch, the preview toolbar, the chat add-context
 * group and the proposal action rows each have one tab stop; the arrows move within the group (Home/End jump, the
 * ends wrap); Tab leaves it; F6 still visits the regions in the same order; axe stays clean after the moves.
 * The proposal comes from the fake agent (NOOBIDE_AI_FAKE=1, script `edit-and-create`: two changes).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-roving-'));
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html>\n<link rel="stylesheet" href="style.css">\n<h1>你好</h1>\n',
  );
  await writeFile(path.join(root, 'style.css'), 'h1 {\n  color: red;\n}\n');
  app = await launchApp({ NOOBIDE_AI_FAKE: '1', NOOBIDE_AI_FAKE_AGENT: 'edit-and-create' });
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await openFile(page, 'style.css');
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

const activeTestId = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);

/** The group's items that are tab stops (tabIndex 0) — always exactly one. */
const tabStops = (group: Locator) =>
  group.evaluate(
    (el) => [...el.querySelectorAll(':scope > button')].filter((b) => (b as HTMLElement).tabIndex === 0).length,
  );

async function expectOneTabStop(group: Locator) {
  await expect.poll(() => tabStops(group)).toBe(1);
}

/** Tab from the group's focused item lands outside the group (and Shift+Tab from there does not re-enter mid-group). */
async function expectTabLeaves(group: Locator) {
  await page.keyboard.press('Tab');
  expect(await group.evaluate((el) => el.contains(document.activeElement))).toBe(false);
  await page.keyboard.press('Shift+Tab');
  const back = await group.evaluate((el) => el.contains(document.activeElement));
  if (back) expect(await page.evaluate(() => (document.activeElement as HTMLElement).tabIndex)).toBe(0);
}

test('the rail: one tab stop, up/down move, Home/End jump, the ends wrap, Tab leaves', async () => {
  const rail = page.getByTestId('rail');
  await expectOneTabStop(rail);
  await page.getByTestId('rail-files').focus();
  await page.keyboard.press('ArrowDown');
  expect(await activeTestId()).toBe('rail-problems');
  await page.keyboard.press('ArrowRight'); // not the rail's axis
  expect(await activeTestId()).toBe('rail-problems');
  await page.keyboard.press('End');
  const last = await activeTestId();
  expect(last).toMatch(/^rail-/);
  await page.keyboard.press('ArrowDown');
  expect(await activeTestId()).toBe('rail-files');
  await page.keyboard.press('ArrowUp');
  expect(await activeTestId()).toBe(last);
  await page.keyboard.press('Home');
  expect(await activeTestId()).toBe('rail-files');
  await page.keyboard.press('ArrowDown');
  await expectOneTabStop(rail);
  expect(await page.getByTestId('rail-problems').evaluate((el) => (el as HTMLElement).tabIndex)).toBe(0);
  await expectTabLeaves(rail);
});

test('the viewport switch and the preview toolbar move with left/right; Enter still presses', async () => {
  const viewport = page.getByTestId('viewport-switch');
  await expectOneTabStop(viewport);
  // The pressed choice is the tab stop.
  expect(await page.getByTestId('viewport-desktop').evaluate((el) => (el as HTMLElement).tabIndex)).toBe(0);
  await page.getByTestId('viewport-desktop').focus();
  await page.keyboard.press('ArrowRight');
  expect(await activeTestId()).toBe('viewport-mobile');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('viewport-mobile')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowRight'); // wraps
  expect(await activeTestId()).toBe('viewport-desktop');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('viewport-desktop')).toHaveAttribute('aria-pressed', 'true');
  await expectTabLeaves(viewport);

  const toolbar = page.getByRole('toolbar', { name: /./ }).filter({ has: page.getByTestId('preview-open-external') });
  await page.getByTestId('preview-start').click();
  await expect(page.getByTestId('preview-state')).toHaveAttribute('data-state', 'running', { timeout: 20_000 });
  await expect(page.getByTestId('preview-stop')).toBeVisible();
  await expectOneTabStop(toolbar);
  const ids = await toolbar.evaluate((el) =>
    [...el.querySelectorAll(':scope > button:not(:disabled)')].map((b) => b.getAttribute('data-testid')),
  );
  expect(ids.length).toBeGreaterThanOrEqual(2);
  await page.getByTestId(ids[0] as string).focus();
  await page.keyboard.press('ArrowRight');
  expect(await activeTestId()).toBe(ids[1]);
  await page.keyboard.press('End');
  expect(await activeTestId()).toBe(ids.at(-1));
  await page.keyboard.press('Home');
  expect(await activeTestId()).toBe(ids[0]);
  await expectTabLeaves(toolbar);
});

test('the chat add-context group and the proposal action rows move with left/right', async () => {
  await page.evaluate(async () => {
    const ai = (window.noobide as unknown as { ai: { setKey(r: { provider: string; key: string }): Promise<unknown> } })
      .ai;
    await ai.setKey({ provider: 'anthropic', key: 'fake-key-for-tests' });
    window.dispatchEvent(new Event('noobide:ai-status-changed'));
  });
  await page.getByTestId('rail-ai').click();
  const panel = page.getByTestId('region-ai');
  await expect(panel).toBeVisible();

  const add = panel.locator('.ai-context-add');
  await expectOneTabStop(add);
  await panel.getByTestId('ai-add-file').focus();
  await page.keyboard.press('ArrowRight');
  expect(await activeTestId()).toBe('ai-add-selection');
  await page.keyboard.press('End');
  expect(await activeTestId()).toBe('ai-add-preview');
  await page.keyboard.press('ArrowRight');
  expect(await activeTestId()).toBe('ai-add-file');
  await expectTabLeaves(add);

  await panel.getByTestId('ai-kind').locator('input[value="agent"]').check();
  await panel.getByTestId('ai-input').fill('Make the heading blue and add an about page');
  await panel.getByTestId('ai-input').press('Enter');
  const consent = panel.getByTestId('ai-consent-allow');
  if (await consent.isVisible().catch(() => false)) await consent.click();
  const changes = panel.getByTestId('ai-turn').last().getByTestId('agent-change');
  await expect(changes).toHaveCount(2, { timeout: 30_000 });

  const row = changes.nth(0).locator('.agent-change-actions');
  await expectOneTabStop(row);
  await changes.nth(0).getByTestId('agent-accept').focus();
  await page.keyboard.press('ArrowRight');
  expect(await activeTestId()).toBe('agent-reject');
  await page.keyboard.press('ArrowLeft');
  expect(await activeTestId()).toBe('agent-accept');
  await expectTabLeaves(row);

  const all = panel.locator('.agent-proposal-actions');
  await expectOneTabStop(all);
  await all.getByTestId('agent-accept-all').focus();
  await page.keyboard.press('ArrowRight');
  expect(await activeTestId()).toBe('agent-reject-all');

  // axe stays clean with the groups' tabindex values in place.
  const findings = (await axeScan(page)).map((f) => `${f.id} (${f.impact}) ${f.targets.join(', ')}`);
  expect(findings).toEqual([]);
  await page.getByTestId('rail-ai').click();
  await expect(panel).toBeHidden();
});

test('F6 visits the regions in the same order and lands on each group’s tab stop', async () => {
  await page.locator('.monaco-editor .view-lines').click();
  const order: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press('F6');
    order.push(
      await page.evaluate(
        () =>
          document.activeElement
            ?.closest('[data-testid^="region-"], [data-testid="rail"]')
            ?.getAttribute('data-testid') ?? '',
      ),
    );
  }
  expect(order).toEqual(['region-preview', 'region-problems', 'region-status', 'region-topbar']);
  // The rail's tab stop is the item last used (the AI button, clicked to close the chat), and F6 lands on it.
  await page.keyboard.press('F6');
  expect(await activeTestId()).toBe('rail-ai');
});

test('the Code/Preview switch of a narrow window moves with left/right', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(800, 600));
  const narrow = page.getByTestId('narrow-switch');
  await expect(narrow).toBeVisible();
  await expectOneTabStop(narrow);
  const buttons = narrow.locator(':scope > button');
  await buttons.nth(0).focus();
  await page.keyboard.press('ArrowRight');
  expect(await buttons.nth(1).evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Home');
  expect(await buttons.nth(0).evaluate((el) => el === document.activeElement)).toBe(true);
  await expectTabLeaves(narrow);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800));
});
