import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { listTemplates } from '../../src/workspace/templates';
import { launchApp, repoRoot, tempRoot } from './launch';

/**
 * S20.3: a project made from the default template shows the role of index.html / style.css / script.js in the file
 * list and above the editor, in zh-CN and en. Real file names stay visible.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(tempRoot(), 'noobide-roles-'));
  root = path.join(tmp, '我的 主页');
  const listing = await listTemplates(path.join(repoRoot, 'resources', 'templates'));
  if (!listing.ok) throw new Error(listing.message);
  const t = listing.value.templates.find((x) => x.default)!;
  for (const rel of t.files) {
    const target = path.join(root, ...rel.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(t.dir, ...rel.split('/')), target);
  }
  app = await launchApp();
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  await app.evaluate(({ dialog }, chosen) => {
    const fake = async () => ({ canceled: false, filePaths: [chosen] });
    (dialog as unknown as { showOpenDialog: typeof fake }).showOpenDialog = fake;
  }, root);
  await page.getByTestId('welcome-open-folder').click();
  await expect(page.getByTestId('project-name')).toHaveText('我的 主页');
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

/** A file tree row (S08.1) by its relative path. */
const row = (relPath: string) => page.getByTestId('file-tree').locator(`[data-path="${relPath}"]`);

test('file rows show the real name plus a short role (zh-CN default)', async () => {
  await expect(row('index.html')).toHaveText('index.html页面结构');
  await expect(row('style.css')).toHaveText('style.css视觉样式');
  await expect(row('script.js')).toHaveText('script.js交互行为');
  await row('images').click(); // expand the folder in the tree
  await expect(row('images/avatar.svg').getByTestId('file-role')).toHaveText('图片');
  await expect(row('index.html').getByTestId('file-role')).toHaveAttribute('title', /标题、段落、按钮、图片/);
});

test('the editor shows the role hint of the open file, and none before a file is open', async () => {
  await expect(page.getByTestId('file-role-hint')).toHaveCount(0);
  await row('style.css').click();
  await expect(page.getByTestId('tab-bar').locator('[role="tab"][aria-selected="true"]')).toHaveText('style.css');
  const hint = page.getByRole('note', { name: '这个文件是做什么的' });
  await expect(hint).toHaveText(/^视觉样式.*颜色、大小、间距/);
  await row('script.js').click();
  await expect(hint).toHaveText(/^交互行为.*点击按钮/);
  await row('index.html').click();
  await expect(hint).toHaveText(/^页面结构.*标题、段落、按钮、图片/);
});

test('roles follow the interface language (en)', async () => {
  await page.getByTestId('switch-language').click();
  await expect(row('index.html').getByTestId('file-role')).toHaveText('Page structure');
  await expect(row('style.css').getByTestId('file-role')).toHaveText('Visual styling');
  await expect(row('script.js').getByTestId('file-role')).toHaveText('Interactive behavior');
  await expect(page.getByRole('note', { name: 'What this file is for' })).toHaveText(/^Page structure.*headings/);
  // At the default files width the long English roles do not fit: the role label is shortened, never the file name.
  await expect(page.getByTestId('region-files')).toBeVisible();
  for (const name of ['index.html', 'style.css', 'script.js']) {
    const fit = await row(name).evaluate((el) => {
      const nameEl = el.querySelector('.tree-name') as HTMLElement;
      const role = el.querySelector('[data-testid="file-role"]') as HTMLElement;
      return { name: nameEl.scrollWidth <= nameEl.clientWidth, roleShown: role.clientWidth > 0 };
    });
    expect(fit, name).toEqual({ name: true, roleShown: true });
  }
  await page.getByTestId('switch-language').click();
  await expect(row('index.html').getByTestId('file-role')).toHaveText('页面结构');
});
