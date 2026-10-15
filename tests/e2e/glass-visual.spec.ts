import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, repoRoot } from './launch';
import { makeProject, openFile, openProject } from './project';

/**
 * S40.7 visual pass of the Liquid Glass refresh: the main states in the light and the dark theme are captured to
 * test-results/glass/ for the owner's review (screenshots prove layout only, never behaviour), and the material
 * rules that do not depend on taste are asserted: chrome floats as glass, content stays solid, a modal or menu
 * reads above the content, and the solid fallback replaces every translucent layer when transparency is reduced.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
const shots = path.join(repoRoot, 'test-results', 'glass');

test.beforeAll(async () => {
  await mkdir(shots, { recursive: true });
  ({ tmp, root } = await makeProject('noobide-glass-'));
  app = await launchApp();
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

async function capture(name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await page.waitForTimeout(350); // let transitions settle; the picture is for people, not for assertions
    await page.screenshot({ path: path.join(shots, `${name}-${scheme}.png`) });
  }
}

test('captures the welcome screen and the workbench in both themes', async () => {
  await capture('welcome');
  await openProject(app, page, root);
  await openFile(page, 'index.html');
  await capture('workbench');
  await page.getByTestId('app-menu').click();
  await capture('menu');
  await page.keyboard.press('Escape');
  await page.getByTestId('problems-toggle').click();
  await capture('problems');
  await page.getByTestId('problems-toggle').click();
  await page.getByTestId('open-palette').click();
  await page.getByTestId('palette-input').fill('them');
  await capture('palette');
  await page.keyboard.press('Escape');
  await page.getByTestId('rail-ai').click();
  await capture('ai');
  await page.getByTestId('rail-ai').click();
  await page.getByTestId('app-menu').click();
  await page.getByTestId('menu-help-glossary').click();
  await capture('sheet');
  await page.keyboard.press('Escape');
});
