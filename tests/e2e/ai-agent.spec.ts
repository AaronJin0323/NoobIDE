import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { documentText, makeProject, openFile, openProject, tabOf, typeAtEnd } from './project';

/**
 * S34.2 end to end, against the fake provider (NOOBIDE_AI_FAKE=1). S31's fake plays an agent request with
 * `new ScriptedModel(fakeAgentScript(process.env.NOOBIDE_AI_FAKE_AGENT))` (src/ai/agent/fake-scripts.ts):
 *   - `edit-and-create`: reads index.html and style.css, then proposes an edit of style.css (red → blue) and a new
 *     about.html in one proposal;
 *   - `slow`: streams a little text and waits until Stop;
 *   - `all-kinds`: one proposal that edits style.css, creates about.html, renames notes.txt and deletes unused.html.
 * In the chat panel (S33) the user switches to "Change the project", accepts the edit and rejects the new file; the
 * edit is on disk and in local history, about.html does not exist, and undoing the turn puts the old text back.
 * The turn is also recorded as a group in local history (app data): after a restart of the app, the History window
 * undoes the whole turn — every file back as it was, through the normal restore path, itself undoable.
 *
 * Until S31 (window.noobide.ai, the AI IPC, the fake provider running the agent runner) is on main the suite is
 * fixme: flip S31_MERGED and run `npm run test:e2e -- -g "AI agent"`.
 */
const S31_MERGED = true;
const CSS = 'h1 {\n  color: red;\n}\n';

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let userData: string;

const panel = () => page.getByTestId('region-ai');
const lastTurn = () => panel().getByTestId('ai-turn').last();
const changes = () => lastTurn().getByTestId('agent-change');

async function start(script: string, files: Record<string, string> = {}) {
  ({ tmp, root } = await makeProject('noobide-e2e-AI-代理-'));
  userData = path.join(tmp, 'userdata');
  await mkdir(path.join(tmp, 'trash'));
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html>\n<link rel="stylesheet" href="style.css">\n<h1>你好</h1>\n',
  );
  await writeFile(path.join(root, 'style.css'), CSS);
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  await launch(script);
  await openProject(app, page, root);
  await enableAgent();
}

