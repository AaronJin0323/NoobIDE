import { rm } from 'node:fs/promises';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { collectConsoleErrors, makeProject, openProject } from './project';

/**
 * S48 chat panel engine, against the scripted fake provider (decision 0025). The script adds one turn to the
 * built-in ones: a prompt containing [[long]] streams 300 paragraphs, one every 100 ms (30 s), so the log keeps
 * growing while the test scrolls; the test stops it when done.
 */
const FAKE_SCRIPT = JSON.stringify({
  includeBuiltin: true,
  turns: [
    {
      match: '[[long]]',
      repeat: true,
      steps: Array.from({ length: 300 }, (_, i) => [
        { type: 'text', text: `第 ${i + 1} 段：这是一段很长的回答，用来测试滚动。\n\n` },
        { type: 'delay', ms: 100 },
      ]).flat(),
    },
  ],
});

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const panel = () => page.getByTestId('region-ai');
const body = () => panel().getByTestId('ai-body');
const input = () => panel().getByTestId('ai-input');

/** The log's scroll position, content height and distance from the end. */
const metrics = () =>
  body().evaluate((el) => ({
    top: el.scrollTop,
    height: el.scrollHeight,
    fromEnd: el.scrollHeight - el.clientHeight - el.scrollTop,
  }));

test.describe('AI chat engine (S48)', () => {
  test.beforeAll(async () => {
    ({ tmp, root } = await makeProject('noobide-e2e-AI-引擎-'));
    app = await launchApp({ NOOBIDE_AI_FAKE: FAKE_SCRIPT });
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

  test('scrolling up during a stream keeps the viewport put; Jump to latest follows again (S48.1)', async () => {
    await input().fill('请写一个很长的回答 [[long]]');
    await input().press('Enter');
    await panel().getByTestId('ai-consent-allow').click();
    const turn = panel().getByTestId('ai-turn').last();
    await expect(turn).toHaveAttribute('data-status', 'streaming', { timeout: 30_000 });

    // Pinned: the log follows the stream while it overflows.
    await expect.poll(async () => (await metrics()).height, { timeout: 15_000 }).toBeGreaterThan(1500);
    await expect.poll(async () => (await metrics()).fromEnd).toBeLessThanOrEqual(40);
    await expect(panel().getByTestId('ai-jump')).toHaveCount(0);

    // The reader scrolls up with the wheel: from now on new chunks must not move the viewport.
    const box = await body().boundingBox();
    if (!box) throw new Error('chat log has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -600);
    await expect.poll(async () => (await metrics()).fromEnd).toBeGreaterThan(400);
    const before = await metrics();
    await page.waitForTimeout(1500);
    const after = await metrics();
    expect(after.height, 'the stream kept adding content').toBeGreaterThan(before.height + 100);
    expect(Math.abs(after.top - before.top), 'the viewport stayed put').toBeLessThanOrEqual(1);

    // The control: icon + word, and the count of messages that changed while away, as a status.
    const jump = panel().getByTestId('ai-jump');
    await expect(jump).toBeVisible();
    await expect(jump).toContainText('回到最新');
    await expect(jump.getByRole('status')).toHaveText('1 条新消息');
    await expect(jump.locator('svg')).toHaveCount(1);
    await jump.click();
    await expect.poll(async () => (await metrics()).fromEnd).toBeLessThanOrEqual(40);
    await expect(jump).toHaveCount(0);
    const pinned = await metrics();
    await page.waitForTimeout(1000);
    const later = await metrics();
    expect(later.height, 'still streaming').toBeGreaterThan(pinned.height + 100);
    expect(later.fromEnd, 'following again').toBeLessThanOrEqual(40);

    await panel().getByTestId('ai-stop').click();
    await expect(turn).toHaveAttribute('data-status', 'cancelled', { timeout: 15_000 });
    expect(consoleErrors).toEqual([]);
  });
});
