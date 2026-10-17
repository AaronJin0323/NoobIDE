import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { collectConsoleErrors, focusEditor, makeProject, openFile, openProject } from './project';
import { DOC_START } from './keys';

/**
 * S48.5 chat code blocks against the scripted fake provider (decision 0025): the caption, file name, gutter and
 * colours from the bundled Monaco tokenizer (offline: the app runs without network), and Copy / Insert at cursor /
 * Replace selection from the keyboard, going through the editor's ordinary edit path (undo, save state, save).
 */
const CODE = "const greeting = 'hi';\nconsole.log(greeting);";
const FAKE_SCRIPT = JSON.stringify({
  includeBuiltin: true,
  turns: [
    {
      match: '[[code]]',
      repeat: true,
      steps: [{ type: 'text', text: `可以这样写：\n\n\`\`\`JS script.js\n${CODE}\n\`\`\`\n` }],
    },
  ],
});
const ORIGINAL = `// 点按钮时打个招呼\nconst userName = '林小雨';\n`;

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const panel = () => page.getByTestId('region-ai');
const input = () => panel().getByTestId('ai-input');
const block = () => panel().getByTestId('ai-turn').last().getByTestId('md-code').first();
const status = () => page.getByTestId('save-status');
const onDisk = () => readFile(path.join(root, 'script.js'), 'utf8');
/** The editor model's text, read through Monaco's own view of the document (no clipboard, no scrolling). */
const editorText = () =>
  page.evaluate(() => {
    const lines = [...document.querySelectorAll('.monaco-editor .view-lines .view-line')] as HTMLElement[];
    return lines
      .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
      .map((line) => (line.textContent ?? '').replaceAll(String.fromCharCode(0xa0), ' '))
      .join('\n');
  });
/** Activates a control from the keyboard: focus it, then Enter. */
async function press(testId: string) {
  const control = block().getByTestId(testId);
  await control.focus();
  await expect(control).toBeFocused();
  await page.keyboard.press('Enter');
}

test.describe('AI chat code blocks (S48.5)', () => {
  test.beforeAll(async () => {
    ({ tmp, root } = await makeProject('noobide-e2e-AI-代码块-'));
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

  test('a code block shows a lowercase caption, its file, a gutter and Monaco colours', async () => {
    await input().fill('写一段代码 [[code]]');
    await input().press('Enter');
    await panel().getByTestId('ai-consent-allow').click();
    await expect(panel().getByTestId('ai-turn').last()).toHaveAttribute('data-status', 'done', { timeout: 30_000 });

    await expect(block().locator('.md-code-lang')).toHaveText('js');
    await expect(block().getByTestId('md-code-file')).toContainText('script.js');
    await expect(block().locator('.md-code-gutter')).toHaveText('1\n2');
    expect(
      await block()
        .locator('.md-code-gutter')
        .evaluate((el) => getComputedStyle(el).fontVariantNumeric),
    ).toBe('tabular-nums');
    const pre = block().locator('pre');
    expect(await pre.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre');
    // The bundled tokenizer coloured it (no network): a keyword and a string, in different colours.
    const keyword = block().locator('[data-token^="keyword"]').first();
    const string = block().locator('[data-token^="string"]').first();
    await expect(keyword).toHaveText('const');
    await expect(string).toContainText("'hi'");
    const colour = (el: HTMLElement) => getComputedStyle(el).color;
    expect(await keyword.evaluate(colour)).not.toBe(await string.evaluate(colour));
    // The code's text is exactly the code.
    expect(await pre.locator('code').textContent()).toBe(CODE);
  });

  test('Copy, Insert at cursor and Replace selection are reachable with Tab and named', async () => {
    const copy = block().getByTestId('md-copy');
    await copy.focus();
    await page.keyboard.press('Tab');
    await expect(block().getByTestId('md-insert')).toBeFocused();
    await expect(block().getByTestId('md-insert')).toHaveAccessibleName('插入到光标处');
    await page.keyboard.press('Tab');
    await expect(block().getByTestId('md-replace')).toBeFocused();
    await expect(block().getByTestId('md-replace')).toHaveAccessibleName('替换选中内容');
    await expect(copy).toHaveAccessibleName('复制代码');
  });

  test('without an open file the actions say to open one first and change nothing', async () => {
    test.skip((await page.getByTestId('tab').count()) > 0, 'a file opened with the project');
    await expect(block().getByTestId('md-insert')).toHaveAttribute('aria-disabled', 'true');
    await press('md-insert');
    await expect(block().getByTestId('md-code-note')).toHaveText('先在编辑器里打开一个文件，再把代码放进去。');
  });

  test('Insert at cursor is one undoable edit that the save state and Save see', async () => {
    await openFile(page, 'script.js');
    await expect(block().getByTestId('md-insert')).not.toHaveAttribute('aria-disabled', 'true');
    await focusEditor(page);
    await page.keyboard.press(DOC_START);
    await press('md-insert');
    await expect(block().getByTestId('md-code-note')).toHaveText('已插入到编辑器。用“撤销”可以还原。');
    await expect.poll(editorText).toContain(`${CODE}// 点按钮时打个招呼`);
    await expect(status()).toHaveAttribute('data-state', 'dirty');
    // The focus is in the editor: one Undo takes the whole insertion back, Redo brings it again.
    await page.keyboard.press('ControlOrMeta+Z');
    await expect.poll(editorText).toContain(ORIGINAL.split('\n')[0] ?? '');
    expect(await editorText()).not.toContain('greeting');
    await page.keyboard.press('ControlOrMeta+Shift+Z');
    await expect.poll(editorText).toContain(`${CODE}// 点按钮时打个招呼`);
    await page.keyboard.press('ControlOrMeta+S');
    await expect.poll(onDisk).toContain(`${CODE}// 点按钮时打个招呼`);
    await expect(status()).toHaveAttribute('data-state', /saved|clean/);
  });

  test('Replace selection needs a selection, then replaces exactly it as one undo step', async () => {
    await focusEditor(page);
    await page.keyboard.press(DOC_START);
    await press('md-replace');
    await expect(block().getByTestId('md-code-note')).toHaveText('先在编辑器里选中要替换的代码。');
    await expect(status()).toHaveAttribute('data-state', /saved|clean/);

    await focusEditor(page);
    await page.keyboard.press('ControlOrMeta+A');
    await press('md-replace');
    await expect(block().getByTestId('md-code-note')).toHaveText('已替换选中的代码。用“撤销”可以还原。');
    await expect.poll(editorText).toBe(CODE);
    await expect(status()).toHaveAttribute('data-state', 'dirty');
    await page.keyboard.press('ControlOrMeta+Z');
    await expect.poll(editorText).toContain('林小雨');
    await page.keyboard.press('ControlOrMeta+S');
    await expect.poll(onDisk).toContain('林小雨');
    expect(consoleErrors).toEqual([]);
  });
});
