import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { axeScan } from './a11y-helpers';
import { launchApp } from './launch';
import { makeProject, openProject, treeRow } from './project';

/**
 * S52.3 end to end: select several tree entries with Shift/Ctrl/Cmd-click and Shift+arrows, hear the count as text,
 * and move or trash the whole selection — from the context menu and from the keyboard alone. The OS trash is
 * replaced in main by a recorder (the real Recycle Bin / Trash cannot be inspected from a test); nothing is deleted.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
const isMac = process.platform === 'darwin';
const PRIMARY = isMac ? 'Meta' : 'Control';

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-multi-'));
  await mkdir(path.join(root, '目标 文件夹'));
  for (const name of ['一 号.html', '二 号.html', '三 号.html', '四 号.css']) {
    await writeFile(path.join(root, name), `${name}\n`);
  }
  app = await launchApp();
  page = await app.firstWindow();
  await openProject(app, page, root);
  // shell.trashItem → a recorder that moves the item into a folder of the test, so nothing is deleted.
  const bin = path.join(tmp, '回收站');
  await mkdir(bin);
  await app.evaluate(({ shell }, folder) => {
    const load = (process as unknown as { getBuiltinModule: (id: string) => unknown }).getBuiltinModule;
    const fs = load('node:fs') as { renameSync: (from: string, to: string) => void };
    const p = load('node:path') as { join: (...s: string[]) => string; basename: (s: string) => string };
    const g = globalThis as unknown as { trashed: string[] };
    g.trashed = [];
    (shell as unknown as { trashItem: (full: string) => Promise<void> }).trashItem = async (full) => {
      if (full.endsWith('四 号.css')) throw new Error('locked by another program');
      g.trashed.push(full);
      fs.renameSync(full, p.join(folder, p.basename(full)));
    };
  }, bin);
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

/** Opens the tree's context menu with Shift+F10 and runs `command` with the arrow keys and Enter only. */
async function menuByKeyboard(command: string) {
  await page.keyboard.press('Shift+F10');
  await expect(page.getByTestId('tree-menu')).toBeVisible();
  for (let i = 0; i < 20; i += 1) {
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-command') ?? null);
    if (focused === command) break;
    await page.keyboard.press('ArrowDown');
  }
  await expect(page.locator(`[data-testid="tree-menu"] [data-command="${command}"]`)).toBeFocused();
  await page.keyboard.press('Enter');
}

/** Moves the keyboard focus from `from` to `to` with Ctrl/Cmd+arrows (the selection stays). */
async function focusByKeyboard(from: string, to: string) {
  const order = await page.getByTestId('tree-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-path')));
  const steps = order.indexOf(to) - order.indexOf(from);
  for (let i = 0; i < Math.abs(steps); i += 1)
    await page.keyboard.press(`${PRIMARY}+${steps > 0 ? 'ArrowDown' : 'ArrowUp'}`);
  await expect(treeRow(page, to)).toBeFocused();
}

const selected = () => page.getByTestId('file-tree').locator('[role="treeitem"][aria-selected="true"]');
const status = () => page.getByTestId('tree-selection-status');

test('Ctrl/Cmd-click and Shift-click select several rows; the count is announced as text (S52.3)', async () => {
  await expect(page.getByTestId('file-tree')).toHaveAttribute('aria-multiselectable', 'true');
  await treeRow(page, '一 号.html').click();
  await treeRow(page, '三 号.html').click({ modifiers: [PRIMARY] });
  await expect(selected()).toHaveCount(2);
  await expect(status()).toHaveText('已选择 2 项');
  await treeRow(page, '四 号.css').click({ modifiers: ['Shift'] });
  // A Shift range replaces the selection: the rows from the anchor (三 号) to 四 号, in the tree's own order.
  const order = await page.getByTestId('tree-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-path')));
  const span = Math.abs(order.indexOf('四 号.css') - order.indexOf('三 号.html')) + 1;
  await expect(selected()).toHaveCount(span);
  await expect(status()).toHaveText(span > 1 ? `已选择 ${span} 项` : '');
  await treeRow(page, '三 号.html').click({ modifiers: [PRIMARY] }); // toggled out
  await expect(selected()).toHaveCount(span - 1);
  expect(await axeScan(page)).toEqual([]);
});

