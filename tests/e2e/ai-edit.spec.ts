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
 * S35 end to end against the fake provider: the inline edit (Ctrl/Cmd+I) and "Fix with AI" on the problem card, on a
 * project whose path has Chinese characters and spaces.
 *
 * Fake turns for purpose `edit` (inline JSON script, plus the built-in scenarios such as `[[slow]]` / `[[offline]]`):
 *   - "make it blue" → the selected heading line with a blue style;
 *   - "add a comment" → a comment in the request's locale (the system prompt says which language to write in);
 *   - the original error of the misspelled name → the fixed script (S35.2);
 *   - anything else → the built-in `<p>Edited by the fake AI.</p>`.
 */
test.describe.configure({ mode: 'serial' });

const HTML = '<!doctype html>\n<html lang="zh-CN">\n<h1>你好</h1>\n<script src="script.js"></script>\n';
const BLUE = HTML.replace('<h1>你好</h1>', '<h1 style="color: blue">你好</h1>');
const SCRIPT = "// 点按钮时打个招呼\nconst userName = '林小雨';\nconsole.log(userNmae);\n";
const FIXED = "// 点按钮时打个招呼\nconst userName = '林小雨';\nconsole.log(userName);\n";

const FAKE = JSON.stringify({
  includeBuiltin: true,
  turns: [
    {
      purpose: 'edit',
      match: 'make it blue',
      repeat: true,
      steps: [{ type: 'text', text: '<h1 style="color: blue">你好</h1>' }],
    },
    {
      purpose: 'edit',
      match: 'add a comment',
      systemMatch: 'Simplified Chinese',
      repeat: true,
      steps: [{ type: 'text', text: '<!-- 中文注释 -->\n<h1>你好</h1>' }],
    },
    {
      purpose: 'edit',
      match: 'add a comment',
      systemMatch: 'in English',
      repeat: true,
      steps: [{ type: 'text', text: '<!-- English comment -->\n<h1>你好</h1>' }],
    },
    {
      purpose: 'edit',
      match: 'userNmae is not defined',
      repeat: true,
      steps: [{ type: 'text', text: FIXED.trimEnd() }],
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
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Selects the whole of line `n` (1-based) of the open file. */
async function selectLine(n: number) {
  await focusEditor(page);
  await page.keyboard.press(DOC_START);
  for (let i = 1; i < n; i += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
}

async function ask(instruction: string) {
  const input = zone().getByTestId('inline-edit-input');
  await expect(input).toBeFocused();
  await input.fill(instruction);
  await input.press('Enter');
}

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-AI 修改-'));
  await writeFile(path.join(root, 'index.html'), HTML);
  await writeFile(path.join(root, 'script.js'), SCRIPT);
  app = await launchApp({ NOOBIDE_AI_FAKE: FAKE });
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await page.evaluate(async () => {
    type Config = { inlineCompletions: boolean };
    const ai = (
      window.noobide as unknown as {
        ai: {
          setKey(r: { provider: string; key: string }): Promise<unknown>;
          status(r: { projectId: null }): Promise<{ ok: true; value: { config: Config } }>;
          setConfig(r: { config: Config }): Promise<unknown>;
        };
      }
    ).ai;
    await ai.setKey({ provider: 'anthropic', key: 'fake-key-for-tests' });
    // Inline suggestions are not under test here (ai-inline.spec): their ghost text, drawn after a typed key, would
    // be read as document text (hosted macOS, run 39095901077: the stale test read 'XThis is a **sample answer**').
    const { config } = (await ai.status({ projectId: null })).value;
    await ai.setConfig({ config: { ...config, inlineCompletions: false } });
    window.dispatchEvent(new Event('noobide:ai-status-changed'));
  });
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('Ctrl/Cmd+I on a selection: consent, instruction, diff, Accept saves one undoable edit (zh-CN)', async () => {
  await openFile(page, 'index.html');
  await selectLine(3);
  await page.keyboard.press(`${mod}+i`);
  await expect(zone()).toBeVisible();
  await expect(zone().getByTestId('inline-edit-target')).toHaveText('要修改的代码：index.html 第 3 行');
  // First AI use in this project: the consent question comes first, inside the zone.
  await zone().getByTestId('ai-consent-allow').click();
  await ask('make it blue');
  await expect(zone()).toHaveAttribute('data-phase', 'review', { timeout: 30_000 });
  await expect(status()).toContainText('AI 建议的修改：删除 1 行，添加 1 行');
  const diff = zone().getByTestId('inline-edit-diff');
  await expect(diff.locator('[data-kind="removed"]')).toHaveText(/−\s*删除：<h1>你好<\/h1>/);
  await expect(diff.locator('[data-kind="added"]')).toHaveText(/\+\s*添加：<h1 style="color: blue">你好<\/h1>/);
  // Nothing changes before Accept.
  expect(await disk('index.html')).toBe(HTML);
  await expect(zone().getByTestId('inline-edit-accept')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(zone()).toHaveCount(0);
  await expect(announce()).toContainText('已接受 AI 的修改并保存');
  await expect.poll(() => disk('index.html')).toBe(BLUE);

  // One undo step takes the whole change back.
  await focusEditor(page);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(editorText).toContain('<h1>你好</h1>');
  expect(await editorText()).not.toContain('color: blue');
  await page.keyboard.press(`${mod}+s`);
  await expect.poll(() => disk('index.html')).toBe(HTML);
});

test('the context menu opens it too; Reject leaves the text unchanged', async () => {
  await selectLine(3);
  await page.locator('.monaco-editor .view-lines').first().click({ button: 'right' });
  const item = page.getByRole('menuitem', { name: 'AI 修改' }); // S47.4: one name
  await item.hover();
  await page.keyboard.press('Enter');
  await ask('make it blue');
  await expect(zone()).toHaveAttribute('data-phase', 'review', { timeout: 30_000 });
  await zone().getByTestId('inline-edit-reject').click();
  await expect(zone()).toHaveCount(0);
  await expect(announce()).toHaveText('已拒绝 AI 的修改，代码没有变化。');
  expect(await editorText()).not.toContain('color: blue');
  expect(await disk('index.html')).toBe(HTML);
});

test('"Edit with AI" under the code is always in view and opens it on the selection', async () => {
  await selectLine(3);
  const button = page.getByTestId('editor-ai-edit');
  await expect(button).toBeVisible();
  await expect(button).toContainText('AI 修改');
  await expect(page.getByTestId('editor-ai-explain')).toBeVisible();
  await button.click();
  await expect(zone()).toBeVisible();
  await expect(zone().getByTestId('inline-edit-target')).toHaveText('要修改的代码：index.html 第 3 行');
  await ask('make it blue');
  await expect(zone()).toHaveAttribute('data-phase', 'review', { timeout: 30_000 });
  // Accept / Reject come before the diff, so they are in view without scrolling the zone.
  const accept = await zone().getByTestId('inline-edit-accept').boundingBox();
  const diffBox = await zone().getByTestId('inline-edit-diff').boundingBox();
  expect(accept && diffBox && accept.y < diffBox.y).toBe(true);
  await zone().getByTestId('inline-edit-reject').click();
  await expect(zone()).toHaveCount(0);
  expect(await disk('index.html')).toBe(HTML);
});

test('a range that changed after it was sent is not applied (stale), and says so', async () => {
  // No selection: the whole file is the range.
  await focusEditor(page);
  await page.keyboard.press(DOC_START);
  await page.keyboard.press(`${mod}+i`);
  await expect(zone().getByTestId('inline-edit-target')).toHaveText('要修改的代码：整个 index.html');
  await ask('rewrite everything');
  await expect(zone()).toHaveAttribute('data-phase', 'review', { timeout: 30_000 });
  // The user keeps typing in the file while the proposal waits.
  await focusEditor(page);
  await page.keyboard.press(DOC_START);
  await page.keyboard.type('X');
  await zone().getByTestId('inline-edit-accept').click();
  await expect(zone()).toHaveAttribute('data-phase', 'stale');
  await expect(status()).toHaveText(
    '发送之后这段代码又被改动了，所以没有应用 AI 的修改，你的代码保持不变。可以用现在的代码再试一次。',
  );
  await zone().getByTestId('inline-edit-close').click();
  await expect(zone()).toHaveCount(0);
  const text = await editorText();
  expect(text).toContain('X<!doctype html>');
  expect(text).not.toContain('Edited by the fake AI');
  // Put the file back.
  await focusEditor(page);
  await page.keyboard.press(`${mod}+z`);
  await page.keyboard.press(`${mod}+s`);
  await expect.poll(() => disk('index.html')).toBe(HTML);
});

test('Stop cancels a running edit and nothing changes', async () => {
  await selectLine(3);
  await page.keyboard.press(`${mod}+i`);
  await ask('[[slow]] 慢慢改');
  await expect(zone()).toHaveAttribute('data-phase', 'running');
  await expect(status()).toHaveText('AI 正在写修改……');
  await zone().getByTestId('inline-edit-stop').click();
  await expect(zone()).toHaveAttribute('data-phase', 'cancelled');
  await expect(status()).toHaveText('已停止，代码没有变化。');
  await expect(zone().locator(':focus')).toHaveCount(1); // the phase's control has the focus
  await page.keyboard.press('Escape');
  await expect(zone()).toHaveCount(0);
  expect(await disk('index.html')).toBe(HTML);
});

test('en: labels, the request locale, an error explained, Esc closes', async () => {
  await switchLanguage(page);
  try {
    await selectLine(3);
    await page.keyboard.press(`${mod}+i`);
    await expect(zone().getByTestId('inline-edit-target')).toHaveText('Code to change: index.html line 3');
    await ask('add a comment');
    await expect(zone()).toHaveAttribute('data-phase', 'review', { timeout: 30_000 });
    await expect(zone().getByTestId('inline-edit-diff')).toContainText('English comment');
    await expect(status()).toContainText('Proposed change: 0 lines removed, 1 lines added');
    await expect(zone().locator(':focus')).toHaveCount(1); // the phase's control has the focus
    await page.keyboard.press('Escape'); // = Reject
    await expect(announce()).toHaveText('AI change rejected. Your code is unchanged.');

    await selectLine(3);
    await page.keyboard.press(`${mod}+i`);
    await ask('[[offline]] shorten it');
    const error = zone().getByTestId('inline-edit-error');
    await expect(error).toHaveAttribute('data-code', 'offline', { timeout: 30_000 });
    await expect(error).toContainText('Cannot reach the AI service. Check the network connection.');
    await expect(zone().getByTestId('inline-edit-retry')).toBeVisible();
    await expect(zone().locator(':focus')).toHaveCount(1); // the phase's control has the focus
    await page.keyboard.press('Escape');
    await expect(zone()).toHaveCount(0);
    expect(await disk('index.html')).toBe(HTML);
  } finally {
    await switchLanguage(page); // back to zh-CN
  }
});

test('"Fix with AI" on a page problem: diff, Accept, resolved after the preview reloaded without it (S35.2)', async () => {
  await openFile(page, 'script.js');
  await page.getByTestId('preview-start').click();
  await expect(page.getByTestId('preview-state')).toHaveAttribute('data-state', 'running', { timeout: 20_000 });
  await page.getByTestId('problems-toggle').click();
  const row = page.locator('[data-section="runtime"]').getByTestId('problem-row').filter({ hasText: 'script.js:3' });
  await expect(row.first()).toBeVisible({ timeout: 20_000 });
  // "Fix with AI" is on the collapsed row itself; once the row is open, right under the card's head.
  await expect(row.first().getByTestId('problem-row-fix-ai')).toBeVisible();
  const summary = row.first().getByTestId('problem-summary');
  if ((await summary.getAttribute('aria-expanded')) !== 'true') await summary.click();
  await expect(row.first().getByTestId('problem-row-fix-ai')).toHaveCount(0);
  const card = row.first().getByTestId('problem-card');
  await card.getByTestId('problem-fix-ai').click();

  await expect(zone().getByTestId('inline-edit-fix')).toContainText('请 AI 修复');
  await expect(zone().getByTestId('inline-edit-target')).toContainText('script.js 第 1–4 行');
  await expect(zone()).toHaveAttribute('data-phase', 'review', { timeout: 30_000 });
  const diff = zone().getByTestId('inline-edit-diff');
  await expect(diff.locator('[data-kind="removed"]')).toContainText('console.log(userNmae);');
  await expect(diff.locator('[data-kind="added"]')).toContainText('console.log(userName);');
  expect(await disk('script.js')).toBe(SCRIPT);
  await zone().getByTestId('inline-edit-accept').click();
  await expect.poll(() => disk('script.js')).toBe(FIXED);

  // The save refreshes the preview (S10.5); resolved only once a newer page load did not report it again.
  const fixCard = page.getByTestId('ai-fix-card');
  await expect(fixCard.getByTestId('ai-fix-status')).toHaveText(
    '已解决：script.js 第 3 行，重新检查和刷新预览后都没有再出现。',
    { timeout: 30_000 },
  );
  await expect(fixCard).toHaveAttribute('data-phase', 'resolved');
  await switchLanguage(page);
  await expect(fixCard.getByTestId('ai-fix-status')).toHaveText(
    'Resolved: script.js line 3 — not reported again after checking again and refreshing the preview.',
  );
  await switchLanguage(page);
});

test('IME text stays intact and candidate keys do not send or close the inline editor', async () => {
  await openFile(page, 'index.html');
  await selectLine(3);
  await page.keyboard.press(`${mod}+i`);
  const input = zone().getByTestId('inline-edit-input');
  await expect(input).toBeFocused();
  // Check immediately within input dispatch: a cross-root controlled field rolls back before its parent effect.
  const immediate = await input.evaluate((element) => {
    const field = element as HTMLTextAreaElement;
    field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(field, '把标题改成蓝色');
    field.setSelectionRange(2, 2);
    field.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: '蓝色', inputType: 'insertCompositionText', isComposing: true }),
    );
    return { value: field.value, caret: field.selectionStart };
  });
  expect(immediate).toEqual({ value: '把标题改成蓝色', caret: 2 });
  for (const key of ['Enter', 'Escape']) {
    await input.dispatchEvent('keydown', { key, isComposing: true });
    await expect(zone()).toHaveAttribute('data-phase', 'instruction');
  }
  await input.dispatchEvent('compositionend', { data: '蓝色' });
  for (const key of ['Enter', 'Escape']) {
    await input.dispatchEvent('keydown', { key, keyCode: 229, isComposing: false });
    await expect(zone()).toHaveAttribute('data-phase', 'instruction');
  }
  // S48.3: WebKit (macOS) ends the composition before the confirming keydown, which then has isComposing false and a
  // real key code. With the engine reported as WebKit, the Enter and Escape right after compositionend stay the IME's;
  // the Escape is stopped at the window, before any panel or dialog listener sees it.
  await page.evaluate(() => {
    const w = window as unknown as { realVendor?: PropertyDescriptor | undefined };
    w.realVendor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'vendor');
    Object.defineProperty(Navigator.prototype, 'vendor', { configurable: true, get: () => 'Apple Computer, Inc.' });
    const seen: string[] = [];
    (window as unknown as { escapesSeen: string[] }).escapesSeen = seen;
    document.addEventListener('keydown', (e) => e.key === 'Escape' && seen.push('document'), true);
  });
  for (const [key, keyCode] of [
    ['Enter', 13],
    ['Escape', 27],
  ] as const) {
    await input.dispatchEvent('compositionend', { data: '蓝色' });
    await input.dispatchEvent('keydown', { key, keyCode, isComposing: false });
    await expect(zone()).toHaveAttribute('data-phase', 'instruction');
  }
  expect(await page.evaluate(() => (window as unknown as { escapesSeen: string[] }).escapesSeen)).toEqual([]);
  await page.evaluate(() => {
    // Back to the engine's own (Chromium) vendor.
    const real = (window as unknown as { realVendor?: PropertyDescriptor | undefined }).realVendor;
    if (real) Object.defineProperty(Navigator.prototype, 'vendor', real);
  });
  await expect(input).toHaveValue('把标题改成蓝色');
  expect(await input.evaluate((field) => (field as HTMLTextAreaElement).selectionStart)).toBe(2);
  await input.press('End');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('把标题改成蓝色\n');
  // On Chromium (Windows) an Enter right after compositionend is the user's: it sends.
  await input.dispatchEvent('compositionend', { data: '' });
  await input.press('Enter');
  await expect(zone()).toHaveAttribute('data-phase', 'review');
  // The review takes focus as it appears (layout effect), so this Escape is the panel's.
  await expect(zone().getByTestId('inline-edit-accept')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(zone()).toHaveCount(0);
});

test('no console errors during the AI edit run', () => {
  expect(consoleErrors).toEqual([]);
});
