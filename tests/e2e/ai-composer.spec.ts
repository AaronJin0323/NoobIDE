import { rm } from 'node:fs/promises';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { axeScan } from './a11y-helpers';
import { launchApp } from './launch';
import { collectConsoleErrors, makeProject, openProject } from './project';

/**
 * S48.4 / S48.6 / S48.7 chat composer and message log, against the scripted fake provider (decision 0025), in the
 * Chinese-path fixture project (`子 文件夹/页面 二.html` checks names with spaces and Chinese characters).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const panel = () => page.getByTestId('region-ai');
const input = () => panel().getByTestId('ai-input');
const suggest = () => panel().getByTestId('ai-suggest');
const options = () => suggest().getByTestId('ai-suggest-option');

test.describe('AI chat composer (S48.4)', () => {
  test.beforeAll(async () => {
    ({ tmp, root } = await makeProject('noobide-e2e-AI-输入-'));
    app = await launchApp({ NOOBIDE_AI_FAKE: JSON.stringify({ includeBuiltin: true, turns: [] }) });
    page = await app.firstWindow();
    consoleErrors = collectConsoleErrors(page);
    await page.locator('.monaco-editor .view-lines').waitFor();
    await openProject(app, page, root);
    await page.evaluate(async () => {
      const ai = (
        window.noobide as unknown as { ai: { setKey(r: { provider: string; key: string }): Promise<unknown> } }
      ).ai;
      await ai.setKey({ provider: 'anthropic', key: 'fake-key-for-tests' });
      window.dispatchEvent(new Event('noobide:ai-status-changed'));
    });
    await page.getByTestId('rail-ai').click();
    await expect(panel()).toBeVisible();
    await expect(input()).toBeEditable();
  });

  test.afterAll(async () => {
    await app?.close();
    await rm(tmp, { recursive: true, force: true });
  });

  test('/ lists the palette commands; arrows wrap, Enter runs one, Escape closes only the list', async () => {
    await input().fill('');
    await input().pressSequentially('/');
    await expect(suggest()).toBeVisible();
    await expect(suggest()).toHaveAttribute('data-kind', 'command');
    const count = await options().count();
    expect(count).toBeGreaterThan(3);
    await expect(input()).toHaveAttribute('aria-controls', /.+/);
    await expect(options().first()).toHaveAttribute('aria-selected', 'true');

    // ↑ from the first wraps to the last, ↓ from the last wraps to the first.
    await input().press('ArrowUp');
    await expect(options().last()).toHaveAttribute('aria-selected', 'true');
    await input().press('ArrowDown');
    await expect(options().first()).toHaveAttribute('aria-selected', 'true');
    const activeId = await options().first().getAttribute('id');
    await expect(input()).toHaveAttribute('aria-activedescendant', activeId ?? '');

    // Escape closes the list; the panel stays open and the text stays.
    await input().press('Escape');
    await expect(suggest()).toHaveCount(0);
    await expect(panel()).toBeVisible();
    await expect(input()).toHaveValue('/');

    // The palette matcher, also across languages: "problems" finds 显示或隐藏问题面板.
    const problems = page.getByTestId('problems-panel');
    const wasHidden = await problems.isHidden();
    await input().fill('');
    await input().pressSequentially('/problems');
    await expect(options().first()).toHaveAttribute('data-value', 'toggle-problems');
    await input().press('Enter');
    await expect(suggest()).toHaveCount(0);
    await expect(input()).toHaveValue('');
    if (wasHidden) await expect(problems).toBeVisible();
    else await expect(problems).toBeHidden();
    // Nothing was sent.
    await expect(panel().getByTestId('ai-turn')).toHaveCount(0);
  });

  test('@ lists project files; Tab accepts one as a file chip and the three Add buttons stay', async () => {
    await input().fill('');
    await input().pressSequentially('看看 @页面');
    await expect(suggest()).toHaveAttribute('data-kind', 'file');
    await expect(options().first()).toHaveAttribute('data-value', '子 文件夹/页面 二.html');
    await input().press('Tab');
    await expect(suggest()).toHaveCount(0);
    await expect(input()).toHaveValue('看看 子 文件夹/页面 二.html ');
    await expect(input()).toBeFocused();
    const chip = panel().getByTestId('ai-chip').filter({ hasText: '页面 二.html' });
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute('data-kind', 'file');
    for (const id of ['ai-add-file', 'ai-add-selection', 'ai-add-preview']) {
      await expect(panel().getByTestId(id)).toBeVisible();
    }

    // Trailing Chinese punctuation and backslashes do not stop the match.
    await input().fill('@style.css，');
    await input().press('End');
    await expect(options().first()).toHaveAttribute('data-value', 'style.css');
    await input().fill('@子\\页');
    await input().press('End');
    await expect(options().first()).toHaveAttribute('data-value', '子 文件夹/页面 二.html');
    await input().press('Escape');
    await expect(suggest()).toHaveCount(0);
  });

  test('keys an input method is composing never reach the list (IME guard)', async () => {
    await input().fill('');
    await input().pressSequentially('@ind');
    await expect(options().first()).toHaveAttribute('data-value', 'index.html');
    const before = await panel().getByTestId('ai-chip').count();
    // A composing Enter (isComposing, keyCode 229) and a composing Escape: the list neither accepts nor closes.
    await input().evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: true, bubbles: true }));
    });
    await expect(suggest()).toBeVisible();
    await expect(input()).toHaveValue('@ind');
    await expect(panel().getByTestId('ai-chip')).toHaveCount(before);
    await input().press('Enter');
    await expect(input()).toHaveValue('index.html ');
    expect(consoleErrors).toEqual([]);
  });

  test('a long question collapses behind Show more; the action row appears on hover and on focus (S48.6)', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：一段很长的问题。`).join('\n');
    await input().fill(long);
    await input().press('Enter');
    const consent = panel().getByTestId('ai-consent-allow');
    await expect(consent.or(panel().getByTestId('ai-turn')).first()).toBeVisible();
    if (await consent.isVisible()) await consent.click();
    const turn = panel().getByTestId('ai-turn').last();
    await expect(turn).toHaveAttribute('data-status', 'done', { timeout: 30_000 });

    const prompt = turn.getByTestId('ai-prompt');
    await expect(prompt).toHaveAttribute('data-collapse', 'collapsed');
    const cut = await prompt.evaluate((el) => el.getBoundingClientRect().height);
    expect(cut).toBeLessThanOrEqual(300);
    const more = turn.getByTestId('ai-show-more');
    await expect(more).toHaveText('展开全文');
    await expect(more.locator('svg')).toHaveCount(1);
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
    await expect(prompt).toHaveAttribute('data-collapse', 'expanded');
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(more).toHaveText('收起');
    expect(await prompt.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(300);
    await more.click();
    await expect(prompt).toHaveAttribute('data-collapse', 'collapsed');

    // The action row: invisible until hovered; Tab reaches its buttons and reveals it.
    const row = turn.getByTestId('ai-msg-actions').first();
    const opacity = () => row.evaluate((el) => Number(getComputedStyle(el).opacity));
    await input().focus(); // the Show-more button is inside the message: focus elsewhere first
    await page.mouse.move(0, 0);
    await expect.poll(opacity).toBe(0);
    await more.focus();
    await page.keyboard.press('Tab');
    await expect(row.getByTestId('ai-msg-copy')).toBeFocused();
    await expect.poll(opacity).toBe(1);
    await page.keyboard.press('Tab');
    await expect(row.getByTestId('ai-msg-reask')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(input()).toHaveValue(long);
    await expect(input()).toBeFocused();
    await input().fill('');
    await page.mouse.move(0, 0);
    await expect.poll(opacity).toBe(0);
    await turn.getByTestId('ai-sent-with').hover();
    await expect.poll(opacity).toBe(1);

    expect(await axeScan(page)).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
