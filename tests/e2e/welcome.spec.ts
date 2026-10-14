import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { listTemplates } from '../../src/workspace/templates';
import { launchApp, repoRoot } from './launch';
import { answerFolderDialog, collectConsoleErrors } from './project';
import { waitForPreviewState } from './preview-helpers';

/**
 * S20.2: welcome screen and the single-step create wizard (docs/wireframes/welcome.html). The Documents folder is
 * redirected into a temp folder whose path has Chinese characters and spaces, so the default location is
 * `<Documents>/NoobIDE 项目` there.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let documents: string;
let consoleErrors: string[];

const listing = await listTemplates(path.join(repoRoot, 'resources', 'templates'));
if (!listing.ok) throw new Error(listing.message);
const templates = listing.value.templates;

async function tree(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await tree(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-welcome-'));
  documents = path.join(tmp, '我的 文档');
  await mkdir(documents);
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await app.evaluate(({ app: electronApp }, docs) => electronApp.setPath('documents', docs), documents);
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

const wizard = () => page.getByTestId('create-wizard');

test('the welcome screen offers one prominent create action and open folder; the sample stays visible', async () => {
  const welcome = page.getByTestId('welcome');
  await expect(welcome.getByRole('heading', { name: '你好！从一个网页开始吧' })).toBeVisible();
  await expect(page.getByTestId('welcome-create')).toHaveText('创建我的第一个网页');
  await expect(page.getByTestId('welcome-create')).toBeFocused(); // Enter starts it
  await expect(page.getByTestId('welcome-open-folder')).toHaveText('打开文件夹…');
  // Only the create action is a filled (primary) button on the welcome screen.
  await expect(welcome.locator('.primary-button')).toHaveCount(1);
  // S13.3: the recent-projects store exists; a fresh app-data directory has no projects yet.
  await expect(page.getByTestId('welcome-recent')).toContainText('你还没有项目');
  await expect(page.getByTestId('welcome-recent-item')).toHaveCount(0);
  await expect(page.getByTestId('sample-badge')).toBeVisible();
});

test('the wizard shows the three templates, the default selected, and the exact folder and files it will create', async () => {
  await page.keyboard.press('Enter');
  await expect(wizard()).toBeVisible();
  await expect(wizard().getByRole('heading', { name: '创建我的第一个网页' })).toBeVisible();
  const cards = page.getByTestId('wizard-template');
  await expect(cards).toHaveCount(3);
  await expect(cards).toHaveText([/个人介绍页/, /产品展示页/, /按钮计数器/]);
  await expect(cards.nth(0)).toContainText('✓ 已选择');
  for (const img of await wizard().locator('.wizard-thumb').all()) {
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  }
  await expect(page.getByTestId('wizard-name')).toBeFocused();
  await expect(page.getByTestId('wizard-name')).toHaveValue('我的第一个网页');
  const location = path.join(documents, 'NoobIDE 项目');
  await expect(page.getByTestId('wizard-location')).toHaveText(location);
  await expect(page.getByTestId('wizard-folder')).toHaveText(path.join(location, '我的第一个网页'));
  await expect(page.getByTestId('wizard-files').locator('li')).toHaveText([
    'index.html',
    'style.css',
    'script.js',
    'images/',
  ]);
  await expect(page.getByTestId('wizard-preview')).toContainText('个人介绍页');
  await expect(page.getByTestId('wizard-create')).toBeEnabled();
  // Nothing is written before "Create and open": the default location does not exist yet.
  await expect(readdir(documents)).resolves.toEqual([]);
});

test('focus stays inside the wizard, and Escape cancels without creating anything', async () => {
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="create-wizard"]'))).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="create-wizard"]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(wizard()).toHaveCount(0);
  await expect(readdir(documents)).resolves.toEqual([]);
});

test('illegal names and existing folders are explained and Create stays disabled; nothing is overwritten', async () => {
  const location = path.join(documents, 'NoobIDE 项目');
  const existing = path.join(location, '已有 网页');
  await mkdir(existing, { recursive: true });
  await writeFile(path.join(existing, 'index.html'), '<p>我自己的网页</p>');

  await page.getByTestId('welcome-create').click();
  const name = page.getByTestId('wizard-name');
  await name.fill('CON');
  await expect(page.getByTestId('wizard-message')).toContainText('Windows');
  await expect(page.getByTestId('wizard-create')).toBeDisabled();

  await name.fill('已有 网页');
  await expect(page.getByTestId('wizard-message')).toHaveText(
    '已有同名文件夹或文件“已有 网页”。请换一个名字——我们不会覆盖已有文件。',
  );
  await expect(page.getByTestId('wizard-create')).toBeDisabled();
  await expect(page.getByTestId('wizard-destination')).toHaveCount(0);
  await name.press('Enter'); // Enter does nothing while Create is disabled
  await expect(wizard()).toBeVisible();

  await name.fill('已有 网页'.replace('网页', '网页 2'));
  await expect(page.getByTestId('wizard-message')).toHaveCount(0);
  await expect(page.getByTestId('wizard-create')).toBeEnabled();
  await page.getByTestId('wizard-cancel').click();
  expect(await tree(existing)).toEqual(['index.html']);
  expect(await readFile(path.join(existing, 'index.html'), 'utf8')).toBe('<p>我自己的网页</p>');
});

test('create from another template in a chosen folder: the project opens with its entry page and a running preview', async () => {
  const parent = path.join(tmp, '网页 练习');
  await mkdir(parent);
  await page.getByTestId('welcome-create').click();
  await page.getByTestId('wizard-template').filter({ hasText: '按钮计数器' }).click();
  await expect(page.getByTestId('wizard-template').nth(2)).toContainText('✓ 已选择');
  await expect(page.getByTestId('wizard-preview')).toContainText('按钮计数器');
  await page.getByTestId('wizard-name').fill('我的 主页');
  await answerFolderDialog(app, parent);
  await page.getByTestId('wizard-change-location').click();
  await expect(page.getByTestId('wizard-location')).toHaveText(parent);
  await expect(page.getByTestId('wizard-folder')).toHaveText(path.join(parent, '我的 主页'));
  await page.getByTestId('wizard-create').click();

  await expect(wizard()).toHaveCount(0);
  await expect(page.getByTestId('project-name')).toHaveText('我的 主页');
  await expect(page.getByTestId('project-path')).toHaveText(path.join(parent, '我的 主页'));
  await expect(page.getByTestId('welcome')).toHaveCount(0);
  await expect(
    page.locator('[data-testid="tab"][data-path="index.html"] [role="tab"][aria-selected="true"]'),
  ).toBeVisible();
  // Built-in templates are trusted: the preview runs without pressing Start (PLAN §8, wireframe note 9).
  await waitForPreviewState(page, 'running');
  // S20.3: the new project's files show their roles.
  const row = (rel: string) => page.getByTestId('file-tree').locator(`[data-path="${rel}"]`);
  await expect(row('index.html').getByTestId('file-role')).toHaveText('页面结构');
  await expect(row('style.css').getByTestId('file-role')).toHaveText('视觉样式');
  await expect(row('script.js').getByTestId('file-role')).toHaveText('交互行为');

  const counter = templates.find((t) => t.id === 'button-counter');
  expect(await tree(path.join(parent, '我的 主页'))).toEqual([...(counter?.files ?? [])].sort());
});

test('the default location is created with the first project; the wizard follows the interface language', async () => {
  // The welcome screen shows while no project is open: start the app again.
  expect(consoleErrors).toEqual([]);
  await app.close();
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await app.evaluate(({ app: electronApp }, docs) => electronApp.setPath('documents', docs), documents);
  await page.getByTestId('switch-language').click();
  await expect(page.getByTestId('welcome-create')).toHaveText('Create my first webpage');
  await page.getByTestId('welcome-create').click();
  await expect(wizard().getByRole('heading', { name: 'Create my first webpage' })).toBeVisible();
  await expect(page.getByTestId('wizard-name')).toHaveValue('My first webpage');
  const location = path.join(documents, 'NoobIDE Projects');
  await expect(page.getByTestId('wizard-location')).toHaveText(location);
  await page.getByTestId('wizard-create').click();
  await expect(page.getByTestId('project-name')).toHaveText('My first webpage');
  await waitForPreviewState(page, 'running');
  const intro = templates.find((t) => t.default);
  expect(await tree(path.join(location, 'My first webpage'))).toEqual([...(intro?.files ?? [])].sort());
  expect(consoleErrors).toEqual([]);
});
