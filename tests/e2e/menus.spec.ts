import { rm } from 'node:fs/promises';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchApp } from './launch';
import { makeProject, openProject, switchLanguage } from './project';

/**
 * S24.2 native menus and window lifecycle, end to end. The menu bar is read and clicked through Electron's Menu API
 * (Playwright cannot click the OS menu bar). Platform-specific halves run on their platform only; the other
 * platform's checks are in harness/MANUAL-CHECKS.md#S24.2.
 */
interface MenuSnapshot {
  label: string;
  role: string | undefined;
  items: {
    id: string;
    label: string;
    role: string | undefined;
    accelerator: string | null | undefined;
    enabled: boolean;
  }[];
}

const readMenu = (app: ElectronApplication) =>
  app.evaluate(({ Menu }): MenuSnapshot[] =>
    (Menu.getApplicationMenu()?.items ?? []).map((top) => ({
      label: top.label,
      role: top.role,
      items: (top.submenu?.items ?? [])
        .filter((item) => item.type !== 'separator')
        .map((item) => ({
          id: item.id,
          label: item.label,
          role: item.role,
          accelerator: item.accelerator,
          enabled: item.enabled,
        })),
    })),
  );

const menuItem = async (app: ElectronApplication, id: string) =>
  (await readMenu(app)).flatMap((top) => top.items).find((item) => item.id === id);

const clickMenuItem = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`no menu item ${itemId}`);
    (item.click as () => void)();
  }, id);

test('the menu bar follows the platform, the interface language and the command context', async () => {
  const { tmp, root } = await makeProject('noobide-menus-');
  const app = await launchApp();
  const page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  const mac = (await page.evaluate(() => window.noobide?.platform)) === 'mac';

  const menus = await readMenu(app);
  if (mac) {
    expect(menus.map((m) => m.label)).toEqual(['NoobIDE', '文件', '编辑', '视图', '窗口', '帮助']);
    expect(menus[0]?.items.map((i) => i.role ?? i.id)).toEqual([
      'about',
      'services',
      'hide',
      'hideothers',
      'unhide',
      'quit',
    ]);
    expect(menus[0]?.items[0]).toMatchObject({ id: 'about', label: '关于 NoobIDE', enabled: true });
  } else {
    expect(menus.map((m) => m.label)).toEqual(['文件', '编辑', '视图', '帮助']);
    expect(menus[0]?.items.at(-1)).toMatchObject({ role: 'quit', label: '退出' });
  }
  await expect.poll(async () => (await menuItem(app, 'save'))?.accelerator).toBe(mac ? 'Cmd+S' : 'Ctrl+S');
  expect(await menuItem(app, 'close-project')).toMatchObject({ label: '关闭项目', enabled: false });

  // The renderer reports its command context: with a project open, "close project" applies.
  await openProject(app, page, root);
  await expect.poll(async () => (await menuItem(app, 'close-project'))?.enabled).toBe(true);

  // A menu choice runs the registry command in the workbench.
  await clickMenuItem(app, 'toggle-files');
  await expect(page.getByTestId('region-files')).toBeHidden();
  await clickMenuItem(app, 'toggle-files');
  await expect(page.getByTestId('region-files')).toBeVisible();

  // S28.1: "About NoobIDE" opens NoobIDE's About dialog.
  await clickMenuItem(app, 'about');
  await expect(page.getByRole('dialog')).toBeVisible();
  // The dialog moves focus to Close after it mounts; Escape is handled from inside the dialog.
  await expect(page.getByRole('dialog').getByTestId('about-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Switching the interface language re-translates the native menus.
  await switchLanguage(page);
  await expect.poll(async () => (await menuItem(app, 'close-project'))?.label).toBe('Close project');
  expect((await readMenu(app)).map((m) => m.label)).toContain('Edit');

  await app.close();
  await rm(tmp, { recursive: true, force: true });
});

test('macOS keeps running after the last window closes and reopens a window on activation', async () => {
  const app = await launchApp();
  const page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  if ((await page.evaluate(() => window.noobide?.platform)) !== 'mac') {
    await app.close();
    test.skip(true, 'macOS convention');
  }

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  // Still running (the dock icon stays): the main process answers.
  expect(await app.evaluate(({ app: electronApp }) => electronApp.isReady())).toBe(true);

  const reopened = app.waitForEvent('window');
  await app.evaluate(({ app: electronApp }) => {
    electronApp.emit('activate');
  });
  const second = await reopened;
  await second.locator('.monaco-editor .view-lines').waitFor();
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await app.close();
});

test('Windows exits when the last window closes', async () => {
  const app = await launchApp();
  const page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  if ((await page.evaluate(() => window.noobide?.platform)) === 'mac') {
    await app.close();
    test.skip(true, 'Windows (and Linux) convention');
  }

  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await exited;
});
