import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, tempRoot } from './launch';
import { DOC_END } from './keys';

/**
 * S08 end to end: the accessible file tree (keyboard only), create and rename with cross-platform validation,
 * never overwriting, delete to the OS trash after confirmation, reveal in File Explorer / Finder, and the watcher
 * (S07.3) updating the tree. shell.trashItem and shell.showItemInFolder are replaced in main by recorders (the
 * trash recorder moves the file into a folder outside the project), so test runs do not fill the real Recycle Bin
 * or open Explorer windows.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let fakeTrash: string;
/** The OS trash as the app names it: 废纸篓 (Trash) on macOS, 回收站 (Recycle Bin) elsewhere. */
const trashName = process.platform === 'darwin' ? '废纸篓' : '回收站';

const p = (...segments: string[]) => path.join(root, ...segments);
const tree = () => page.getByTestId('file-tree');
const row = (relPath: string) => tree().locator(`[data-path="${relPath}"]`);
const focusedPath = () => page.evaluate(() => document.activeElement?.getAttribute('data-path') ?? null);
const status = () => page.getByTestId('save-status');

async function recordShell(mode: 'ok' | 'fail' | 'slow') {
  await app.evaluate(
    ({ shell }, { mode, trashDir }) => {
      const g = globalThis as unknown as { __trashed: string[]; __revealed: string[] };
      g.__trashed = [];
      g.__revealed = [];
      // The evaluated function runs in main without `require`; Node's builtin loader is available there.
      const load = (process as unknown as { getBuiltinModule: (id: string) => unknown }).getBuiltinModule;
      const fs = load('node:fs') as { renameSync: (from: string, to: string) => void };
      const nodePath = load('node:path') as { join: (...p: string[]) => string; basename: (p: string) => string };
      (shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = async (full: string) => {
        g.__trashed.push(full);
        if (mode === 'fail') throw new Error('The process cannot access the file because it is being used');
        if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 2000));
        fs.renameSync(full, nodePath.join(trashDir, `${Date.now()}-${nodePath.basename(full)}`));
      };
      (shell as unknown as { showItemInFolder: (p: string) => void }).showItemInFolder = (full: string) => {
        g.__revealed.push(full);
      };
    },
    { mode, trashDir: fakeTrash },
  );
}

const recorded = (name: '__trashed' | '__revealed') =>
  app.evaluate((_electron, key) => (globalThis as unknown as Record<string, string[]>)[key] ?? [], name);

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(tempRoot(), 'noobide-e2e-tree-'));
  root = path.join(tmp, '网页 练习', '树 项目');
  fakeTrash = path.join(tmp, 'trash');
  await mkdir(fakeTrash, { recursive: true });
  await mkdir(p('子 文件夹'), { recursive: true });
  await mkdir(p('css'));
  await writeFile(p('index.html'), '<p>首页</p>\n');
  await writeFile(p('style.css'), 'h1 {}\n');
  await writeFile(p('css', 'a.css'), 'a {}\n');
  await writeFile(p('子 文件夹', '页面 二.html'), '<p>二</p>\n');
  app = await launchApp();
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  await app.evaluate(({ dialog }, chosen) => {
    const fake = async () => ({ canceled: false, filePaths: [chosen] });
    (dialog as unknown as { showOpenDialog: typeof fake }).showOpenDialog = fake;
  }, root);
  await recordShell('ok');
  await page.getByTestId('open-folder').click();
  await expect(row('index.html')).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('the tree uses ARIA tree roles, folders first (S08.1)', async () => {
  await expect(tree()).toHaveAttribute('role', 'tree');
  const items = tree().getByRole('treeitem');
  // Accessible names are the real file names (the S20.3 role tag is the description, not part of the name).
  await expect(items).toHaveCount(4);
  for (const [i, name] of ['css', '子 文件夹', 'index.html', 'style.css'].entries()) {
    await expect(items.nth(i)).toHaveAccessibleName(name);
  }
  await expect(row('index.html')).toHaveAccessibleDescription('页面结构');
  await expect(row('css')).toHaveAttribute('aria-expanded', 'false');
  await expect(row('css')).toHaveAttribute('aria-level', '1');
  await expect(row('index.html')).toHaveAttribute('aria-posinset', '3');
  await expect(row('index.html')).toHaveAttribute('aria-setsize', '4');
  await expect(row('index.html')).not.toHaveAttribute('aria-expanded');
});

