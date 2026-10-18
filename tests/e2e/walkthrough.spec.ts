import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { ProblemRecord } from '../../src/shared/problem';
import { launchApp } from './launch';
import { collectConsoleErrors, openFile, switchLanguage } from './project';
import { evalInPreview, waitForPreviewState } from './preview-helpers';

/**
 * S23 onboarding walkthrough end to end: the engine (anchored, skippable, revisitable from Help, persisted), the
 * glossary linked from the UI, the PLAN §2 journey inside a real project created with the wizard (each step detected
 * from what the user really did), and the unguided final task. Paths have Chinese characters and spaces.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let documents: string;
let consoleErrors: string[];

const panel = () => page.getByTestId('walkthrough');
const check = () => page.getByTestId('walkthrough-check');
const next = () => page.getByTestId('walkthrough-next');
const anchored = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-walkthrough-anchor]')].map(
      (el) => el.getAttribute('data-path') ?? el.getAttribute('data-testid'),
    ),
  );

async function start(userData: string) {
  app = await launchApp({}, { userDataDir: userData });
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await app.evaluate(({ app: electronApp }, docs) => electronApp.setPath('documents', docs), documents);
}

/**
 * S47.4: the glossary is in the help/more menu; lessons are in the project menu, which exists only with a project —
 * without one the rail's labelled Lessons button runs the same command (key features are never only in a menu).
 */
async function menu(id: string) {
  if (id === 'help-walkthrough' && (await page.getByTestId('project-menu').count()) === 0) {
    await page.getByTestId('rail-lessons').click();
    return;
  }
  await page.getByTestId(id === 'help-walkthrough' ? 'project-menu' : 'app-menu').click();
  await page.getByTestId(`menu-${id}`).click();
}

/**
 * Quits the app as a restart step does. Under CPU load a quit once never finished (S58.4); if it takes more than
 * 20 s, the app log's close-handshake lines (main: window-close asked / answered / gave-up) are printed so the stuck
 * step is named in the CI log. The quit itself is still awaited.
 */
async function quitApp(userData: string) {
  const slow = setTimeout(() => {
    void (async () => {
      const dir = path.join(userData, 'logs');
      const files = await readdir(dir).catch(() => [] as string[]);
      const lines: string[] = [];
      for (const file of files) {
        const text = await readFile(path.join(dir, file), 'utf8').catch(() => '');
        lines.push(...text.split('\n').filter((line) => /window-close|app-quit|will-quit/.test(line)));
      }
      console.log(`walkthrough: quit not finished after 20 s; close log:\n${lines.slice(-12).join('\n')}`);
    })();
  }, 20_000);
  try {
    await app.close();
  } finally {
    clearTimeout(slow);
  }
}

/** The stored walkthrough state, or undefined while main has not written walkthrough.json yet (the store writes
 *  atomically through a queue, so a poll right after a click can run before the first write lands). */
