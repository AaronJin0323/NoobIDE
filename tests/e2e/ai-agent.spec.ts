import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { makeProject, openProject } from './project';

/**
 * S34.2 end to end, against the fake provider (NOOBIDE_AI_FAKE=1). S31's fake plays an agent request with
 * `new ScriptedModel(fakeAgentScript(process.env.NOOBIDE_AI_FAKE_AGENT))` (src/ai/agent/fake-scripts.ts):
 *   - `edit-and-create`: reads index.html and style.css, then proposes an edit of style.css (red → blue) and a new
 *     about.html in one proposal;
 *   - `slow`: streams a little text and waits until Stop.
 * In the chat panel (S33) the user switches to "Change the project", accepts the edit and rejects the new file; the
 * edit is on disk and in local history, about.html does not exist, and undoing the turn puts the old text back.
 *
 * Until S31 (window.noobide.ai, the AI IPC, the fake provider running the agent runner) is on main the suite is
 * fixme: flip S31_MERGED and run `npm run test:e2e -- -g "AI agent"`.
 */
const S31_MERGED = false;
const CSS = 'h1 {\n  color: red;\n}\n';

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;

const panel = () => page.getByTestId('region-ai');
const lastTurn = () => panel().getByTestId('ai-turn').last();
const changes = () => lastTurn().getByTestId('agent-change');

async function start(script: string) {
  ({ tmp, root } = await makeProject('noobide-e2e-AI-代理-'));
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html>\n<link rel="stylesheet" href="style.css">\n<h1>你好</h1>\n',
  );
  await writeFile(path.join(root, 'style.css'), CSS);
  app = await launchApp({ NOOBIDE_AI_FAKE: '1', NOOBIDE_AI_FAKE_AGENT: script });
  page = await app.firstWindow();
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await page.evaluate(async () => {
    const ai = (window.noobide as unknown as { ai: { setKey(r: { provider: string; key: string }): Promise<unknown> } })
      .ai;
    await ai.setKey({ provider: 'anthropic', key: 'fake-key-for-tests' });
    window.dispatchEvent(new Event('noobide:ai-status-changed'));
  });
  await page.getByTestId('rail-ai').click();
  await expect(panel()).toBeVisible();
  await panel().getByTestId('ai-kind').locator('input[value="agent"]').check();
}

async function send(prompt: string) {
  await panel().getByTestId('ai-input').fill(prompt);
  await panel().getByTestId('ai-input').press('Enter');
  const consent = panel().getByTestId('ai-consent-allow');
  if (await consent.isVisible().catch(() => false)) await consent.click();
}

test.describe('AI agent (S34)', () => {
  test.fixme(!S31_MERGED, 'needs S31: window.noobide.ai, the AI IPC and the NOOBIDE_AI_FAKE provider');

  test.afterEach(async () => {
    await app?.close();
    await rm(tmp, { recursive: true, force: true });
  });

  test('propose edit + create: accept one, reject one; disk and local history; undo the turn', async () => {
    await start('edit-and-create');
    await send('Make the heading blue and add an about page');

    await expect(changes()).toHaveCount(2, { timeout: 30_000 });
    await expect(lastTurn().getByTestId('ai-step')).toHaveCount(2);
    await expect(lastTurn().getByTestId('agent-diff').first()).toBeVisible();

    await changes().nth(0).getByTestId('agent-accept').click();
    await expect(changes().nth(0)).toHaveAttribute('data-state', 'applied');
    await changes().nth(1).getByTestId('agent-reject').click();
    await expect(changes().nth(1)).toHaveAttribute('data-state', 'rejected');
    await expect(lastTurn()).toHaveAttribute('data-status', 'done');

    expect(await readFile(path.join(root, 'style.css'), 'utf8')).toBe(CSS.replace('red', 'blue'));
    await expect(readFile(path.join(root, 'about.html'))).rejects.toThrow();

    // Local history keeps the version the agent's change replaced.
    await page.getByTestId('rail-history').click();
    await expect(page.getByTestId('history-dialog')).toContainText('style.css');
    await page.getByTestId('history-close').click();

    // The turn is undone as a group.
    await lastTurn().getByTestId('agent-undo').click();
    await expect(lastTurn().getByTestId('agent-undo-result')).toBeVisible();
    await expect.poll(() => readFile(path.join(root, 'style.css'), 'utf8')).toBe(CSS);
  });

  test('Stop ends a running agent turn and nothing changes', async () => {
    await start('slow');
    await send('Do something slow');
    await expect(lastTurn()).toHaveAttribute('data-status', 'streaming');
    await panel().getByTestId('ai-stop').click();
    await expect(lastTurn()).toHaveAttribute('data-status', 'cancelled');
    expect(await readFile(path.join(root, 'style.css'), 'utf8')).toBe(CSS);
  });
});
