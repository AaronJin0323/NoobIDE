import { cp, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { listTemplates } from '../../src/workspace/templates';
import { launchApp, repoRoot, tempRoot } from './launch';
import {
  answerFolderDialog,
  collectConsoleErrors,
  documentText,
  focusEditor,
  openFile,
  tabOf,
  treeRow,
  typeAtEnd,
} from './project';
import { replaceEditorText } from './preview-helpers';

/**
 * S21.3 / S21.4 end to end: browse a file's versions, compare with the current content, restore (the current
 * content is kept as a version first and the restore goes through the editor and the save pipeline), restore a
 * deleted file, and the storage controls: usage, cleanup, clear, reveal location, orphaned project histories.
 * Projects live under a temp path with Chinese characters and spaces.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let userData: string;
let rootA: string;
let rootB: string;
let consoleErrors: string[];
let original: string;

const listing = await listTemplates(path.join(repoRoot, 'resources', 'templates'));
if (!listing.ok) throw new Error(listing.message);
const intro = listing.value.templates.find((t) => t.id === 'personal-intro')!;

async function copyTemplate(root: string) {
  for (const rel of intro.files) {
    const target = path.join(root, ...rel.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(intro.dir, ...rel.split('/')), target);
  }
}

const dialog = () => page.getByTestId('history-dialog');
const versions = () => page.getByTestId('history-version');
const notice = () => page.getByTestId('history-notice');

async function stubShell() {
  await app.evaluate(
    ({ shell }, trashDir) => {
      const g = globalThis as unknown as { __opened: string[] };
      g.__opened = [];
      const load = (process as unknown as { getBuiltinModule: (id: string) => unknown }).getBuiltinModule;
      const fs = load('node:fs') as { renameSync: (from: string, to: string) => void };
      const nodePath = load('node:path') as { join: (...p: string[]) => string; basename: (p: string) => string };
      (shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = async (full: string) => {
        fs.renameSync(full, nodePath.join(trashDir, `${Date.now()}-${nodePath.basename(full)}`));
      };
      (shell as unknown as { openPath: (p: string) => Promise<string> }).openPath = async (full: string) => {
        g.__opened.push(full);
        return '';
      };
    },
    path.join(tmp, 'trash'),
  );
}

async function openFolder(root: string, testId: 'welcome-open-folder' | 'open-other-folder') {
  await answerFolderDialog(app, root);
  await page.getByTestId(testId).click();
  await expect(page.getByTestId('project-name')).toHaveText(path.basename(root));
}

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(tempRoot(), 'noobide-history-'));
  userData = path.join(tmp, 'userdata');
  await mkdir(path.join(tmp, 'trash'));
  rootA = path.join(tmp, '网页 练习', '我的 主页');
  rootB = path.join(tmp, '网页 练习', '第二个 网页');
  await copyTemplate(rootA);
  await copyTemplate(rootB);
  original = await readFile(path.join(rootA, 'index.html'), 'utf8');
  app = await launchApp({}, { userDataDir: userData });
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await stubShell();
  await openFolder(rootA, 'welcome-open-folder');
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('versions of a file are listed newest first, and a version is compared with the current content', async () => {
  await openFile(page, 'index.html');
  await replaceEditorText(app, page, original.replace('你好，我是小雨', '你好，我是林小雨'));
  await page.keyboard.press('ControlOrMeta+S');
  await expect.poll(() => readFile(path.join(rootA, 'index.html'), 'utf8')).toContain('林小雨');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', /saved|clean/);

  await page.getByTestId('show-history').click();
  await expect(dialog()).toBeVisible();
  await expect(page.getByTestId('history-file').filter({ hasText: 'index.html' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(versions()).toHaveCount(2);
  await expect(versions().nth(0)).toHaveAttribute('data-reason', 'after-save');
  await expect(versions().nth(0)).toContainText('保存后');
  await expect(versions().nth(1)).toContainText('保存前');

  await versions().nth(1).click();
  await expect(page.getByTestId('history-diff-summary')).toHaveText('恢复后多出 1 行 · 替换掉 1 行');
  const diff = page.getByTestId('history-diff');
  await expect(diff.locator('[data-kind="added"]')).toContainText('你好，我是小雨');
  await expect(diff.locator('[data-kind="removed"]')).toContainText('你好，我是林小雨');
  // Changed lines are named in text for screen readers, not only by colour and sign.
  await expect(diff.locator('[data-kind="added"] .sr-only')).toHaveText('恢复后会回来');
});

test('restore keeps the current content as a version first and goes through the editor and the save pipeline', async () => {
  await expect(page.getByTestId('history-restore')).toHaveText('恢复这个版本');
  await page.getByTestId('history-restore').click();
  await expect(notice()).toHaveText('已恢复。现在的内容已经保存为一个版本，可以在列表里找到。');
  await expect.poll(() => readFile(path.join(rootA, 'index.html'), 'utf8')).toBe(original);
  // The replaced content ("林小雨") is still a version: newest is the restored content, then the edited one.
  await expect(versions()).toHaveCount(3);
  await versions().nth(1).click();
  await expect(page.getByTestId('history-diff').locator('[data-kind="added"]')).toContainText('林小雨');

  // Escape is ignored while the restore is still refreshing the lists (Close is disabled until then).
  await expect(page.getByTestId('history-close')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog()).toHaveCount(0);
  await expect.poll(() => documentText(page.locator('.monaco-editor'))).toContain('你好，我是小雨');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', /saved|clean/);
  // The restore is one ordinary edit in the editor: Ctrl+Z brings the previous text back.
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+Z');
  await expect.poll(() => documentText(page.locator('.monaco-editor'))).toContain('你好，我是林小雨');
  await page.keyboard.press('ControlOrMeta+S');
  await expect.poll(() => readFile(path.join(rootA, 'index.html'), 'utf8')).toContain('林小雨');
});

test('unsaved edits are saved (and kept as a version) before a restore replaces them', async () => {
  await typeAtEnd(page, 'UNSAVEDMARK');
  await page.getByTestId('rail-history').click();
  await expect(dialog()).toBeVisible();
  await page.getByTestId('history-file').filter({ hasText: 'index.html' }).click();
  await versions().last().click(); // the original
  await page.getByTestId('history-restore').click();
  await expect(notice()).toHaveAttribute('data-kind', 'ok');
  await expect.poll(() => readFile(path.join(rootA, 'index.html'), 'utf8')).toBe(original);
  await versions().nth(1).click();
  await expect(
    page.getByTestId('history-diff').locator('[data-kind="added"]').filter({ hasText: 'UNSAVEDMARK' }),
  ).toHaveCount(1);
  await page.getByTestId('history-close').click();
  await expect(tabOf(page, 'index.html')).toBeVisible();
});

test('a deleted file is listed as deleted and can be restored with a version of its content', async () => {
  const css = await readFile(path.join(rootA, 'style.css'), 'utf8');
  await treeRow(page, 'style.css').click();
  await page.keyboard.press('Delete');
  await page.getByTestId('confirm-button').click();
  await expect(treeRow(page, 'style.css')).toHaveCount(0);

  await page.getByTestId('rail-history').click();
  const row = page.getByTestId('history-file').filter({ hasText: 'style.css' });
  await expect(row.getByTestId('history-deleted')).toHaveText('已删除');
  await row.click();
  await expect(versions()).toHaveCount(1);
  await expect(versions().first()).toContainText('删除前');
  await versions().first().click();
  await expect(page.getByText('这个文件已经被删除。下面是这个版本的全部内容。')).toBeVisible();
  await page.getByTestId('history-restore').click();
  await expect(notice()).toHaveText('文件已经恢复，并在编辑器里打开了。');
  expect(await readFile(path.join(rootA, 'style.css'), 'utf8')).toBe(css);
  await expect(row.getByTestId('history-deleted')).toHaveCount(0);
  // The notice shows before the restore has refreshed the version list and the storage usage; until it has, the
  // window stays open on Escape (Close is disabled). On a slow machine Escape came too early and the window stayed.
  await expect(page.getByTestId('history-close')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog()).toHaveCount(0);
  await expect(treeRow(page, 'style.css')).toBeVisible({ timeout: 5000 });
  await expect(tabOf(page, 'style.css')).toBeVisible();
});

test('Format Document keeps the text as it was before formatting, unsaved edits included (PLAN §7)', async () => {
  await openFile(page, 'style.css');
  const formatted = await readFile(path.join(rootA, 'style.css'), 'utf8');
  // Hand-written CSS goes in and is formatted right away, before autosave writes it: the only copy of this exact text
  // is the editor buffer, and the save that follows the format writes the formatted text.
  // The shortcut keeps the focus in the editor (opening the Editor options panel would blur it and save first).
  await replaceEditorText(app, page, `${formatted}\nh1{color:red;margin:0} /* FMT-MARK */\n`);
  await page.keyboard.press('Shift+Alt+F');
  await expect.poll(() => readFile(path.join(rootA, 'style.css'), 'utf8')).toContain('color: red');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', /saved|clean/);

  await page.getByTestId('show-history').click();
  await expect(dialog()).toBeVisible();
  const kept = versions().and(page.locator('[data-reason="before-format"]'));
  await expect(kept).toHaveCount(1);
  await expect(kept).toContainText('格式化前');
  await kept.click();
  // Restoring it would bring the hand-written line back.
  await expect(page.getByTestId('history-diff').locator('[data-kind="added"]')).toContainText(
    'h1{color:red;margin:0} /* FMT-MARK */',
  );
  await page.getByTestId('history-close').click();
  await expect(dialog()).toHaveCount(0);
});

test('storage: usage and policy are shown, the history folder can be revealed and cleaned up (S21.4)', async () => {
  await page.getByTestId('rail-history').click();
  await expect(page.getByTestId('history-usage')).toHaveText(/^历史占用 .+（上限 256\.0 MB）$/);
  await expect(page.getByTestId('history-storage')).toContainText('每个文件最多保留 50 个版本');
  await expect(page.getByTestId('history-location')).toHaveText(path.join(userData, 'history'));
  await page.getByTestId('history-reveal').click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened))
    .toEqual([path.join(userData, 'history')]);
  await page.getByTestId('history-cleanup').click();
  await expect(notice()).toContainText('清理完成');
  // Focus stays inside the window.
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="history-dialog"]'))).toBe(true);
  }
  await page.getByTestId('history-close').click();
});

test('a moved project leaves an orphaned history that is listed with its size and can be cleared (ADR 0006)', async () => {
  await openFolder(rootB, 'open-other-folder');
  const moved = path.join(tmp, '网页 练习', '改名 以后');
  // Windows may still hold the folder for a moment after its watcher closed.
  await expect
    .poll(
      () =>
        rename(rootA, moved).then(
          () => true,
          () => false,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);

  await openFile(page, 'index.html');
  await page.getByTestId('show-history').click();
  await expect(page.getByText('这个项目还没有历史版本。保存文件后，旧版本会出现在这里。')).toBeVisible();
  const orphan = page.getByTestId('history-orphan');
  await expect(orphan).toHaveCount(1);
  await expect(orphan).toContainText(rootA);
  await expect(orphan).toContainText(/2 个文件，\d+(\.\d)? (B|KB)/);
  await orphan.getByTestId('history-orphan-clear').click();
  await expect(orphan).toContainText('确定清除这份历史？清除后无法找回。'); // asks first, like the other clears
  await orphan.getByTestId('history-orphan-confirm').click();
  await expect(orphan).toHaveCount(0);
  await expect(page.getByTestId('history-orphans')).toBeEmpty();
  await expect(page.getByText('没有。')).toBeVisible();
  await page.getByTestId('history-close').click();
});

test('clearing asks first and removes the project history; project files are untouched (S21.4)', async () => {
  await typeAtEnd(page, 'CHANGED 改动');
  await page.keyboard.press('ControlOrMeta+S');
  await expect.poll(() => readFile(path.join(rootB, 'index.html'), 'utf8')).toContain('改动');
  // The new content is visible on disk before the save has finished (the folder is still being flushed), and the
  // save's versions are queued only when it finishes. The window lists versions once when it opens, so wait for
  // the save itself, not just the file.
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', /saved|clean/);
  await page.getByTestId('show-history').click();
  await expect(versions()).toHaveCount(2);
  await page.getByTestId('history-clear-project').click();
  await expect(page.getByTestId('history-confirm')).toContainText('清除后无法找回');
  await page.keyboard.press('Escape'); // first Escape only cancels the confirmation
  await expect(page.getByTestId('history-confirm')).toHaveCount(0);
  await expect(dialog()).toBeVisible();
  await page.getByTestId('history-clear-project').click();
  await page.getByTestId('history-confirm-clear').click();
  await expect(notice()).toHaveText('历史已清除。');
  await expect(page.getByTestId('history-file')).toHaveCount(0);
  expect(await readFile(path.join(rootB, 'index.html'), 'utf8')).toContain('改动');

  await page.getByTestId('history-clear-all').click();
  await page.getByTestId('history-confirm-clear').click();
  await expect(notice()).toHaveText('历史已清除。');
  await page.getByTestId('history-close').click();
  expect(consoleErrors).toEqual([]);
});

test('the history window follows the interface language (en)', async () => {
  await page.getByTestId('switch-language').click();
  await expect(page.getByTestId('show-history')).toHaveText('History');
  await page.getByTestId('rail-history').click();
  await expect(dialog().getByRole('heading', { name: 'Local history' })).toBeVisible();
  await expect(page.getByTestId('history-usage')).toHaveText(/^History uses .+ \(limit 256\.0 MB\)$/);
  await page.keyboard.press('Escape');
  await page.getByTestId('switch-language').click();
});
