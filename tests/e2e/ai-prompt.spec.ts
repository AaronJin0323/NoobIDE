import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { DOC_START } from './keys';
import {
  collectConsoleErrors,
  documentText,
  focusEditor,
  makeProject,
  openFile,
  openProject,
  switchLanguage,
} from './project';

/**
 * S42.3 end to end against the scripted fake provider (decision 0031): an inline `/ai` prompt typed into the code, in
 * Chinese and in English, on a project whose path has Chinese characters and spaces.
 *
 * The fake turns only answer when the request carries what the feature promises: the Chinese turn matches the end of
 * the user message — the file's static problem (an unclosed <div>) framed in <problems>, followed by the request — so
 * the generated button proves the problem context reached the model. Anything else gets the built-in
 * `<p>Written by the fake AI.</p>`.
 */
test.describe.configure({ mode: 'serial' });

const HTML = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<body>',
  '  <div class="box">',
  '  <p id="count">0</p>',
  '</body>',
  '</html>',
  '',
].join('\n');
const ZH_PROMPT = '做一个点击后数字加一的按钮';
const WITH_BUTTON = HTML.replace(
  '  <p id="count">0</p>\n',
  '  <p id="count">0</p>\n  <button id="add">加一</button>\n  <p>点了 <span id="n">0</span> 次</p>\n',
);
const CSS = 'h1 {\n  color: navy;\n}\n';
const OLD = '<p>\n/ai keep this line\n</p>\n';

const FAKE = JSON.stringify({
  includeBuiltin: true,
  turns: [
    {
      purpose: 'edit',
      systemMatch: 'The user typed a request on its own line of their file',
      match: `html-unclosed-tag: Unclosed element \`div\`.\n</problems>\nRequest: ${ZH_PROMPT}`,
      repeat: true,
      // Unindented on purpose: NoobIDE indents it like the /ai line.
      steps: [{ type: 'text', text: '<button id="add">加一</button>\n<p>点了 <span id="n">0</span> 次</p>' }],
    },
    {
      purpose: 'edit',
      systemMatch: 'Write any comments in English.',
      match: 'Request: center this heading',
      repeat: true,
      steps: [{ type: 'text', text: 'h1 {\n  text-align: center;\n}' }],
    },
  ],
});

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const disk = (relPath: string) => readFile(path.join(root, relPath), 'utf8');
const zone = () => page.getByTestId('inline-edit-panel');
const status = () => zone().getByTestId('inline-edit-status');
const announce = () => page.getByTestId('inline-edit-announce');
const editorText = () => documentText(page.locator('.monaco-editor').first());
/** The end-of-line hints in words (Monaco renders spaces as no-break spaces). */
const hints = async () =>
  (await page.locator('.monaco-editor .ai-prompt-hint').allTextContents())
    .join('|')
    .replaceAll(String.fromCharCode(0xa0), ' ');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

type HookWindow = { __noobideProblemsTestHooks: { static: { file?: string; line?: number; code: string }[] } };
const staticProblems = () =>
  page.evaluate(() =>
    (window as unknown as HookWindow).__noobideProblemsTestHooks.static.map((r) => `${r.file}:${r.line}:${r.code}`),
  );

