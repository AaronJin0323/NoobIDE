import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, repoRoot, tempRoot } from './launch';
import { openProject } from './project';

/**
 * S13.5 end to end: a project moved between Windows and macOS (tests/fixtures/跨平台 迁移, in a path with Chinese
 * characters and spaces). Opening it shows a non-blocking notice listing what would break on the other system, and
 * nothing in the project folder is renamed, re-normalised or rewritten (names, bytes and timestamps are compared).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
const extras: string[] = [];

async function snapshot(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const full = path.join(dir, name);
    const info = await lstat(full);
    const key = `${rel}/${Buffer.from(name).toString('hex')}`;
    if (info.isDirectory()) out.push(`${key}/`, ...(await snapshot(full, key)));
    else {
      const hash = createHash('sha256')
        .update(await readFile(full))
        .digest('hex');
      out.push(`${key} ${info.size} ${info.mtimeMs} ${hash}`);
    }
  }
  return out;
}

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(tempRoot(), 'noobide-transfer-e2e-'));
  root = path.join(tmp, '网页 练习', '跨平台 迁移');
  await mkdir(path.dirname(root), { recursive: true });
  await cp(path.join(repoRoot, 'tests', 'fixtures', '跨平台 迁移'), root, { recursive: true });
  // Names Windows refuses, as a project from a Mac or a zip would bring them (not creatable on Windows itself).
  for (const name of ['what?.html', 'résumé.html']) {
    try {
      await writeFile(path.join(root, name), '<p>x</p>\n', { flag: 'wx' });
      extras.push(name);
    } catch {
      // The volume refuses the name: the injected-listing unit tests cover it.
    }
  }
  app = await launchApp();
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor({ state: 'attached' });
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

test('opening a transferred project lists its issues and changes nothing on disk (S13.5)', async () => {
  const before = await snapshot(root);
  await openProject(app, page, root);
  const notice = page.getByTestId('transfer-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('role', 'status'); // non-blocking: the workbench stays usable
  await expect(notice).toContainText('NoobIDE 没有改动任何文件');
  // S45.2: the shared notice anatomy — a one-line title and one sentence above the list.
  await expect(notice.locator('.notice-title')).toHaveText('换到另一个系统时可能出问题');
  await expect(notice.locator('.notice-body')).toHaveCount(1);
  await expect(notice.getByTestId('transfer-issue').filter({ hasText: 'crlf-mixed.js' })).toContainText('CRLF');
  for (const name of extras) {
    await expect(notice.getByTestId('transfer-issue').filter({ hasText: name })).toHaveCount(1);
  }
  // The tree still lists every file under its own name.
  await expect(page.getByTestId('file-tree').locator('[data-path="crlf-mixed.js"]')).toBeVisible();
  await page.getByTestId('transfer-notice-dismiss').click();
  await expect(notice).toHaveCount(0);
  await app.close();
  expect(await snapshot(root)).toEqual(before);
});
