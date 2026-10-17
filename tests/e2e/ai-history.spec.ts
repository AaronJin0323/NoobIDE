import { readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { makeProject, openProject, projectMenu } from './project';

/**
 * S39.1 end to end, against the fake provider (NOOBIDE_AI_FAKE=1, decision 0025: no test calls a real provider): a
 * chat is saved per project in app data (never in the project folder), survives a restart, is listed under "Past
 * chats" (title and date), reopens with the keyboard, and is deleted after a confirmation. The log never contains the
 * chat's text. S39.2: Settings → AI shows today's token use per provider.
 */
test.describe.configure({ mode: 'serial' });

const PROMPT = '请记住这个问题 HISTORY-MARKER';

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let userData: string;

const panel = () => page.getByTestId('region-ai');
const items = () => panel().getByTestId('ai-history-item');

async function launch() {
  app = await launchApp({ NOOBIDE_AI_FAKE: '1' }, { userDataDir: userData });
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines, [data-testid="project-name"]').first().waitFor();
  // A restart reopens the last project (S13.4) a moment after the window shows; the first start needs a folder.
  const reopened = await page
    .getByTestId('project-name')
    .filter({ hasText: path.basename(root) })
    .waitFor({ timeout: 10_000 })
    .then(
      () => true,
      () => false,
    );
  if (!reopened) await openProject(app, page, root);
  await expect(page.getByTestId('project-name')).toHaveText(path.basename(root));
}

async function allFiles(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true }).catch(() => [] as string[])).map((f) => path.join(dir, f));
}

async function textOf(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const file of await allFiles(dir)) parts.push(await readFile(file, 'utf8').catch(() => ''));
  return parts.join('\n');
}