test('keyboard only: Tab into the tree, arrows move and expand, Enter opens (S08.1)', async () => {
  await page.getByTestId('open-other-folder').focus();
  await page.keyboard.press('Tab');
  await expect.poll(focusedPath).toBe('css');
  await page.keyboard.press('ArrowRight'); // expand
  await expect(row('css')).toHaveAttribute('aria-expanded', 'true');
  await expect(row('css/a.css')).toHaveAttribute('aria-level', '2');
  await page.keyboard.press('ArrowRight'); // to the first child
  await expect.poll(focusedPath).toBe('css/a.css');
  await expect(row('css/a.css')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid="tab"].selected')).toHaveAttribute('data-path', 'css/a.css');
  await expect(row('css/a.css')).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('ArrowLeft'); // to the parent
  await expect.poll(focusedPath).toBe('css');
  await page.keyboard.press('ArrowLeft'); // collapse
  await expect(row('css')).toHaveAttribute('aria-expanded', 'false');
  await expect(row('css/a.css')).toHaveCount(0);
  await page.keyboard.press('End');
  await expect.poll(focusedPath).toBe('style.css');
  await page.keyboard.press('ArrowUp');
  await expect.poll(focusedPath).toBe('index.html');
  await page.keyboard.press('Home');
  await expect.poll(focusedPath).toBe('css');
  // Only one row is in the tab order (roving tabindex).
  await expect(tree().locator('[tabindex="0"]')).toHaveCount(1);
});

test('the files panel collapses and comes back (S08.1)', async () => {
  await page.getByTestId('rail-files').click();
  await expect(page.getByTestId('region-files')).toBeHidden();
  await page.getByTestId('rail-files').click();
  await expect(page.getByTestId('region-files')).toBeVisible();
  await expect(row('index.html')).toBeVisible();
});

test('F2 renames; invalid and Windows-unrepresentable names are explained (S08.2)', async () => {
  await row('style.css').click();
  await page.keyboard.press('F2');
  const input = page.getByTestId('name-input');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('style.css');
  for (const [name, explanation] of [
    ['CON.css', 'Windows 保留的设备名'],
    ['main.', '不能以点或空格结尾'],
    ['a:b.css', '不允许名称里有这些字符'],
  ] as const) {
    await input.fill(name);
    await expect(page.getByTestId('name-error')).toContainText(explanation);
    await input.press('Enter');
    await expect(input).toBeVisible(); // not committed
  }
  expect((await readdir(root)).sort()).toEqual(['css', 'index.html', 'style.css', '子 文件夹']);
  await input.fill('主 样式.css');
  await input.press('Enter');
  await expect(row('主 样式.css')).toBeVisible();
  await expect.poll(focusedPath).toBe('主 样式.css');
  expect(await readFile(p('主 样式.css'), 'utf8')).toBe('h1 {}\n');
});

test('a case-only rename works on a case-insensitive file system (S08.2)', async () => {
  await row('index.html').click();
  await page.keyboard.press('F2');
  await page.getByTestId('name-input').fill('Index.html');
  await page.getByTestId('name-input').press('Enter');
  await expect(row('Index.html')).toBeVisible();
  expect(await readdir(root)).toContain('Index.html');
  expect(await readdir(root)).not.toContain('index.html');
});

test('creating onto an existing name is refused and explained; nothing is overwritten (S08.4)', async () => {
  await page.getByTestId('new-file').click();
  const input = page.getByTestId('name-input');
  await input.fill('Index.html');
  await input.press('Enter');
  await expect(page.getByTestId('name-error')).toContainText('不会覆盖');
  await input.fill('index.html');
  await input.press('Enter');
  await expect(page.getByTestId('name-error')).toContainText('只差大小写');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  expect(await readFile(p('Index.html'), 'utf8')).toBe('<p>首页</p>\n');
});

test('new file and folder are created where selected and the new file opens (S08.2)', async () => {
  await row('子 文件夹').click();
  await page.getByTestId('new-folder').click();
  await page.getByTestId('name-input').fill('图片');
  await page.getByTestId('name-input').press('Enter');
  await expect(row('子 文件夹/图片')).toBeVisible();
  await page.getByTestId('new-file').click();
  await page.getByTestId('name-input').fill('关于 我.html');
  await page.getByTestId('name-input').press('Enter');
  await expect(row('子 文件夹/图片/关于 我.html')).toBeVisible();
  await expect(page.locator('[data-testid="tab"].selected')).toHaveAttribute(
    'data-path',
    '子 文件夹/图片/关于 我.html',
  );
  expect(await readFile(p('子 文件夹', '图片', '关于 我.html'), 'utf8')).toBe('');
});

test('renaming the open file saves its edits first and the editor follows (S08.3)', async () => {
  await row('Index.html').click();
  await expect(page.locator('[data-testid="tab"].selected')).toHaveAttribute('data-path', 'Index.html');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press(DOC_END);
  await page.keyboard.type('改名前的修改');
  // Autosave may already be writing; the rename must wait for it either way (S10 save queue).
  await expect(status()).toHaveText(/未保存|正在保存|已保存/);
  await row('Index.html').click();
  await page.keyboard.press('F2');
  await page.getByTestId('name-input').fill('home.html');
  await page.getByTestId('name-input').press('Enter');
  await expect(page.locator('[data-testid="tab"].selected')).toHaveAttribute('data-path', 'home.html');
  await expect(page.locator('.view-lines')).toContainText('改名前的修改');
  // The tab was saved before the rename and reopened from disk at the new path: nothing unsaved.
  await expect(status()).toHaveText('无改动');
  await expect(page.locator('[data-testid="tab"][data-path="Index.html"]')).toHaveCount(0);
  expect(await readFile(p('home.html'), 'utf8')).toContain('改名前的修改');
});

