import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, tempRoot } from './launch';

/**
 * S49.3 end to end: typing a name's first characters in the file tree selects (and focuses) the matching row,
 * including names with Chinese characters and spaces; the buffer resets after 1 s; keys typed into the inline
 * rename field, held modifiers and IME keys never move the selection. Characters are sent one keydown at a time
 * (see `press`).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;

const p = (...segments: string[]) => path.join(root, ...segments);
const tree = () => page.getByTestId('file-tree');
const row = (relPath: string) => tree().locator(`[data-path="${relPath}"]`);
const focusedPath = () => page.evaluate(() => document.activeElement?.getAttribute('data-path') ?? null);

async function press(text: string) {
  for (const char of text) {
    if (/^[ -~]$/.test(char)) await page.keyboard.press(char === ' ' ? 'Space' : char);
    // Playwright only presses keys of the US layout; a CJK character arrives as the keydown a layout producing it
    // would send to the focused row.
    else
      await page.evaluate((key) => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      }, char);
  }
}

async function expectSelected(relPath: string) {
  await expect(row(relPath)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(focusedPath).toBe(relPath);
}

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(tempRoot(), 'noobide-e2e-typeahead-'));
  root = path.join(tmp, '网页 练习', '输入 选择');
  await mkdir(p('图片'), { recursive: true });
  await writeFile(p('about.html'), '<p>关于</p>\n');
  await writeFile(p('index.html'), '<p>首页</p>\n');
  await writeFile(p('我的 页面.html'), '<p>我的</p>\n');
  await writeFile(p('我们.css'), 'p {}\n');
  await writeFile(p('script.js'), '\n');
  app = await launchApp();
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  await app.evaluate(({ dialog }, chosen) => {
    const fake = async () => ({ canceled: false, filePaths: [chosen] });
    (dialog as unknown as { showOpenDialog: typeof fake }).showOpenDialog = fake;
  }, root);
  await page.getByTestId('open-folder').click();
  await expect(row('index.html')).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('a typed prefix selects the matching row (S49.3)', async () => {
  await row('script.js').focus();
  await expectSelected('script.js');
  await press('i');
  await expectSelected('index.html');
  // Case-insensitive, and a longer prefix is one search.
  await page.waitForTimeout(1100);
  await press('AB');
  await expectSelected('about.html');
});

test('Chinese names and names with a space are matched (S49.3)', async () => {
  await page.waitForTimeout(1100);
  await press('我的 ');
  await expectSelected('我的 页面.html');
  await page.waitForTimeout(1100);
  await press('我们');
  await expectSelected('我们.css');
  await page.waitForTimeout(1100);
  await press('图');
  await expectSelected('图片');
});

test('the buffer resets after a second; nothing matching leaves the selection (S49.3)', async () => {
  await page.waitForTimeout(1100);
  await press('i');
  await expectSelected('index.html');
  await page.waitForTimeout(1100);
  await press('s');
  await expectSelected('script.js');
  await page.waitForTimeout(1100);
  await press('zq');
  await expectSelected('script.js');
});

test('modified keys and the rename field are left alone (S49.3)', async () => {
  await page.waitForTimeout(1100);
  // Select index.html by type-ahead rather than a bare focus(): since S52.3 the focus can move without changing the
  // selection (Ctrl/Cmd+arrows), so focusing a row programmatically does not select it.
  await press('i');
  await expectSelected('index.html');
  // Synthetic keydowns, so no app shortcut or menu accelerator intervenes: a held modifier or an IME key is not
  // type-ahead. (Ctrl/Cmd+A is S52.3's select-all: index.html stays selected and focused.)
  for (const init of [
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { isComposing: true },
    { keyCode: 229 },
  ]) {
    await row('index.html').dispatchEvent('keydown', { key: 'a', ...init });
    await expectSelected('index.html');
  }
  await page.keyboard.press('F2');
  const input = page.getByTestId('name-input');
  await expect(input).toBeFocused();
  await input.press('End');
  await press('as');
  await expect(input).toHaveValue('index.htmlas');
  await expect(row('index.html')).toHaveAttribute('aria-selected', 'true');
  await input.press('Escape');
  await expect(input).toBeHidden();
  await expectSelected('index.html');
});
