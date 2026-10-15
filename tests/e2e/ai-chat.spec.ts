import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { axeScan } from './a11y-helpers';
import { launchApp } from './launch';
import { collectConsoleErrors, focusEditor, makeProject, openFile, openProject } from './project';

/**
 * S33 AI chat panel and "Explain" entry points, against the scripted fake provider of S31 (decision 0025: no test calls
 * a real provider). Main runs the fake with NOOBIDE_AI_FAKE=1; this spec relies on these fake scripts:
 *   - default: streams a short Markdown answer in the request's locale that contains a ```html code block, then
 *     'done' with usage;
 *   - a prompt containing [[slow]]: streams slowly until cancelled (Stop);
 *   - a prompt containing [[offline]]: ends with an 'error' event of code 'offline'.
 * The key is stored through the contract (ai.setKey), as Settings → AI does.
 *
 * Until S31 (window.noobide.ai, the AI IPC and the fake provider) is on main, the suite is marked fixme: flip
 * S31_MERGED, run `npm run test:e2e -- -g "AI chat"`, and adapt the scripts above to the fake's if they differ.
 */
const S31_MERGED = false;

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const panel = () => page.getByTestId('region-ai');
const chips = () => panel().getByTestId('ai-chip');
const input = () => panel().getByTestId('ai-input');
const lastTurn = () => panel().getByTestId('ai-turn').last();

async function storeFakeKey() {
  await page.evaluate(async () => {
    const ai = (window.noobide as unknown as { ai: { setKey(r: { provider: string; key: string }): Promise<unknown> } })
      .ai;
    await ai.setKey({ provider: 'anthropic', key: 'fake-key-for-tests' });
  });
  // Status is re-read when the window regains focus or when settings announce a change.
  await page.evaluate(() => window.dispatchEvent(new Event('noobide:ai-status-changed')));
}

