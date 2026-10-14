import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';

let app: ElectronApplication;
let page: Page;
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  app = await launchApp();
  page = await app.firstWindow();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.locator('.monaco-editor .view-lines').waitFor();
});

test.afterAll(async () => {
  await app?.close();
});

async function setWindowSize(width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
    { width, height },
  );
  await page.waitForFunction((w) => window.innerWidth === w, width);
}

const background = (selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);

test('shell and editor follow the system colour scheme together (S30.1, S30.2)', async () => {
  const seen: Record<string, string> = {};
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await expect
      .poll(
        async () =>
          (await background('.monaco-editor .monaco-editor-background')) ===
          (await background('[data-testid="region-editor"]')),
      )
      .toBe(true);
    seen[scheme] = await background('[data-testid="region-editor"]');
  }
  expect(seen.dark).toBe('rgb(19, 22, 29)'); // tokens.ts dark.panel #13161D
  expect(seen.light).toBe('rgb(255, 255, 255)'); // tokens.ts light.panel #FFFFFF
  expect(await background('body')).toBe('rgb(236, 238, 243)'); // light.bg
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('a language switch after a scheme change keeps the editor on the current theme (S30.2)', async () => {
  // Regression: re-creating the editor used the scheme from first mount, turning Monaco light inside a dark shell.
  const editorMatchesShell = async () =>
    (await background('.monaco-editor .monaco-editor-background')) ===
    (await background('[data-testid="region-editor"]'));
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await page.getByTestId('switch-language').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect.poll(editorMatchesShell).toBe(true);
    await page.getByTestId('switch-language').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect.poll(editorMatchesShell).toBe(true);
  }
});

test('problems is collapsed into the status strip and toggles from strip, rail and keyboard (S30.3)', async () => {
  const toggle = page.getByTestId('problems-toggle');
  const rail = page.getByTestId('rail-problems');
  const panel = page.getByTestId('problems-panel');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toBeHidden();

  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(rail).toHaveAttribute('aria-expanded', 'true');
  // Opening never moves focus into the panel.
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('problems-toggle');

  await toggle.press('Enter');
  await expect(panel).toBeHidden();
  await rail.focus();
  await rail.press('Space');
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('rail-problems');
  await rail.click();
  await expect(panel).toBeHidden();
});

test('rail toggles the files panel (S30.3)', async () => {
  const files = page.getByTestId('rail-files');
  await expect(files).toHaveAttribute('aria-pressed', 'true');
  await files.click();
  await expect(page.getByTestId('region-files')).toBeHidden();
  await expect(files).toHaveAttribute('aria-pressed', 'false');
  await files.press('Enter');
  await expect(page.getByTestId('region-files')).toBeVisible();
});

test('placeholder states are honest and every control works (S30.3)', async () => {
  await expect(page.getByTestId('sample-badge')).toHaveText('示例 · 未保存到磁盘');
  await expect(page.getByTestId('save-status')).toHaveText('没有打开的文件');
  await expect(page.getByTestId('preview-state')).toHaveText('未运行');
  await expect(page.getByTestId('problems-toggle')).toContainText('还没检查');
  await expect(page.getByText('没有发现问题')).toHaveCount(0);
  // Outside Monaco, the shell offers only controls that do something; none is disabled decoration.
  const buttons = page.locator('button:not(.monaco-editor button)');
  expect(await buttons.evaluateAll((els) => els.filter((b) => (b as HTMLButtonElement).disabled).length)).toBe(0);
  expect(
    await buttons.evaluateAll((els) => els.map((b) => b.getAttribute('data-testid') ?? b.getAttribute('aria-label'))),
  ).toEqual([
    'switch-language',
    'rail-files',
    'rail-problems',
    'open-folder',
    'zoom-out',
    'zoom-reset',
    'zoom-in',
    '收起问题面板',
    'problems-toggle',
  ]);
});

test('editor and preview split the remaining width equally (S30.3)', async () => {
  const editor = await page.getByTestId('region-editor').boundingBox();
  const preview = await page.getByTestId('region-preview').boundingBox();
  expect(Math.abs((editor?.width ?? 0) - (preview?.width ?? -10))).toBeLessThanOrEqual(1);
});

test('narrow window: files collapse and a Code / Preview switch shows one view (S30.4)', async () => {
  await setWindowSize(800, 600);
  const narrowSwitch = page.getByTestId('narrow-switch');
  const code = narrowSwitch.getByRole('button', { name: '代码' });
  const preview = narrowSwitch.getByRole('button', { name: '预览' });
  await expect(narrowSwitch).toBeVisible();
  await expect(page.getByTestId('region-files')).toBeHidden();
  await expect(page.getByTestId('region-editor')).toBeVisible();
  await expect(page.getByTestId('region-preview')).toBeHidden();
  await expect(code).toHaveAttribute('aria-pressed', 'true');

  await preview.click();
  await expect(preview).toHaveAttribute('aria-pressed', 'true');
  await expect(code).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('region-preview')).toBeVisible();
  await expect(page.getByTestId('region-editor')).toBeHidden();

  await page.getByTestId('rail-files').click();
  await expect(page.getByTestId('region-files')).toBeVisible();
  await code.press('Enter');
  await expect(page.getByTestId('region-files')).toBeHidden();
  await expect(page.getByTestId('region-editor')).toBeVisible();
  // The sample buffer survived being hidden.
  await expect(page.locator('.view-lines')).toContainText('<h1 class="title">NoobIDE</h1>');

  await setWindowSize(1280, 800);
  await expect(narrowSwitch).toBeHidden();
  await expect(page.getByTestId('region-files')).toBeVisible();
  await expect(page.getByTestId('region-preview')).toBeVisible();
});

test('no console errors during the shell run', async () => {
  expect(consoleErrors).toEqual([]);
});