/** Puts the cursor at the end of line `n` (1-based) of the open file. */
async function lineEnd(n: number) {
  await focusEditor(page);
  await page.keyboard.press(DOC_START);
  for (let i = 1; i < n; i += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
}

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-AI 提示-'));
  await writeFile(path.join(root, 'index.html'), HTML);
  await writeFile(path.join(root, 'style.css'), CSS);
  await writeFile(path.join(root, 'old.html'), OLD);
  app = await launchApp({ NOOBIDE_AI_FAKE: FAKE });
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await page.evaluate(async () => {
    const ai = (window.noobide as unknown as { ai: { setKey(r: { provider: string; key: string }): Promise<unknown> } })
      .ai;
    await ai.setKey({ provider: 'anthropic', key: 'fake-key-for-tests' });
    window.dispatchEvent(new Event('noobide:ai-status-changed'));
  });
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('a Chinese /ai prompt: hint and warning, Enter, consent, diff with the problem context, Accept saves, one undo (zh-CN)', async () => {
  await openFile(page, 'index.html');
  await lineEnd(5);
  await page.keyboard.press('Enter');
  await page.keyboard.type(`/ai ${ZH_PROMPT}`);

  // A pending prompt is never silent: a hint in words at the end of the line, and a warning in Problems.
  await expect.poll(hints).toMatch(/让 AI 写代码/);
  await expect.poll(staticProblems, { timeout: 15_000 }).toContain('index.html:6:ai-prompt-pending');
  expect(await staticProblems()).toContain('index.html:4:html-unclosed-tag');

  await page.keyboard.press('Enter');
  await expect(zone()).toBeVisible();
  await expect(zone().getByTestId('inline-edit-target')).toHaveText('AI 写的代码会替换 index.html 第 6 行的 /ai 要求');
  await expect(zone().getByTestId('inline-edit-prompt')).toHaveText(`你的要求：${ZH_PROMPT}`);
  // First AI use in this project: nothing is sent before the consent answer.
  await zone().getByTestId('ai-consent-allow').click();
  await expect(zone()).toHaveAttribute('data-phase', 'review', { timeout: 30_000 });
  await expect(status()).toContainText('删除 1 行，添加 2 行');
  const diff = zone().getByTestId('inline-edit-diff');
  await expect(diff.locator('[data-kind="removed"]')).toContainText(`/ai ${ZH_PROMPT}`);
  await expect(diff.locator('[data-kind="added"]').first()).toContainText('<button id="add">加一</button>');

  await expect(zone().getByTestId('inline-edit-accept')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(zone()).toHaveCount(0);
  await expect(announce()).toContainText('已接受 AI 的修改并保存');
  // Indented like the /ai line, saved through the save pipeline; the prompt is gone from disk.
  await expect.poll(() => disk('index.html')).toBe(WITH_BUTTON);
  await expect.poll(staticProblems).not.toContain('index.html:6:ai-prompt-pending');

  // One undo step brings the /ai line back exactly.
  await focusEditor(page);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(editorText).toContain(`  /ai ${ZH_PROMPT}`);
  expect(await editorText()).not.toContain('<button id="add">');
});

test('"Fix with AI" on the pending warning runs the prompt; Ctrl/Cmd+Enter too; Reject and Esc leave the line', async () => {
  // The warning's "Fix with AI" runs the /ai request (generate mode), not a fix request about the line: the scripted
  // Chinese turn only answers the generate system prompt, so the button in the diff proves the mode.
  await expect.poll(staticProblems, { timeout: 15_000 }).toContain('index.html:6:ai-prompt-pending');
  await page.getByTestId('problems-toggle').click();
  const row = page.getByTestId('problem-row').filter({ hasText: 'index.html:6' });
  await expect(row.first()).toBeVisible({ timeout: 15_000 });
  const summary = row.first().getByTestId('problem-summary');
  if ((await summary.getAttribute('aria-expanded')) !== 'true') await summary.click();
  await row.first().getByTestId('problem-card').getByTestId('problem-fix-ai').click();
  await expect(zone().getByTestId('inline-edit-target')).toHaveText('AI 写的代码会替换 index.html 第 6 行的 /ai 要求');
  await expect(zone().getByTestId('inline-edit-prompt')).toHaveText(`你的要求：${ZH_PROMPT}`);
  await expect(zone()).toHaveAttribute('data-phase', 'review', { timeout: 30_000 });
  await expect(zone().getByTestId('inline-edit-diff').locator('[data-kind="added"]').first()).toContainText(
    '<button id="add">加一</button>',
  );
  await zone().getByTestId('inline-edit-reject').click();
  await expect(zone()).toHaveCount(0);
  expect(await editorText()).toContain(`/ai ${ZH_PROMPT}`);
  await page.getByTestId('problems-toggle').click();

  await lineEnd(6);
  await page.keyboard.press(`${mod}+Enter`);
  await expect(zone()).toHaveAttribute('data-phase', 'review', { timeout: 30_000 });
  await zone().getByTestId('inline-edit-reject').click();
  await expect(zone()).toHaveCount(0);
  await expect(announce()).toHaveText('已拒绝 AI 的修改，代码没有变化。');
  expect(await editorText()).toContain(`/ai ${ZH_PROMPT}`);

  await lineEnd(6);
  await page.keyboard.press(`${mod}+Enter`);
  await expect(zone()).toHaveAttribute('data-phase', 'review', { timeout: 30_000 });
  await expect(zone().locator(':focus')).toHaveCount(1); // the phase's control has the focus
  await page.keyboard.press('Escape'); // = Reject
  await expect(zone()).toHaveCount(0);
  expect(await editorText()).toContain(`/ai ${ZH_PROMPT}`);

  // Delete the prompt line: the warning goes, and the file is back to what it was.
  await lineEnd(6);
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press(`${mod}+s`);
  await expect.poll(() => disk('index.html')).toBe(HTML);
  await expect.poll(staticProblems).not.toContain('index.html:6:ai-prompt-pending');
});

test('Enter is not taken over: an /ai line from disk, Shift+Enter, and Enter that ends an IME composition', async () => {
  await openFile(page, 'old.html');
  // From disk: not armed. The hint names the shortcut instead, and Enter is an ordinary line break.
  await expect.poll(hints).toMatch(/Ctrl\+Enter 让 AI 写代码|⌘Enter 让 AI 写代码/);
  await lineEnd(2);
  await page.keyboard.press('Enter');
  await expect.poll(editorText).toContain('/ai keep this line');
  await expect(zone()).toHaveCount(0);
  await page.keyboard.press(`${mod}+z`);

  // Typed on the line (armed), but Shift+Enter is always a plain line break.
  await lineEnd(2);
  await page.keyboard.type(' now');
  await expect.poll(hints).toMatch(/⏎ 让 AI 写代码/);
  await page.keyboard.press('Shift+Enter');
  await page.waitForTimeout(300);
  await expect(zone()).toHaveCount(0);
  await page.keyboard.press(`${mod}+z`);

  // An IME composition (Pinyin) at the end of the armed line: the Enter that confirms the candidate is the IME's.
  await lineEnd(2);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  });
  await cdp.send('Input.insertText', { text: '你' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.waitForTimeout(300);
  await expect(zone()).toHaveCount(0);
  await expect.poll(editorText).toContain('/ai keep this line now你');
  await cdp.detach();

  // Put the file back.
  await page.keyboard.press(`${mod}+z`);
  await page.keyboard.press(`${mod}+z`);
  await page.keyboard.press(`${mod}+s`);
  await expect.poll(() => disk('old.html')).toBe(OLD);

  // Changed outside NoobIDE: the clean buffer reloads, and a reloaded /ai line is not armed either.
  // (Not right after our own save, which the watcher would rightly take for our own write.)
  await page.waitForTimeout(2000);
  await writeFile(path.join(root, 'old.html'), OLD.replace('</p>', '/ai changed elsewhere\n</p>'));
  await expect.poll(editorText, { timeout: 20_000 }).toContain('/ai changed elsewhere');
  await lineEnd(3);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await expect(zone()).toHaveCount(0);
  await page.keyboard.press(`${mod}+z`);
});

test('en: an English prompt from the context menu, labels in English, Accept and undo', async () => {
  await switchLanguage(page);
  try {
    await openFile(page, 'style.css');
    await lineEnd(3);
    await page.keyboard.press('Enter');
    // Suggestions stay out of a prompt line: `.` and spaces open no CSS / project-class list, so plain Enter (no
    // Escape first) runs the request.
    await page.keyboard.type('/ai center .box', { delay: 60 }); // as fast as a person: suggestions get time to open
    await expect.poll(hints).toMatch(/let AI write it/);
    await page.keyboard.press('Enter');
    await expect(zone().getByTestId('inline-edit-target')).toHaveText(
      'The AI code replaces the /ai request on line 4 of style.css',
    );
    await expect(zone()).toHaveAttribute('data-phase', 'review', { timeout: 30_000 });
    // The review phase moves focus to its main control one render later; Escape is the panel's key from there.
    await expect(zone().locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape'); // = Reject
    await expect(zone()).toHaveCount(0);
    await expect(page.locator('.monaco-editor .suggest-widget.visible')).toHaveCount(0);

    // The same line, rewritten (typed again, so still armed).
    await lineEnd(4);
    await page.keyboard.press('Shift+Home');
    await page.keyboard.type('/ai center this heading');
    await expect.poll(editorText).toContain('/ai center this heading');
    await expect.poll(hints).toMatch(/let AI write it/);

    // A right click on the prompt line puts the cursor there and opens the editor's menu.
    await page
      .locator('.monaco-editor .view-line', { hasText: '/ai center this heading' })
      .click({ button: 'right', position: { x: 20, y: 5 } });
    const item = page.getByRole('menuitem', { name: 'Run this /ai request' });
    await item.hover();
    await page.keyboard.press('Enter');

    await expect(zone().getByTestId('inline-edit-target')).toHaveText(
      'The AI code replaces the /ai request on line 4 of style.css',
    );
    await expect(zone().getByTestId('inline-edit-prompt')).toHaveText('Your request: center this heading');
    await expect(zone()).toHaveAttribute('data-phase', 'review', { timeout: 30_000 });
    await expect(zone().getByTestId('inline-edit-diff')).toContainText('text-align: center;');
    await zone().getByTestId('inline-edit-accept').click();
    await expect(announce()).toContainText('AI change applied and saved');
    await expect.poll(() => disk('style.css')).toBe(`${CSS}h1 {\n  text-align: center;\n}\n`);

    await focusEditor(page);
    await page.keyboard.press(`${mod}+z`);
    await expect.poll(editorText).toContain('/ai center this heading');
  } finally {
    await switchLanguage(page); // back to zh-CN
  }
});

test('without an AI key an /ai line is ordinary text: Enter breaks the line, no hint, no warning, no zone', async () => {
  await page.evaluate(async () => {
    const ai = (window.noobide as unknown as { ai: { clearKey(r: { provider: string }): Promise<unknown> } }).ai;
    await ai.clearKey({ provider: 'anthropic' });
    window.dispatchEvent(new Event('noobide:ai-status-changed'));
  });
  await openFile(page, 'index.html');
  await expect.poll(hints).toBe('');
  await lineEnd(5);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/ai 把标题居中');
  await page.keyboard.press('Enter');
  await page.keyboard.type('x');
  // Enter was a plain line break: the `x` is on a line of its own.
  const viewLines = page.locator('.monaco-editor .view-line');
  await expect(viewLines.filter({ hasText: '/ai 把标题居中' })).toHaveCount(1);
  expect(await viewLines.filter({ hasText: '/ai 把标题居中' }).textContent()).not.toContain('x');
  await expect(page.getByText('行 7, 列 4')).toBeVisible(); // the cursor after `  x`, one line below the /ai line
  await expect(zone()).toHaveCount(0);
  expect(await hints()).toBe('');
  await page.waitForTimeout(1000);
  expect((await staticProblems()).filter((p) => p.endsWith(':ai-prompt-pending'))).toEqual([]);
});

test('no console errors', () => {
  expect(consoleErrors).toEqual([]);
});