/** Starts the app on this test's app-data folder (so a restart keeps local history, settings and the key). */
async function launch(script: string) {
  app = await launchApp({ NOOBIDE_AI_FAKE: '1', NOOBIDE_AI_FAKE_AGENT: script }, { userDataDir: userData });
  page = await app.firstWindow();
  // A first start shows the welcome editor; a restart reopens the project (S13.4) without tabs.
  await page.locator('.monaco-editor .view-lines, [data-testid="project-name"]').first().waitFor();
  // Trashed files go to a folder of the test, not the OS trash.
  await app.evaluate(
    ({ shell }, trashDir) => {
      const load = (process as unknown as { getBuiltinModule: (id: string) => unknown }).getBuiltinModule;
      const fs = load('node:fs') as { renameSync: (from: string, to: string) => void };
      const nodePath = load('node:path') as { join: (...p: string[]) => string; basename: (p: string) => string };
      (shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = async (full: string) => {
        fs.renameSync(full, nodePath.join(trashDir, `${Date.now()}-${nodePath.basename(full)}`));
      };
    },
    path.join(tmp, 'trash'),
  );
}

async function enableAgent() {
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

const exists = (relPath: string) =>
  access(path.join(root, relPath)).then(
    () => true,
    () => false,
  );

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

  test('a turn is undone from History after a restart: edited, created, renamed and deleted files all come back', async () => {
    const NOTES = '待办：\n- 学 CSS\n';
    const UNUSED = '<p>旧页面</p>\n';
    await start('all-kinds', { 'notes.txt': NOTES, 'unused.html': UNUSED });
    await send('Tidy up my project');
    await expect(changes()).toHaveCount(4, { timeout: 30_000 });
    await lastTurn().getByTestId('agent-accept-all').click();
    for (let i = 0; i < 4; i += 1) await expect(changes().nth(i)).toHaveAttribute('data-state', 'applied');
    await expect(lastTurn()).toHaveAttribute('data-status', 'done');
    expect(await readFile(path.join(root, 'style.css'), 'utf8')).toBe(CSS.replace('red', 'blue'));
    expect(await readFile(path.join(root, 'about.html'), 'utf8')).toBe('<h1>About me</h1>\n');
    expect(await readFile(path.join(root, 'old notes.txt'), 'utf8')).toBe(NOTES);
    expect(await exists('notes.txt')).toBe(false);
    expect(await exists('unused.html')).toBe(false);

    // Restart: the chat and its in-memory state are gone; local history (app data) is not.
    await app.close();
    await launch('all-kinds');
    if (
      (await page
        .getByTestId('project-name')
        .textContent()
        .catch(() => null)) !== path.basename(root)
    ) {
      await openProject(app, page, root);
    }
    await expect(page.getByTestId('project-name')).toHaveText(path.basename(root));

    await page.getByTestId('rail-history').click();
    const group = page.getByTestId('history-group');
    await expect(group).toHaveCount(1);
    await expect(group).toContainText('AI 助手的修改 · 4 个文件');
    await expect(group).toContainText('Tidy up my project');
    await expect(page.getByTestId('history-group-files')).toHaveText(
      'style.css · about.html · old notes.txt · unused.html',
    );
    await group.getByTestId('history-group-undo').click();
    await expect(page.getByTestId('history-notice')).toHaveText(
      '已撤销这一轮的修改（4 处）。撤销前的内容也保存为版本了，可以再恢复回来。',
    );
    await expect(group.getByTestId('history-group-undone')).toHaveText('已撤销');
    await expect(group.getByTestId('history-group-undo')).toHaveCount(0);

    // Every file is back as it was before the turn; nothing was deleted for good (the created page is in the trash).
    expect(await readFile(path.join(root, 'style.css'), 'utf8')).toBe(CSS);
    expect(await readFile(path.join(root, 'notes.txt'), 'utf8')).toBe(NOTES);
    expect(await readFile(path.join(root, 'unused.html'), 'utf8')).toBe(UNUSED);
    expect(await exists('about.html')).toBe(false);
    expect(await exists('old notes.txt')).toBe(false);
    expect((await readdir(path.join(tmp, 'trash'))).some((name) => name.endsWith('about.html'))).toBe(true);

    // History: what the turn left is still a version (the undo went through the restore path, so it can be undone
    // in turn), and the version kept right before the AI change is labelled as such.
    await page.getByTestId('history-file').filter({ hasText: 'style.css' }).click();
    const versions = page.getByTestId('history-version');
    await expect(versions).toHaveCount(3);
    await expect(versions.nth(0)).toHaveAttribute('data-reason', 'after-save');
    await expect(versions.nth(2)).toHaveAttribute('data-reason', 'before-ai');
    await expect(versions.nth(2)).toContainText('AI 助手修改前');
    await versions.nth(1).click();
    await expect(page.getByTestId('history-diff').locator('[data-kind="added"]')).toContainText('color: blue;');
  });

  test('undo from History skips a file edited since the turn, names it, and can finish later', async () => {
    await start('all-kinds', { 'notes.txt': 'n\n', 'unused.html': '<p>u</p>\n' });
    await send('Tidy up my project');
    await expect(changes()).toHaveCount(4, { timeout: 30_000 });
    await lastTurn().getByTestId('agent-accept-all').click();
    await expect(lastTurn()).toHaveAttribute('data-status', 'done');

    // The user keeps working on style.css after the turn (typed in the editor).
    await openFile(page, 'style.css');
    await typeAtEnd(page, '/* 我的修改 */');
    await expect.poll(() => documentText(page.getByTestId('code-editor').getByRole('code'))).toContain('我的修改');

    await page.getByTestId('rail-history').click();
    const group = page.getByTestId('history-group');
    await group.getByTestId('history-group-undo').click();
    const notice = page.getByTestId('history-notice');
    await expect(notice).toHaveAttribute('data-kind', 'error');
    await expect(notice).toContainText('撤销了 3 处修改，1 处没有撤销');
    await expect(notice).toContainText('style.css: 这一轮之后文件又被修改过');
    // Not marked as undone: it can be finished once the file is back to what the turn left.
    await expect(group.getByTestId('history-group-undo')).toBeVisible();
    await expect(group.getByTestId('history-group-undone')).toHaveCount(0);

    // style.css keeps the user's work; the other files are back.
    expect(await readFile(path.join(root, 'style.css'), 'utf8')).not.toBe(CSS);
    await page.getByTestId('history-close').click();
    await tabOf(page, 'style.css').click(); // the restored files opened in tabs of their own
    await expect.poll(() => documentText(page.getByTestId('code-editor').getByRole('code'))).toContain('我的修改');
    expect(await readFile(path.join(root, 'notes.txt'), 'utf8')).toBe('n\n');
    expect(await readFile(path.join(root, 'unused.html'), 'utf8')).toBe('<p>u</p>\n');
    expect(await exists('about.html')).toBe(false);
  });
});