const stored = async (userData: string) => {
  try {
    return JSON.parse(await readFile(path.join(userData, 'walkthrough.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

/** Replaces the active editor's text and saves it (Ctrl+S), then waits until the file on disk has it. */
async function editAndSave(file: string, transform: (text: string) => string) {
  await openFile(page, file);
  const full = path.join(projectRoot, file);
  const before = await readFile(full, 'utf8');
  const after = transform(before);
  expect(after).not.toBe(before);
  // Focus the editor's own input (a click could land on an empty, scrolled part of the view), then paste.
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), after);
  await page.getByRole('textbox', { name: `编辑器: ${file}` }).focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+V');
  await page.keyboard.press('ControlOrMeta+S');
  await expect.poll(() => readFile(full, 'utf8')).toBe(after);
}

let projectRoot = '';

test.beforeAll(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-walkthrough-'))); // macOS: /var → /private/var
  documents = path.join(tmp, '我的 文档');
  await mkdir(documents);
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

test.describe('walkthrough engine and glossary (S23.1, S23.4)', () => {
  const userData = () => path.join(tmp, '引擎 数据');

  test('Help opens the walkthrough; steps are anchored, skippable and keyboard-reachable; it can be closed and revisited', async () => {
    await start(userData());
    await expect(panel()).toHaveCount(0); // never shown by itself on a plain start
    await menu('help-walkthrough');
    await expect(panel()).toHaveAttribute('data-step', 'create');
    await expect(page.getByTestId('walkthrough-progress')).toHaveText('第 1 步，共 8 步');
    await expect(page.getByTestId('walkthrough-title')).toHaveText('创建你的第一个网页');
    await expect(page.getByTestId('walkthrough-where')).toContainText('创建我的第一个网页');
    await expect(check()).toHaveText('等你完成这一步……（也可以跳过）');
    await expect.poll(anchored).toEqual(['welcome-create']);
    await page.getByTestId('walkthrough-show').click();
    await expect(page.getByTestId('welcome-create')).toBeFocused();

    // Skip: Next works without the step being done, and does not mark it done.
    await expect(next()).toHaveText('跳过这一步');
    await next().click();
    await expect(panel()).toHaveAttribute('data-step', 'files');
    await expect(panel()).toHaveAttribute('data-done', 'false');
    await page.getByTestId('walkthrough-back').click();
    await expect(panel()).toHaveAttribute('data-step', 'create');
    // Keyboard only.
    await next().focus();
    await page.keyboard.press('Enter');
    await expect(panel()).toHaveAttribute('data-step', 'files');
    await page.keyboard.press('Enter');
    await expect(panel()).toHaveAttribute('data-step', 'heading');

    // Close (skip the walkthrough): hidden, stored as closed; Help reopens it at the first step not done yet.
    await page.getByTestId('walkthrough-close').click();
    await expect(panel()).toHaveCount(0);
    // The store writes atomically (temp file + rename): between the two the file is briefly absent, so a read that
    // fails is 'not yet', not a failure (seen once on the Windows CI runner).
    await expect.poll(async () => (await stored(userData()).catch(() => null))?.status).toBe('closed');
    await menu('help-walkthrough');
    await expect(panel()).toHaveAttribute('data-step', 'create');
    // The rail's labelled "课程" button runs the same command: lessons are never only in a menu.
    await page.getByTestId('walkthrough-close').click();
    await expect(panel()).toHaveCount(0);
    await page.getByTestId('rail-lessons').click();
    await expect(panel()).toHaveAttribute('data-step', 'create');
  });

  test("S47.6: the band folds to one line (step · title · Show me · Next); a step's first view is always full", async () => {
    // Full on this first view of "create": the text, the location, the terms, the check line.
    const band = panel();
    await expect(band).toHaveAttribute('data-compact', 'false');
    await expect(page.getByTestId('walkthrough-body')).toBeVisible();
    await page.getByTestId('walkthrough-compact').click();
    await expect(band).toHaveAttribute('data-compact', 'true');
    await expect(page.getByTestId('walkthrough-body')).toHaveCount(0);
    await expect(page.getByTestId('walkthrough-check')).toHaveCount(0);
    // One line, at most 56 px: the step, the title, Show me and Next share one row.
    const box = (await band.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(56);
    const rows = new Set<number>();
    for (const id of ['walkthrough-progress', 'walkthrough-title', 'walkthrough-show', 'walkthrough-next']) {
      const r = (await page.getByTestId(id).boundingBox())!;
      expect(r.y >= box.y && r.y + r.height <= box.y + box.height, `${id} inside the band`).toBe(true);
      rows.add(Math.round(r.y + r.height / 2));
    }
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThanOrEqual(4);
    await expect(page.getByTestId('walkthrough-progress')).toHaveText('第 1 步，共 8 步');
    await expect(page.getByTestId('walkthrough-title')).toHaveText('创建你的第一个网页');
    await expect(next()).toHaveText('跳过这一步'); // the done state is the button's own label
    await expect.poll(async () => (await stored(userData())).compact).toBe(true);

    // A step seen before folds too (files and heading were visited above); a step never seen shows in full even
    // while compact is chosen.
    await next().click();
    await expect(band).toHaveAttribute('data-step', 'files');
    await expect(band).toHaveAttribute('data-compact', 'true');
    await next().click();
    await expect(band).toHaveAttribute('data-step', 'heading');
    await expect(band).toHaveAttribute('data-compact', 'true');
    await next().click();
    await expect(band).toHaveAttribute('data-step', 'style');
    await expect(band).toHaveAttribute('data-compact', 'false');
    await expect(page.getByTestId('walkthrough-body')).toBeVisible();
    await page.getByTestId('walkthrough-back').click();
    await expect(band).toHaveAttribute('data-step', 'heading');
    await expect(band).toHaveAttribute('data-compact', 'true');
    // Expand: the full text comes back on every step until the user folds it again.
    await page.getByTestId('walkthrough-expand').click();
    await expect(band).toHaveAttribute('data-compact', 'false');
    await expect.poll(async () => (await stored(userData())).compact).toBe(false);
    await page.getByTestId('walkthrough-compact').click();
    await expect(band).toHaveAttribute('data-compact', 'true');
  });

  test('progress and the compact choice survive a restart', async () => {
    await expect(panel()).toHaveAttribute('data-step', 'heading');
    await expect(panel()).toHaveAttribute('data-compact', 'true');
    await expect.poll(async () => (await stored(userData()))?.step).toBe('heading');
    // The compact choice is saved asynchronously after the click above; wait for it before the restart.
    await expect.poll(async () => (await stored(userData()))?.compact).toBe(true);
    await quitApp(userData());
    await start(userData());
    await expect(panel()).toHaveAttribute('data-step', 'heading');
    await expect(page.getByTestId('walkthrough-progress')).toHaveText('第 3 步，共 8 步');
    await expect.poll(anchored).toEqual([]); // no project open: the heading step's file is not there to point at
    // S47.6: the compact choice came back with the progress (a step seen before folds); a never-seen step stays full.
    await expect(panel()).toHaveAttribute('data-compact', 'true');
    expect((await panel().boundingBox())!.height).toBeLessThanOrEqual(56);
    await next().click(); // style: seen above, folds
    await expect(panel()).toHaveAttribute('data-step', 'style');
    await expect(panel()).toHaveAttribute('data-compact', 'true');
    await next().click(); // interaction: never seen, full
    await expect(panel()).toHaveAttribute('data-step', 'interaction');
    await expect(panel()).toHaveAttribute('data-compact', 'false');
    await page.getByTestId('walkthrough-back').click(); // from the full band; the compact one has Show me and Next only
    await expect(panel()).toHaveAttribute('data-step', 'style');
    await expect(panel()).toHaveAttribute('data-compact', 'true');
    await page.getByTestId('walkthrough-expand').click();
    await expect(panel()).toHaveAttribute('data-compact', 'false');
    await page.getByTestId('walkthrough-back').click();
    await expect(panel()).toHaveAttribute('data-step', 'heading');
  });

  test('standard terms in a step link to the glossary, which keeps the terms as they are (S23.4)', async () => {
    await page.getByTestId('walkthrough-back').click(); // "meet the files" links HTML, CSS, JavaScript
    // S47.6: in zh-CN a chip shows the Chinese name and the standard term; the glossary keeps the term itself.
    await expect(page.getByTestId('walkthrough-term')).toHaveText([
      '超文本标记语言 HTML',
      '层叠样式表 CSS',
      'JavaScript 脚本语言',
    ]);
    await page.locator('[data-testid="walkthrough-term"][data-term="CSS"]').click();
    const glossary = page.getByTestId('glossary');
    await expect(glossary).toBeVisible();
    await expect(glossary).toHaveAttribute('aria-modal', 'true');
    const css = glossary.locator('[data-testid="glossary-entry"][data-term="CSS"]');
    await expect(css).toHaveAttribute('aria-current', 'true');
    await expect(css).toBeFocused();
    await expect(css).toContainText('层叠样式表');
    await page.keyboard.press('Escape');
    await expect(glossary).toHaveCount(0);

    // From Help: search in either language; the standard term is shown verbatim in Chinese and in English.
    await menu('help-glossary');
    await expect(page.getByTestId('glossary-search')).toBeFocused();
    expect(await page.getByTestId('glossary-entry').count()).toBeGreaterThanOrEqual(15);
    await page.getByTestId('glossary-search').fill('选择器');
    await expect(page.getByTestId('glossary-term')).toHaveText(['CSS', 'selector']);
    await page.getByTestId('glossary-search').fill('没有这种词');
    await expect(page.getByTestId('glossary-empty')).toHaveText('没有找到这个术语。');
    await page.getByTestId('glossary-close').click();
    await switchLanguage(page);
    await expect(page.getByTestId('walkthrough-title')).toHaveText('Meet the three files');
    await expect(next()).toHaveText('Skip this step');
    await expect(page.getByTestId('walkthrough-term')).toHaveText(['HTML', 'CSS', 'JavaScript']); // en: the term alone
    await menu('help-glossary');
    await expect(page.getByRole('heading', { name: 'Glossary' })).toBeVisible();
    await page.getByTestId('glossary-search').fill('selector');
    const selector = page.locator('[data-testid="glossary-entry"][data-term="selector"]');
    await expect(selector.getByTestId('glossary-term')).toHaveText('selector');
    await expect(selector).toContainText('which elements the style applies to');
    await page.keyboard.press('Escape');
    await switchLanguage(page);
    await page.getByTestId('walkthrough-close').click();
    expect(consoleErrors).toEqual([]);
    await quitApp(userData());
  });
});

test.describe('the PLAN §2 journey (S23.2) and the final task (S23.3)', () => {
  const userData = () => path.join(tmp, '旅程 数据');
  type HookWindow = { __noobideProblemsTestHooks: { static: ProblemRecord[] } };
  const staticProblems = () =>
    page.evaluate(() =>
      (window as unknown as HookWindow).__noobideProblemsTestHooks.static.map((r) => `${r.file}:${r.line}:${r.code}`),
    );

  test('create: the first project made with the wizard starts the walkthrough inside it', async () => {
    await start(userData());
    await page.getByTestId('welcome-create').click();
    await page.getByTestId('wizard-create').click();
    projectRoot = path.join(documents, 'NoobIDE 项目', '我的第一个网页');
    await expect(page.getByTestId('project-name')).toHaveAttribute('title', projectRoot);
    await waitForPreviewState(page, 'running');
    await expect(panel()).toHaveAttribute('data-step', 'files');
    await page.getByTestId('walkthrough-back').click();
    await expect(panel()).toHaveAttribute('data-step', 'create');
    await expect(check()).toHaveText('✓ 这一步完成了！');
    await expect(next()).toHaveText('下一步');
    await next().click();
  });

  test('meet the files: opening index.html, style.css and script.js completes the step', async () => {
    await expect(panel()).toHaveAttribute('data-done', 'false');
    await expect.poll(anchored).toEqual(['file-tree']);
    await openFile(page, 'style.css');
    await expect(panel()).toHaveAttribute('data-done', 'false');
    await openFile(page, 'script.js');
    await openFile(page, 'index.html');
    await expect(panel()).toHaveAttribute('data-done', 'true');
    await expect(check()).toHaveText('✓ 这一步完成了！');
    await next().click();
  });

  test('heading: the saved heading change is detected and the preview shows it', async () => {
    await expect(panel()).toHaveAttribute('data-step', 'heading');
    await expect.poll(anchored).toEqual(['index.html']);
    // An edit elsewhere in the page is not the step.
    await editAndSave('index.html', (t) => t.replace('<li>散步</li>', '<li>跑步</li>'));
    await page.waitForTimeout(500);
    await expect(panel()).toHaveAttribute('data-done', 'false');
    await editAndSave('index.html', (t) => t.replace('你好，我是小雨', '你好，我是林小雨'));
    await expect(panel()).toHaveAttribute('data-done', 'true');
    await expect
      .poll(() => evalInPreview<string>(app, "document.querySelector('h1').textContent"), { timeout: 15_000 })
      .toBe('你好，我是林小雨');
    await next().click();
  });

  test('style: a changed colour is detected and visible in the preview', async () => {
    await expect(panel()).toHaveAttribute('data-step', 'style');
    await expect.poll(anchored).toEqual(['style.css']);
    await editAndSave('style.css', (t) =>
      t.replace('color: #2563eb;\n  font-size: 32px;', 'color: #db2777;\n  font-size: 32px;'),
    );
    await expect(panel()).toHaveAttribute('data-done', 'true');
    await expect
      .poll(() => evalInPreview<string>(app, "getComputedStyle(document.querySelector('h1')).color"), {
        timeout: 15_000,
      })
      .toBe('rgb(219, 39, 119)');
    await next().click();
  });

  test('interaction: the changed button text is detected, and clicking the button in the preview shows it', async () => {
    await expect(panel()).toHaveAttribute('data-step', 'interaction');
    await expect(page.getByTestId('walkthrough-body')).toContainText('点一下按钮');
    await editAndSave('script.js', (t) => t.replace('很高兴认识你', '欢迎来到我的主页'));
    await expect(panel()).toHaveAttribute('data-done', 'true');
    await expect
      .poll(
        () =>
          evalInPreview<string>(
            app,
            "document.querySelector('#greet-button').click(); document.querySelector('#message').textContent",
          ),
        { timeout: 15_000 },
      )
      .toBe('你好！欢迎来到我的主页，我是小雨。');
    await next().click();
  });

  test('deliberate error: a misspelled variable is detected and the problem shows file, line, explanation and original error', async () => {
    await expect(panel()).toHaveAttribute('data-step', 'error');
    await expect.poll(anchored).toEqual(['problems-toggle']);
    await editAndSave('script.js', (t) => t.replace('+ userName +', '+ userNmae +'));
    await expect(panel()).toHaveAttribute('data-done', 'true', { timeout: 30_000 });
    await page.getByTestId('walkthrough-show').click();
    await expect(page.getByTestId('problems-toggle')).toBeFocused();
    await page.keyboard.press('Enter');
    const row = page.getByTestId('problem-row').filter({ hasText: 'script.js:12' }).first();
    await expect(row).toContainText('找不到变量 userNmae');
    await row.getByTestId('problem-summary').click();
    await expect(row.getByTestId('problem-card')).toBeVisible();
    // S22.4: the card the lesson describes — file and line, explanation, and the suggested checks.
    await expect(row.getByTestId('problem-card-location')).toHaveText('script.js，第 12 行：');
    await expect(row.getByTestId('problem-explanation')).toHaveText('这个名字可能拼错了，也可能还没有定义。');
    await expect(row.getByTestId('problem-checks')).toContainText('检查它的拼写是否和定义时的 userName', {
      timeout: 15_000,
    });
    await expect(row.getByTestId('problem-checks')).toContainText('如果这个变量还没有定义，先声明它。');
    await row.getByTestId('problem-show-original').click();
    await expect(row.getByTestId('problem-original-message')).toHaveText(
      "Cannot find name 'userNmae'. Did you mean 'userName'?",
    );
    await page.getByTestId('problems-toggle').click();
    await next().click();
  });

  test('restore: going back to the version before the mistake through local history is detected', async () => {
    await expect(panel()).toHaveAttribute('data-step', 'restore');
    await expect.poll(anchored).toEqual(['rail-history']);
    await page.getByTestId('rail-history').click();
    const dialog = page.getByTestId('history-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('history-file').filter({ hasText: 'script.js' }).click();
    const versions = page.getByTestId('history-version');
    await expect.poll(() => versions.count()).toBeGreaterThanOrEqual(2);
    // The newest version has the mistake; the one before it is the working script. The diff is shown first.
    await versions.nth(1).click();
    await expect(page.getByTestId('history-diff').locator('[data-kind="added"]')).toContainText('+ userName +');
    await page.getByTestId('history-restore').click();
    await expect(page.getByTestId('history-notice')).toContainText('已恢复');
    await page.getByTestId('history-close').click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => readFile(path.join(projectRoot, 'script.js'), 'utf8')).toContain('+ userName +');
    await expect(panel()).toHaveAttribute('data-done', 'true');
    await expect.poll(staticProblems, { timeout: 30_000 }).toEqual([]);
    await next().click();
  });

  test('reopen: closing the app and opening it again restores the project and completes the journey', async () => {
    await expect(panel()).toHaveAttribute('data-step', 'reopen');
    await expect(panel()).toHaveAttribute('data-done', 'false');
    await expect.poll(anchored).toEqual(['project-menu']); // S47.4: the path is the name's tooltip and a line of the menu
    await page.waitForTimeout(800); // tabs and layout are written 300 ms after the last change
    expect(consoleErrors).toEqual([]);
    await quitApp(userData());

    await start(userData());
    await expect(page.getByTestId('project-name')).toHaveAttribute('title', projectRoot);
    await expect(page.locator('[data-testid="tab"][data-path="script.js"]')).toHaveCount(1);
    await expect(panel()).toHaveAttribute('data-step', 'reopen');
    await expect(panel()).toHaveAttribute('data-done', 'true');
    await expect(next()).toHaveText('完成课程');
    // The panel shows the detected step at once; main writes walkthrough.json afterwards (IPC save → serial queue →
    // atomic temp + rename), so the stored list is polled rather than read once (run 39033418043, Windows shard 1).
    await expect
      .poll(async () => (await stored(userData()))?.completed)
      .toEqual(['create', 'files', 'heading', 'style', 'interaction', 'error', 'restore', 'reopen']);
    await next().click();
    await expect(panel()).toHaveAttribute('data-step', 'offer');
  });

  test('final task: the goal only, no hints; completion is detected from the saved files (S23.3)', async () => {
    await page.getByTestId('task-start').click();
    const task = page.getByTestId('final-task');
    await expect(task).toBeVisible();
    await expect(page.getByTestId('task-goal')).toContainText('<p>');
    await expect(task).toHaveAttribute('data-done', 'false');
    // Unguided: nothing is outlined, no Show me, no step progress.
    expect(await anchored()).toEqual([]);
    await expect(task.getByTestId('walkthrough-show')).toHaveCount(0);
    await expect(task.getByTestId('walkthrough-progress')).toHaveCount(0);
    await expect(page.getByTestId('task-check')).toHaveText('还没完成——保存后这里会自动检查。');

    // Half of the task (a paragraph without a colour of its own) is not done.
    await editAndSave('index.html', (t) =>
      t.replace('</main>', '  <p class="about-me">我想做一个自己的网站。</p>\n    </main>'),
    );
    await page.waitForTimeout(800);
    await expect(task).toHaveAttribute('data-done', 'false');
    await editAndSave('style.css', (t) => `${t}\n.about-me {\n  color: #16a34a;\n}\n`);
    await expect(task).toHaveAttribute('data-done', 'true');
    await expect(page.getByTestId('task-check')).toHaveText('完成了！你自己改了页面结构和样式，整个流程你已经会了。');
    // S14.4: a project created from a built-in template is trusted, so after a restart it previews by itself.
    await waitForPreviewState(page, 'running');
    await expect
      .poll(() => evalInPreview<string>(app, "getComputedStyle(document.querySelector('.about-me')).color"), {
        timeout: 15_000,
      })
      .toBe('rgb(22, 163, 74)');
    await page.getByTestId('task-close').click();
    await expect(task).toHaveCount(0);
    await expect.poll(async () => (await stored(userData()))?.task).toBe('done');
    expect(consoleErrors).toEqual([]);
  });
});