test.describe('AI chat history (S39)', () => {
  test.beforeAll(async () => {
    ({ tmp, root } = await makeProject('noobide-e2e-AI-历史-'));
    userData = path.join(tmp, '用户 数据');
    await launch();
    await page.evaluate(async () => {
      const ai = (
        window.noobide as unknown as { ai: { setKey(r: { provider: string; key: string }): Promise<unknown> } }
      ).ai;
      await ai.setKey({ provider: 'anthropic', key: 'fake-key-for-tests' });
      window.dispatchEvent(new Event('noobide:ai-status-changed'));
    });
  });

  test.afterAll(async () => {
    await app?.close();
    await rm(tmp, { recursive: true, force: true });
  });

  test('a chat is saved in app data, not in the project, and reopens after a restart (S39.1)', async () => {
    const projectFilesBefore = (await readdir(root)).sort();
    await page.getByTestId('rail-ai').click();
    await expect(panel()).toBeVisible();
    await panel().getByTestId('ai-input').fill(PROMPT);
    await panel().getByTestId('ai-input').press('Enter');
    await panel().getByTestId('ai-consent-allow').click();
    const turn = panel().getByTestId('ai-turn').last();
    await expect(turn).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await expect(turn.getByTestId('ai-usage')).toBeVisible();

    // Saved in app data under ai-chats/, nothing new in the project folder (only .noobide/project.json may ever be).
    await expect
      .poll(async () => (await allFiles(path.join(userData, 'ai-chats'))).some((f) => f.endsWith('.json')))
      .toBe(true);
    expect(await textOf(path.join(userData, 'ai-chats'))).toContain('HISTORY-MARKER');
    expect((await readdir(root)).filter((n) => n !== '.noobide').sort()).toEqual(
      projectFilesBefore.filter((n) => n !== '.noobide'),
    );
    expect(await textOf(root)).not.toContain('HISTORY-MARKER');

    await app.close();
    await launch();
    await page.getByTestId('rail-ai').click();
    await expect(panel()).toBeVisible();
    // A fresh window starts with an empty conversation; the saved one is under "Past chats".
    await expect(panel().getByTestId('ai-turn')).toHaveCount(0);
    await panel().getByTestId('ai-history-toggle').click();
    await expect(panel().getByTestId('ai-history')).toBeVisible();
    await expect(items()).toHaveCount(1);
    await expect(items().first()).toContainText('请记住这个问题');
    await expect(items().first()).toContainText('更新于');
    // Keyboard: the Open button is a normal button.
    await items().first().getByTestId('ai-history-open').focus();
    await page.keyboard.press('Enter');
    await expect(panel().getByTestId('ai-history')).toHaveCount(0);
    const reopened = panel().getByTestId('ai-turn');
    await expect(reopened).toHaveCount(1);
    await expect(reopened.getByTestId('ai-prompt')).toHaveText(PROMPT);
    await expect(reopened.getByTestId('ai-answer')).not.toBeEmpty();
    await expect(reopened.getByTestId('ai-usage')).toBeVisible();
  });

  test('a past chat is deleted only after confirming (S39.1)', async () => {
    await panel().getByTestId('ai-history-toggle').click();
    await expect(items()).toHaveCount(1);
    await items().first().getByTestId('ai-history-delete').click();
    await expect(panel().getByTestId('ai-history-confirm-delete')).toBeFocused();
    await panel().getByTestId('ai-history-cancel-delete').click();
    await expect(items()).toHaveCount(1);
    await items().first().getByTestId('ai-history-delete').click();
    await panel().getByTestId('ai-history-confirm-delete').click();
    await expect(panel().getByTestId('ai-history-empty')).toBeVisible();
    await expect(panel().getByTestId('ai-history-notice')).toHaveText('对话已删除。');
    await expect
      .poll(async () => (await allFiles(path.join(userData, 'ai-chats'))).filter((f) => f.endsWith('.json')))
      .toEqual([]);
    // Logs carry ids, counts and codes only, never the chat's text.
    expect(await textOf(path.join(userData, 'logs'))).not.toContain('HISTORY-MARKER');
  });

  test('Settings → AI shows today’s token use per provider (S39.2)', async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('noobide:open-ai-settings')));
    const settings = page.getByTestId('ai-settings');
    await expect(settings).toBeVisible();
    await expect(settings.getByTestId('ai-usage-today')).toContainText('Anthropic');
    await expect(settings.getByTestId('ai-usage-today')).toContainText('今天合计');
    await expect(settings.getByTestId('ai-budget-state')).toHaveText('没有每日上限。');
    await settings.getByTestId('ai-settings-close').click();
  });

  test('removing a missing project from the recent list offers to delete its saved chats (S39.1)', async () => {
    // The panel is still open from the tests above (the rail button toggles it).
    if (!(await panel().isVisible())) await page.getByTestId('rail-ai').click();
    await expect(panel()).toBeVisible();
    await panel().getByTestId('ai-input').fill('另一个问题 RECENT-MARKER');
    await panel().getByTestId('ai-input').press('Enter');
    await expect(panel().getByTestId('ai-turn').last()).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    const chatFiles = async () => (await allFiles(path.join(userData, 'ai-chats'))).filter((f) => f.endsWith('.json'));
    await expect.poll(chatFiles).toHaveLength(1);

    await projectMenu(page, 'close-project');
    await expect(page.getByTestId('welcome')).toBeVisible();
    await app.close();
    await rename(root, `${root}-moved`);
    app = await launchApp({ NOOBIDE_AI_FAKE: '1' }, { userDataDir: userData });
    page = await app.firstWindow();
    const missing = page.getByTestId('welcome-recent-item').filter({ hasText: root });
    await expect(missing.getByTestId('welcome-recent-missing')).toBeVisible();
    await missing.getByRole('button', { name: '从列表移除' }).click();
    const ask = missing.getByTestId('welcome-recent-chats');
    await expect(ask).toContainText('1 个保存的 AI 对话');
    await ask.getByTestId('welcome-recent-chats-delete').click();
    await expect(page.getByTestId('welcome-recent-item').filter({ hasText: root })).toHaveCount(0);
    await expect.poll(chatFiles).toEqual([]);
    await rename(`${root}-moved`, root);
  });
});