test('Delete asks first; Escape and Cancel keep the file (S08.3)', async () => {
  await row('home.html').click();
  await page.keyboard.press('Delete');
  const dialog = page.getByTestId('delete-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(trashName);
  await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect.poll(focusedPath).toBe('home.html');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Enter'); // Enter on the focused Cancel button
  await expect(dialog).toHaveCount(0);
  expect(await recorded('__trashed')).toEqual([]);
  expect(await readdir(root)).toContain('home.html');
});

test('a failed move to the trash is explained and the file stays (S08.3)', async () => {
  await recordShell('fail');
  await row('home.html').click();
  await page.keyboard.press('Delete');
  await page.getByTestId('confirm-button').click();
  await expect(page.getByTestId('file-op-error')).toContainText(`没能移到${trashName}`);
  await expect(page.getByTestId('file-op-error')).toContainText('being used');
  expect(await readdir(root)).toContain('home.html');
  await expect(page.locator('[data-testid="tab"].selected')).toHaveAttribute('data-path', 'home.html');
  await recordShell('ok');
});

test('confirming moves the open file to the trash and closes it in the editor (S08.3)', async () => {
  await row('home.html').click();
  await page.keyboard.press('Delete');
  await page.getByTestId('confirm-button').click();
  await expect(row('home.html')).toHaveCount(0);
  expect(await recorded('__trashed')).toEqual([p('home.html')]);
  expect(await readdir(root)).not.toContain('home.html');
  expect((await readdir(fakeTrash)).some((n) => n.endsWith('home.html'))).toBe(true);
  // Its tab is closed; the other open tabs stay.
  await expect(page.locator('[data-testid="tab"][data-path="home.html"]')).toHaveCount(0);
  await expect(page.getByTestId('file-op-error')).toHaveCount(0);
});

test('context menu (Shift+F10) and the shortcut reveal an entry in File Explorer / Finder (S08.5)', async () => {
  await row('子 文件夹').click();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByTestId('tree-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  const revealLabel = process.platform === 'darwin' ? '在访达中显示' : '在文件资源管理器中显示';
  await expect(menu.getByRole('menuitem', { name: revealLabel })).toBeVisible();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  // The menu closes before main receives the reveal request (IPC), so the recorder is polled, not read once.
  await expect.poll(() => recorded('__revealed')).toEqual([p('子 文件夹')]);

  await row('主 样式.css').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Alt+Meta+R' : 'Shift+Alt+R');
  await expect.poll(() => recorded('__revealed')).toEqual([p('子 文件夹'), p('主 样式.css')]);

  // Right click opens the same menu; Escape closes it and returns focus to the row.
  await row('主 样式.css').click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect.poll(focusedPath).toBe('主 样式.css');
});

test('changes made by other programs appear in the tree (S07.3)', async () => {
  await writeFile(p('外部 新建.js'), 'console.log(1);\n');
  await expect(row('外部 新建.js')).toBeVisible({ timeout: 5000 });
  await rm(p('外部 新建.js'));
  await expect(row('外部 新建.js')).toHaveCount(0, { timeout: 5000 });
});

test('an open file is read-only while it is being moved to the trash: nothing typed meanwhile is lost (S08.3, S10)', async () => {
  await writeFile(p('慢 删除.js'), 'let keep = 1;\n');
  await expect(row('慢 删除.js')).toBeVisible({ timeout: 5000 });
  await row('慢 删除.js').click();
  await expect(page.locator('[data-testid="tab"].selected')).toHaveAttribute('data-path', '慢 删除.js');
  await recordShell('slow');
  await row('慢 删除.js').click();
  await page.keyboard.press('Delete');
  await page.getByTestId('confirm-button').click();
  // While the slow trash runs, typing into the editor changes nothing (the tab is locked read-only).
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press(DOC_END);
  await page.keyboard.type('TYPEDDURINGDELETE');
  await expect(page.locator('.view-lines')).not.toContainText('TYPEDDURINGDELETE');
  await expect(row('慢 删除.js')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('[data-testid="tab"][data-path="慢 删除.js"]')).toHaveCount(0);
  await recordShell('ok');
});

test('a name Windows cannot represent is flagged, explained and can be renamed (review finding 9)', async () => {
  // As from a zip or a Mac: a trailing dot. Node on Windows writes it through a namespaced path.
  await writeFile(p('旧 页面.'), '<p>旧</p>\n');
  const bad = row('旧 页面.');
  await expect(bad).toBeVisible({ timeout: 5000 });
  await expect(bad.getByTestId('tree-unportable')).toBeVisible();
  await expect(bad).toHaveAccessibleDescription(/名称在 Windows 或 macOS 上无效/);
  await bad.click();
  await expect(page.getByTestId('file-op-error')).toContainText('请按 F2 给它改个名字');
  await page.keyboard.press('F2');
  await page.getByTestId('name-input').fill('旧 页面.html');
  await page.getByTestId('name-input').press('Enter');
  await expect(row('旧 页面.html')).toBeVisible();
  expect(await readFile(p('旧 页面.html'), 'utf8')).toBe('<p>旧</p>\n');
});