test('Shift+arrows extend the selection; Move to… from the keyboard moves it all (S52.3)', async () => {
  await treeRow(page, '一 号.html').click();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(status()).toHaveText('已选择 2 项');
  await expect(selected()).toHaveCount(2);
  // The context menu by keyboard (Shift+F10) → Move to… → filter → Enter.
  await menuByKeyboard('move-to');
  await expect(page.getByTestId('move-dialog')).toContainText('移动 2 项');
  await page.keyboard.type('目标');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => readdir(path.join(root, '目标 文件夹')).then((names) => names.sort()))
    .toEqual(['一 号.html', '三 号.html'].sort());
});

test('dragging a selected row drags the whole selection (S52.3)', async () => {
  await treeRow(page, '二 号.html').click();
  await treeRow(page, 'README.md').click({ modifiers: [PRIMARY] });
  await treeRow(page, '二 号.html').dragTo(treeRow(page, '子 文件夹'));
  await expect
    .poll(() => readdir(path.join(root, '子 文件夹')).then((names) => names.sort()))
    .toEqual(['README.md', '二 号.html', '页面 二.html'].sort());
});

test('Space toggles a row; Ctrl/Cmd+D duplicates the whole selection, keyboard only (S52.3)', async () => {
  await treeRow(page, 'style.css').click();
  await focusByKeyboard('style.css', '四 号.css');
  await page.keyboard.press('Space');
  await expect(status()).toHaveText('已选择 2 项');
  await page.keyboard.press('ControlOrMeta+d');
  await expect.poll(() => readdir(root)).toEqual(expect.arrayContaining(['style copy.css', '四 号 copy.css']));
});

test('the context menu trashes the whole selection, keyboard only (S52.3)', async () => {
  await treeRow(page, 'style copy.css').click();
  await focusByKeyboard('style copy.css', '四 号 copy.css');
  await page.keyboard.press('Space');
  await menuByKeyboard('delete');
  const dialog = page.getByTestId('delete-dialog');
  await expect(dialog).toContainText('2 项');
  await page.keyboard.press('Tab'); // focus starts on Cancel; Tab reaches the confirm button
  await page.keyboard.press('Enter');
  await expect.poll(() => readdir(root)).not.toContain('style copy.css');
  // 四 号 copy.css is not locked by the fake trash (only 四 号.css is): both went to the trash. The files go one
  // after the other, so the second may still be on its way when the first is gone (seen on a hosted Windows runner).
  await expect.poll(() => readdir(root)).not.toContain('四 号 copy.css');
  await expect(page.getByTestId('file-op-notice')).toContainText('2 项');
});

test('Delete trashes the selection; a partial failure lists what stayed (S52.3)', async () => {
  await treeRow(page, 'style.css').click();
  await treeRow(page, '四 号.css').click({ modifiers: [PRIMARY] });
  await page.keyboard.press(isMac ? 'Meta+Backspace' : 'Delete');
  const dialog = page.getByTestId('delete-dialog');
  await expect(dialog).toContainText('2 项');
  await expect(page.getByTestId('delete-list')).toContainText('四 号.css');
  await dialog.getByTestId('confirm-button').click();
  await expect(page.getByTestId('file-op-failures')).toContainText('四 号.css');
  const trashed = await app.evaluate(() => (globalThis as unknown as { trashed: string[] }).trashed);
  // The earlier test trashed the two copies; this one adds style.css, while 四 号.css stays (its trash failed).
  expect(trashed.map((p) => path.basename(p))).toEqual(['style copy.css', '四 号 copy.css', 'style.css']);
  expect(await readdir(root)).toContain('四 号.css');
  expect(await readdir(root)).not.toContain('style.css');
});

test('Ctrl/Cmd+A selects every visible row and says how many (S52.3)', async () => {
  await treeRow(page, 'index.html').click();
  await page.keyboard.press('ControlOrMeta+a');
  const rows = await page.getByTestId('tree-row').count();
  await expect(selected()).toHaveCount(rows);
  await expect(status()).toHaveText(`已选择 ${rows} 项`);
});
