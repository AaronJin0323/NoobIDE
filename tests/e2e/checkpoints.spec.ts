import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, tempRoot } from './launch';
import { evalInPreview, openProject, waitForPreviewState } from './preview-helpers';
import { collectConsoleErrors } from './project';

/**
 * S56.2 end to end: save a named checkpoint, break three files, compare (file by file, with a diff), restore the
 * whole project, and the preview shows the old page again. Then rename and delete, and an automatic checkpoint taken
 * before the restore is listed with its cause. The project lives under a path with Chinese characters and spaces;
 * checkpoints are kept in app data, never in the project.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let userData: string;
let root: string;
let consoleErrors: string[];

const INDEX = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>检查点 测试</title>
    <link rel="stylesheet" href="样式/主 样式.css" />
  </head>
  <body>
    <h1 id="title">旧的 页面</h1>
    <p id="script">script not run</p>
    <script src="app.js"></script>
  </body>
</html>
`;
const CSS = 'h1 { color: rgb(0, 128, 0); }\n';
const JS = "document.getElementById('script').textContent = 'old script';\n";

const dialog = () => page.getByTestId('checkpoints-dialog');
const notice = () => dialog().getByTestId('checkpoints-notice');

async function openCheckpoints() {
  await page.getByTestId('app-menu').click();
  await page.getByTestId('menu-show-checkpoints').click();
  await expect(dialog()).toBeVisible();
}

async function pageState() {
  return evalInPreview<{ title: string; color: string; script: string }>(
    app,
    `({
      title: document.getElementById('title')?.textContent ?? '',
      color: getComputedStyle(document.getElementById('title') ?? document.body).color,
      script: document.getElementById('script')?.textContent ?? '',
    })`,
  );
}

async function filesOf(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, prefix: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), rel);
      else out.push(rel);
    }
  };
  await walk(dir, '');
  return out.sort();
}

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(tempRoot(), 'noobide-checkpoints-'));
  userData = path.join(tmp, 'userdata');
  root = path.join(tmp, '我的 网站', '检查点 项目');
  await mkdir(path.join(root, '样式'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), INDEX);
  await writeFile(path.join(root, '样式', '主 样式.css'), CSS);
  await writeFile(path.join(root, 'app.js'), JS);
  app = await launchApp({}, { userDataDir: userData });
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await openProject(app, page, root);
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('save a checkpoint, break three files, restore all: the preview shows the old page', async () => {
  await expect.poll(pageState).toEqual({ title: '旧的 页面', color: 'rgb(0, 128, 0)', script: 'old script' });

  await openCheckpoints();
  await expect(dialog().getByTestId('checkpoints-intro')).toContainText('本地历史');
  await dialog().getByTestId('checkpoints-name').fill('能用的 版本');
  await dialog().getByTestId('checkpoints-save').click();
  await expect(notice()).toHaveAttribute('data-kind', 'ok');
  await expect(dialog().getByTestId('checkpoint')).toHaveCount(1);
  await expect(dialog().getByTestId('checkpoint-kind')).toHaveText('命名');
  await expect(dialog().getByTestId('checkpoints-usage')).toContainText('1 个命名');
  await dialog().getByTestId('checkpoints-close').click();
  // Nothing was written into the project folder.
  expect(await filesOf(root)).toEqual(['app.js', 'index.html', '样式/主 样式.css']);

  // Break three files outside the editor (as another program would); the preview follows the broken page.
  await writeFile(path.join(root, 'index.html'), INDEX.replace('旧的 页面', '坏掉的 页面'));
  await writeFile(path.join(root, '样式', '主 样式.css'), 'h1 { color: rgb(255, 0, 0); }\n');
  await writeFile(path.join(root, 'app.js'), 'throw new Error("broken");\n');
  await writeFile(path.join(root, '新 文件.html'), '<p>added after the checkpoint</p>');
  await page.getByTestId('preview-reload').click();
  await expect.poll(async () => (await pageState()).title).toBe('坏掉的 页面');

  await openCheckpoints();
  await dialog().getByTestId('checkpoint-compare').click();
  const entries = dialog().getByTestId('checkpoint-entry');
  await expect(entries).toHaveCount(4);
  await expect(dialog().locator('[data-testid="checkpoint-entry"][data-path="index.html"]')).toHaveAttribute(
    'data-status',
    'changed',
  );
  await expect(dialog().locator('[data-testid="checkpoint-entry"][data-path="新 文件.html"]')).toHaveAttribute(
    'data-status',
    'added',
  );
  // The diff of one file: the checkpoint's line comes back, the broken one would be replaced.
  await dialog().locator('[data-testid="checkpoint-entry"][data-path="index.html"]').click();
  await expect(dialog().getByTestId('history-diff')).toContainText('旧的 页面');
  await expect(dialog().getByTestId('history-diff')).toContainText('坏掉的 页面');

  await dialog().getByTestId('checkpoints-restore-all').click();
  const panel = dialog().getByTestId('checkpoints-restore-panel');
  await expect(panel).toBeVisible();
  // The added file is listed, and goes to the trash only when ticked (not ticked here: it stays).
  await expect(panel.getByTestId('checkpoints-added')).toContainText('新 文件.html');
  await expect(panel.getByTestId('checkpoints-trash-added')).not.toBeChecked();
  await panel.getByTestId('checkpoints-restore-confirm').click();
  await expect(notice()).toHaveAttribute('data-kind', 'ok');
  await expect(notice()).toContainText('已还原 3 个文件');
  await expect(entries).toHaveCount(1); // only the added file still differs
  // The automatic checkpoint taken before the restore is listed with its cause.
  await expect(dialog().locator('[data-testid="checkpoint"][data-cause="before-checkpoint-restore"]')).toHaveCount(1);
  await dialog().getByTestId('checkpoints-close').click();

  expect(await readFile(path.join(root, 'index.html'), 'utf8')).toBe(INDEX);
  expect(await readFile(path.join(root, '样式', '主 样式.css'), 'utf8')).toBe(CSS);
  expect(await readFile(path.join(root, 'app.js'), 'utf8')).toBe(JS);
  expect(await readFile(path.join(root, '新 文件.html'), 'utf8')).toBe('<p>added after the checkpoint</p>');
  // Main refreshed the preview after the confirmed writes: the old page is back.
  await expect
    .poll(pageState, { timeout: 20_000 })
    .toEqual({ title: '旧的 页面', color: 'rgb(0, 128, 0)', script: 'old script' });
});

test('rename and delete a checkpoint', async () => {
  await openCheckpoints();
  const named = dialog().locator('[data-testid="checkpoint"][data-kind="named"]');
  await named.getByTestId('checkpoint-rename').click();
  await dialog().getByTestId('checkpoint-rename-input').fill('首页 完成');
  await dialog().getByTestId('checkpoint-rename-save').click();
  await expect(named.getByTestId('checkpoint-name')).toHaveText('首页 完成');
  // Delete asks first; the project's files are not affected.
  const auto = dialog().locator('[data-testid="checkpoint"][data-kind="auto"]');
  await auto.getByTestId('checkpoint-delete').click();
  await auto.getByTestId('checkpoint-delete-confirm').click();
  await expect(dialog().getByTestId('checkpoint')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog()).toHaveCount(0);
  expect(await filesOf(root)).toEqual(['app.js', 'index.html', '新 文件.html', '样式/主 样式.css']);
  expect(consoleErrors).toEqual([]);
});

test('S56.3: a restore from local history takes an automatic checkpoint first, labelled with its cause', async () => {
  // The checkpoint restore above kept the broken index.html as a local-history version (before-save).
  await page.getByTestId('app-menu').click();
  await page.getByTestId('menu-show-history').click();
  const history = page.getByTestId('history-dialog');
  await expect(history).toBeVisible();
  await history.locator('[data-testid="history-file"][data-path="index.html"]').click();
  await history.locator('[data-testid="history-version"][data-reason="before-save"]').first().click();
  await history.getByTestId('history-restore').click();
  await expect(history.getByTestId('history-notice')).toHaveAttribute('data-kind', 'ok');
  await history.getByTestId('history-close').click();
  await expect(history).toHaveCount(0);

  await openCheckpoints();
  const auto = dialog().locator('[data-testid="checkpoint"][data-cause="before-history-restore"]');
  await expect(auto).toHaveCount(1);
  await expect(auto.getByTestId('checkpoint-kind')).toHaveText('自动');
  await expect(auto.getByTestId('checkpoint-name')).toContainText('index.html');
  // The named checkpoint is still there: pruning never removes it.
  await expect(dialog().locator('[data-testid="checkpoint"][data-kind="named"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  expect(consoleErrors).toEqual([]);
});
