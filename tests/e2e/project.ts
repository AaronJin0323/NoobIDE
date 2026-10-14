import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { repoRoot, tempRoot } from './launch';
import { DOC_END } from './keys';

/** Copies the Chinese-path fixture into a fresh temp folder `<tmp>/网页 练习/中文 路径 项目`. */
export async function makeProject(prefix: string): Promise<{ tmp: string; root: string }> {
  const tmp = await mkdtemp(path.join(tempRoot(), prefix));
  const root = path.join(tmp, '网页 练习', '中文 路径 项目');
  await mkdir(path.dirname(root), { recursive: true });
  await cp(path.join(repoRoot, 'tests', 'fixtures', '中文 路径 项目'), root, { recursive: true });
  return { tmp, root };
}

/** Replaces the native folder dialog in main (Playwright cannot drive it) with one that returns `folder`. */
export async function answerFolderDialog(app: ElectronApplication, folder: string | null): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    const fake = async () => ({ canceled: chosen === null, filePaths: chosen === null ? [] : [chosen] });
    (dialog as unknown as { showOpenDialog: typeof fake }).showOpenDialog = fake;
  }, folder);
}

/** Replaces the native save dialog in main with one that returns `file`. */
export async function answerSaveDialog(app: ElectronApplication, file: string | null): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    const fake = async () => ({ canceled: chosen === null, filePath: chosen ?? '' });
    (dialog as unknown as { showSaveDialog: typeof fake }).showSaveDialog = fake;
  }, file);
}

export async function openProject(app: ElectronApplication, page: Page, root: string): Promise<void> {
  await answerFolderDialog(app, root);
  await page.getByTestId('open-folder').click();
  await page.getByTestId('file-tree').waitFor();
}

/** A file tree row (S08.1) by its relative path. */
export const treeRow = (page: Page, relPath: string) =>
  page.getByTestId('file-tree').locator(`[data-path="${relPath}"]`);

/** Expands the folders on the way in the file tree, then opens the file and waits for its tab to be visible. */
export async function openFile(page: Page, relPath: string): Promise<void> {
  const segments = relPath.split('/');
  for (let i = 1; i < segments.length; i += 1) {
    const folder = treeRow(page, segments.slice(0, i).join('/'));
    if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click();
  }
  await treeRow(page, relPath).click();
  await page.locator(`[data-testid="tab"][data-path="${relPath}"] [role="tab"][aria-selected="true"]`).waitFor();
}

/** The tab (role=tab button) of an open file. */
export const tabOf = (page: Page, relPath: string) =>
  page.locator(`[data-testid="tab"][data-path="${relPath}"] [role="tab"]`);

/**
 * Types plain text on a new last line. Markup such as `<!--` would trigger Monaco's asynchronous auto-closing, which
 * edits the buffer again after a save and makes the test race the editor instead of testing saving.
 */
export async function typeAtEnd(page: Page, text: string): Promise<void> {
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press(DOC_END);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
}

export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}
