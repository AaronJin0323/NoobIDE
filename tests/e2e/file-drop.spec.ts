import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { makeProject, openProject, treeRow } from './project';

/**
 * S52.5 (the part that can be automated): dropping files from outside onto the tree copies them like "Add files…"
 * (S52.4). Playwright cannot drag from Explorer/Finder, so the drop event is synthetic (a DataTransfer with File
 * objects made in the page) and runs through the real tree, preload and IPC. Such Files have no OS path
 * (webUtils.getPathForFile gives ''), so main takes the paths from its test hook instead — reachable only through
 * app.evaluate, never from a page. The real OS drag is a manual check (harness/MANUAL-CHECKS.md#S52.5).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let outside: string;

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-drop-'));
  outside = path.join(tmp, '下载 文件夹', '拖进来');
  await mkdir(path.join(outside, '素材 包', '小 图'), { recursive: true });
  await writeFile(path.join(outside, '说明 文档.txt'), '说明\n');
  await writeFile(path.join(outside, '素材 包', 'a.css'), 'a {}\n');
  await writeFile(path.join(outside, '素材 包', '小 图', 'b.txt'), 'b\n');
  await writeFile(path.join(outside, 'setup.exe'), 'MZ');
  await mkdir(path.join(root, '图片 素材'));
  app = await launchApp({ NOOBIDE_E2E_DROP: '1' }); // main takes the test drop's paths from its test hook
  page = await app.firstWindow();
  await openProject(app, page, root);
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

/** Drops outside paths onto a tree row (or the empty area) as synthetic Files; main's test hook names their paths. */
async function dropOnto(target: string | null, paths: string[]) {
  await app.evaluate((_electron, dropped) => {
    (globalThis as unknown as { __noobideTestHooks: { dropPaths?: string[] } }).__noobideTestHooks.dropPaths = dropped;
  }, paths);
  const selector = target === null ? '[data-testid="file-tree"]' : `[data-testid="tree-row"][data-path="${target}"]`;
  await page.evaluate(
    ({ selector: sel, names }) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`no ${sel}`);
      const data = new DataTransfer();
      for (const name of names) data.items.add(new File(['x'], name));
      for (const type of ['dragenter', 'dragover', 'drop']) {
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
      }
    },
    { selector, names: paths.map((p) => path.basename(p)) },
  );
}

test('dropping files and a folder onto a folder row copies them there (S52.5)', async () => {
  await dropOnto('图片 素材', [path.join(outside, '说明 文档.txt'), path.join(outside, '素材 包')]);
  await expect
    .poll(() => readdir(path.join(root, '图片 素材')).then((n) => n.sort()))
    .toEqual(['说明 文档.txt', '素材 包'].sort());
  expect(await readFile(path.join(root, '图片 素材', '素材 包', '小 图', 'b.txt'), 'utf8')).toBe('b\n');
  expect(await readdir(outside)).toContain('说明 文档.txt'); // copied, not moved
});

test('the same collision rules as "Add files…": rename or skip, never overwrite; programs refused (S52.5)', async () => {
  await writeFile(path.join(root, '说明 文档.txt'), 'mine');
  await dropOnto(null, [path.join(outside, '说明 文档.txt'), path.join(outside, 'setup.exe')]);
  await expect(page.getByTestId('import-name-dialog')).toBeVisible();
  await page.keyboard.press('Enter'); // the proposed "说明 文档 copy.txt"
  await expect(page.getByTestId('file-op-failures')).toContainText('.exe');
  expect(await readFile(path.join(root, '说明 文档.txt'), 'utf8')).toBe('mine');
  expect(await readFile(path.join(root, '说明 文档 copy.txt'), 'utf8')).toBe('说明\n');
  expect(await readdir(root)).not.toContain('setup.exe');
});

test('a drop onto a file row goes into that file’s folder (S52.5)', async () => {
  if ((await treeRow(page, '图片 素材').getAttribute('aria-expanded')) !== 'true')
    await treeRow(page, '图片 素材').click();
  await expect(treeRow(page, '图片 素材/说明 文档.txt')).toBeVisible();
  await dropOnto('图片 素材/说明 文档.txt', [path.join(outside, '素材 包', 'a.css')]);
  await expect.poll(() => readdir(path.join(root, '图片 素材'))).toContain('a.css');
});