test.describe('AI chat (S33)', () => {
  test.fixme(!S31_MERGED, 'needs S31: window.noobide.ai, the AI IPC and the NOOBIDE_AI_FAKE provider');

  test.beforeAll(async () => {
    ({ tmp, root } = await makeProject('noobide-e2e-AI-对话-'));
    await writeFile(path.join(root, 'broken.js'), "const userName = '林小雨';\nconsole.log(userNmae);\n");
    app = await launchApp({ NOOBIDE_AI_FAKE: '1' });
    page = await app.firstWindow();
    consoleErrors = collectConsoleErrors(page);
    await page.locator('.monaco-editor .view-lines').waitFor();
    await openProject(app, page, root);
  });

  test.afterAll(async () => {
    await app?.close();
    await rm(tmp, { recursive: true, force: true });
  });

  test('without a key the chat explains how to add one (S33.1)', async () => {
    await page.getByTestId('rail-ai').click();
    await expect(panel()).toBeVisible();
    await expect(panel().getByTestId('ai-state')).toHaveAttribute('data-state', 'no-key');
    await expect(panel().getByTestId('ai-state')).toContainText('还没有填写 AI 的 API 密钥');
    await panel().getByTestId('ai-close').click();
    await expect(panel()).toHaveCount(0);
  });

  test('zh-CN: chips shown and removable, consent first, streamed Markdown answer, copy code, usage (S33.1)', async () => {
    await storeFakeKey();
    await openFile(page, 'index.html');
    // The shortcut opens the panel with the input focused and the current file suggested as context.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+A' : 'Control+Shift+A');
    await expect(panel()).toBeVisible();
    await expect(input()).toBeFocused();
    await expect(chips()).toHaveCount(1);
    await expect(chips().first()).toContainText('文件 index.html');
    // Removable, and added back on request.
    await chips().first().getByTestId('ai-chip-remove').click();
    await expect(chips()).toHaveCount(0);
    await expect(panel().getByTestId('ai-no-context')).toBeVisible();
    await panel().getByTestId('ai-add-file').click();
    await expect(chips()).toHaveCount(1);

    await input().fill('这个页面是做什么的？');
    await input().press('Enter');
    // First use in this project: the consent question, nothing sent yet.
    await expect(panel().getByTestId('ai-consent')).toBeVisible();
    await expect(panel().getByTestId('ai-turn')).toHaveCount(0);
    await panel().getByTestId('ai-consent-allow').click();

    await expect(lastTurn()).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await expect(lastTurn().getByTestId('ai-sent-with')).toHaveText('一起发送了：文件 index.html');
    await expect(lastTurn().getByTestId('ai-turn-status')).toHaveText('回答完成。');
    await expect(lastTurn().getByTestId('ai-usage')).toContainText('用量：输入');
    // Safe Markdown: a code block with a copy button; no live links, no raw HTML elements from the answer.
    const code = lastTurn().getByTestId('md-code').first();
    await expect(code).toBeVisible();
    expect(await lastTurn().locator('a, script, iframe, img').count()).toBe(0);
    await code.getByTestId('md-copy').click();
    await expect(code.getByTestId('md-copy')).toHaveText('已复制');
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toBe(await code.locator('pre code').textContent());
  });

  test('Stop ends a running answer and says so (S33.1)', async () => {
    await input().fill('[[slow]] 慢慢回答');
    await panel().getByTestId('ai-send').click();
    await expect(lastTurn()).toHaveAttribute('data-status', 'streaming');
    await panel().getByTestId('ai-stop').click();
    await expect(lastTurn()).toHaveAttribute('data-status', 'cancelled');
    await expect(lastTurn().getByTestId('ai-turn-status')).toHaveText('已停止。上面是停止前收到的部分。');
    await expect(panel().getByTestId('ai-send')).toBeVisible();
  });

  test('en: an offline error is explained; answers follow the UI locale (S33.1)', async () => {
    await page.getByTestId('switch-language').click();
    await panel().getByTestId('ai-new').click();
    await input().fill('[[offline]] hello');
    await panel().getByTestId('ai-send').click();
    const error = lastTurn().getByTestId('ai-error');
    await expect(error).toHaveAttribute('data-code', 'offline');
    await expect(error).toContainText('Cannot reach the AI service. Check the network connection.');
    await page.getByTestId('switch-language').click(); // back to zh-CN
  });

  test('"Explain this code" on a selection opens the chat in explain mode with the selection (S33.2)', async () => {
    await openFile(page, 'script.js');
    await focusEditor(page);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.locator('.monaco-editor .view-lines').click({ button: 'right' });
    const item = page.getByRole('menuitem', { name: '让 AI 解释这段代码' });
    await item.hover();
    await page.keyboard.press('Enter');
    await expect(panel().getByTestId('ai-mode')).toHaveAttribute('data-mode', 'explain-code');
    await expect(chips()).toHaveCount(1);
    await expect(chips().first()).toHaveAttribute('data-kind', 'selection');
    await expect(chips().first()).toContainText('script.js 第 1–3 行（选中的代码）');
    await expect(input()).toHaveValue('请解释这段代码是做什么的，一步一步讲。');
    await expect(input()).toBeFocused();
    await input().press('Enter');
    await expect(lastTurn()).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    await expect(lastTurn().getByTestId('ai-sent-with')).toContainText('script.js 第 1–3 行（选中的代码）');
  });

  test('"Ask AI" on a problem card adds the problem with its original error and the file (S33.2)', async () => {
    await openFile(page, 'broken.js');
    const toggle = page.getByTestId('problems-toggle');
    await expect(toggle).toContainText('1 个错误', { timeout: 30_000 });
    await toggle.click();
    const row = page.getByTestId('problem-row').filter({ hasText: 'broken.js:2' }).first();
    await row.getByTestId('problem-summary').click();
    await row.getByTestId('problem-ask-ai').click();
    await expect(panel().getByTestId('ai-mode')).toHaveAttribute('data-mode', 'explain-problem');
    await expect(chips()).toHaveCount(2);
    await expect(chips().nth(0)).toHaveAttribute('data-kind', 'problem');
    await expect(chips().nth(0)).toContainText('broken.js 第 2 行');
    await expect(chips().nth(1)).toContainText('文件 broken.js');
    await input().press('Enter');
    await expect(lastTurn()).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    // The open panel with chips, answers and code blocks passes the accessibility scan.
    expect(await axeScan(page)).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
