import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
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
 * Puts the keyboard focus in the open editor without clicking: on a short window (the Windows CI runner) a banner
 * can cover the middle of the text area, where a click on `.view-lines` would land.
 */
export async function focusEditor(page: Page): Promise<void> {
  await page.locator('.monaco-editor').getByRole('textbox').first().focus();
}

/**
 * Types plain text on a new last line. Markup such as `<!--` would trigger Monaco's asynchronous auto-closing, which
 * edits the buffer again after a save and makes the test race the editor instead of testing saving.
 */
export async function typeAtEnd(page: Page, text: string): Promise<void> {
  await focusEditor(page);
  await page.keyboard.press(DOC_END);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
}

/** Waits until the renderer has painted twice (Monaco renders a scroll on the next animation frame). */
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/**
 * The text of a whole Monaco document, not only the lines that fit on screen: Monaco renders just the visible lines,
 * so how much of a file is in the DOM depends on the window size (the Windows CI runner's 1024×768 display gives a
 * much shorter editor than a Mac). `editor` is a `.monaco-editor` or a `.monaco-diff-editor` (its sides scroll
 * together). The view is scrolled through the document with the mouse wheel and back to where it was: the cursor,
 * selection and content are untouched. Lines are concatenated as Monaco renders them, so search within one line.
 */
export async function documentText(editor: Locator): Promise<string> {
  const page = editor.page();
  // The editor's own text area (a diff editor: its modified side), not one inside a widget such as find.
  const own = ':scope > .overflow-guard, .editor.modified > .monaco-editor > .overflow-guard';
  const guard = editor.locator(own).first();
  // Monaco renders spaces as no-break spaces.
  const read = async () => ((await editor.textContent()) ?? '').replaceAll(String.fromCharCode(0xa0), ' ');
  // Where the view is: the vertical scrollbar's slider and the rendered text (either changes when it scrolls).
  const slider = () =>
    guard.evaluate((el) => el.querySelector<HTMLElement>('.scrollbar.vertical .slider')?.style.top ?? '');
  const position = async () => `${await slider()}|${await read()}`;
  const box = await guard.boundingBox();
  if (!box) return read();
  // Chromium turns every mouse.wheel call into one wheel tick, which Monaco scrolls by 50 px. A line can only be
  // skipped if it fits in the part of a tick the view does not show, so the view must show more than 50 px minus a
  // line; less than that is not an editor anyone could read either.
  const lineHeight = await guard.evaluate((el) => el.querySelector<HTMLElement>('.view-line')?.offsetHeight ?? 0);
  if (box.height + lineHeight <= WHEEL_TICK_PX) {
    throw new Error(`documentText: the editor shows ${box.height} px, too little to scroll through line by line`);
  }
  /** Wheels one tick at a time until the view stops moving; returns how many ticks moved it. */
  const wheelToEnd = async (direction: 1 | -1): Promise<number> => {
    for (let moved = 0; moved < 10_000; moved += 1) {
      const before = await position();
      await page.mouse.wheel(0, direction * WHEEL_TICK_PX);
      await nextFrames(page);
      if ((await position()) === before) return moved;
    }
    throw new Error('documentText: the view never stopped scrolling');
  };
  // Over the line numbers: the wheel scrolls the editor from there, and no hover opens over a word (a hover widget
  // under the pointer would take the wheel events itself).
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  const ticksFromTop = await wheelToEnd(-1);
  const parts: string[] = [await read()];
  for (let i = 0; i < 10_000; i += 1) {
    const before = await position();
    await page.mouse.wheel(0, WHEEL_TICK_PX);
    await nextFrames(page);
    if ((await position()) === before) break; // the last line is in view
    parts.push(await read());
  }
  // Back to where the view was.
  await wheelToEnd(-1);
  for (let i = 0; i < ticksFromTop; i += 1) await page.mouse.wheel(0, WHEEL_TICK_PX);
  await nextFrames(page);
  // Away from the text, so no Monaco hover opens over what the test clicks next.
  await page.mouse.move(0, 0);
  return parts.join('\n');
}

/** How far Monaco scrolls for one wheel tick (its SCROLL_WHEEL_SENSITIVITY). */
const WHEEL_TICK_PX = 50;

export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}
