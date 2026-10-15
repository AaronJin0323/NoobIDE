import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, tempRoot } from './launch';
import { answerFolderDialog } from './project';

/**
 * S34.2 end to end with the fake provider (NOOBIDE_AI_FAKE, script src/ai/agent/fake-scripts.ts): the agent proposes
 * an edit of style.css and a new about.html; the user accepts the edit and rejects the new file; the edit is on disk
 * and in local history, the new file does not exist; undoing the turn puts the old text back; Stop ends a slow turn.
 *
 * FIXME: needs S31 (window.noobide.ai, ai-ipc, the fake provider playing fakeAgentScript, a stored fake key and
 * consent). Enable by removing `.fixme` once S31 is on main; set the key/consent the way S31's e2e helpers do.
 */
let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
const CSS = 'h1 {\n  color: red;\n}\n';

async function start(agentScript: string) {
  app = await launchApp({ NOOBIDE_AI_FAKE: '1', NOOBIDE_AI_FAKE_AGENT: agentScript });
  page = await app.firstWindow();
  await answerFolderDialog(app, root);
  await page.getByTestId('open-folder').click();
  await expect(page.getByTestId('project-name')).toHaveText(path.basename(root));
}

test.beforeEach(async () => {
  tmp = await mkdtemp(path.join(tempRoot(), 'noobide-agent-'));
  root = path.join(tmp, '网页 练习', '我的 项目');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<!doctype html>\n<h1>你好</h1>\n');
  await writeFile(path.join(root, 'style.css'), CSS);
});

test.afterEach(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test.fixme('propose edit + create: accept one, reject one; files and history verified; undo the turn', async () => {
  await start('edit-and-create');
  await page.getByTestId('rail-agent').click();
  await page.getByTestId('agent-prompt').fill('Make the heading blue and add an about page');
  await page.getByTestId('agent-send').click();

  const changes = page.getByTestId('agent-change');
  await expect(changes).toHaveCount(2);
  await expect(page.getByTestId('agent-diff').first()).toBeVisible();
  await expect(page.getByTestId('agent-step')).toHaveCount(2);

  await changes.nth(0).getByTestId('agent-accept').click();
  await expect(changes.nth(0)).toHaveAttribute('data-state', 'applied');
  await changes.nth(1).getByTestId('agent-reject').click();
  await expect(changes.nth(1)).toHaveAttribute('data-state', 'rejected');
  await expect(page.getByTestId('agent-end')).toHaveAttribute('data-error', '');

  expect(await readFile(path.join(root, 'style.css'), 'utf8')).toBe(CSS.replace('red', 'blue'));
  await expect(readFile(path.join(root, 'about.html'))).rejects.toThrow();

  // Local history has the version before the agent's change.
  await page.getByTestId('agent-close').click();
  await page.getByTestId('rail-history').click();
  await expect(page.getByTestId('history-dialog')).toContainText('style.css');
  await page.getByTestId('history-close').click();

  // Undo the turn as a group.
  await page.getByTestId('rail-agent').click();
  await page.getByTestId('agent-undo').click();
  await expect(page.getByTestId('agent-undo-result')).toBeVisible();
  await expect.poll(() => readFile(path.join(root, 'style.css'), 'utf8')).toBe(CSS);
});

test.fixme('Stop ends a running turn and nothing is changed', async () => {
  await start('slow');
  await page.getByTestId('rail-agent').click();
  await page.getByTestId('agent-prompt').fill('Do something slow');
  await page.getByTestId('agent-send').click();
  await expect(page.getByTestId('agent-running')).toBeVisible();
  await page.getByTestId('agent-stop').click();
  await expect(page.getByTestId('agent-end')).toHaveAttribute('data-error', 'cancelled');
  await expect(page.getByTestId('agent-running')).toHaveCount(0);
  expect(await readFile(path.join(root, 'style.css'), 'utf8')).toBe(CSS);
});
