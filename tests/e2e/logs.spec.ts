import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, tempRoot } from './launch';
import { makeProject, openFile, openProject, typeAtEnd } from './project';

/**
 * S13.6 end to end: the app writes a rotating log into its app-data directory (here a --user-data-dir with Chinese
 * characters and spaces), starting with version information; edited source code never reaches it; and the
 * "Open logs folder" command shows exactly that folder.
 */
test('the log lives in app data, starts with version info, holds no source code; the menu opens its folder (S13.6)', async () => {
  const tmp = await mkdtemp(path.join(tempRoot(), 'noobide-logs-e2e-'));
  const userData = path.join(tmp, '用户 数据');
  const project = await makeProject('noobide-logs-project-');
  const app = await launchApp({}, { userDataDir: userData });
  try {
    const page = await app.firstWindow();
    await page.locator('.monaco-editor .view-lines').waitFor();
    const logsDir = path.join(userData, 'logs');
    const versions = await app.evaluate(({ app: electronApp }) => ({
      app: electronApp.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    }));
    const first = JSON.parse((await readFile(path.join(logsDir, 'noobide.log'), 'utf8')).split('\n')[0] ?? '{}');
    expect(first).toMatchObject({ level: 'info', event: 'app-start', ...versions });
    expect(first.platform).toBeTruthy();
    expect(first.arch).toBeTruthy();

    // Edit and save source code with a unique marker; it must never appear in any log file.
    const marker = `SOURCE_MARKER_${Date.now()}`;
    await openProject(app, page, project.root);
    await openFile(page, 'index.html');
    await typeAtEnd(page, marker);
    await expect.poll(() => readFile(path.join(project.root, 'index.html'), 'utf8')).toContain(marker);

    // "Open logs folder": the native shell call is replaced so the test sees which folder would open.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { __openedPaths?: string[] }).__openedPaths = opened;
      (shell as unknown as { openPath: (p: string) => Promise<string> }).openPath = async (p) => {
        opened.push(p);
        return '';
      };
    });
    const menuButton = page.getByTestId('app-menu');
    await menuButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(menuButton).toBeFocused();
    await menuButton.click();
    await page.getByTestId('menu-open-logs').click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as { __openedPaths?: string[] }).__openedPaths ?? []))
      .toEqual([logsDir]);

    await app.close();
    for (const name of await readdir(logsDir)) {
      const text = await readFile(path.join(logsDir, name), 'utf8');
      expect(text).not.toContain(marker);
      expect(text).not.toContain('<!doctype');
      for (const line of text.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
    }
  } finally {
    await app.close().catch(() => undefined);
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    await rm(project.tmp, { recursive: true, force: true }).catch(() => undefined);
  }
});
