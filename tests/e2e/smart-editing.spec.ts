import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import {
  answerFolderDialog,
  collectConsoleErrors,
  focusEditor,
  makeProject,
  openFile,
  openProject,
  tabOf,
  treeRow,
} from './project';
import { DOC_END, DOC_START } from './keys';

/**
 * S43 (decision 0032): detected indentation drives Enter, auto-close, paste and format; the status bar shows it and
 * overrides it; new files follow the project; completions suggest the project's ids, classes and files in context,
 * within the latency budget; language-service suggestions never carry the AI badge. One app, one project with a
 * Chinese path and spaces (tests/fixtures/中文 路径 项目 plus the files below), then a second project with no evidence.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

const TABS_JS = [
  'function showCount(count) {',
  '\tconst box = document.querySelector("#count");',
  '\tif (count > 0) {',
  '\t\tbox.textContent = count;',
  '\t} else {',
  '\t\tbox.textContent = "零";',
  '\t}',
  '\treturn box;',
  '}',
  '',
].join('\n');

const FOUR_JS = [
  'function greet(name) {',
  '    const text = `你好 ${name}`;',
  '    if (name) {',
  '        console.log(text);',
  '        return text;',
  '    }',
  '    return "";',
  '}',
  '',
].join('\n');

const FOUR_CSS = [
  '.card {',
  '    padding: 16px;',
  '    border: 1px solid #ccc;',
  '}',
  '.price-tag {',
  '    color: #e33;',
  '    font-weight: bold;',
  '}',
  '#hero {',
  '    margin: 0;',
  '}',
  '',
].join('\n');

const FOUR_HTML = [
  '<section class="card">',
  '    <div id="product-title" class="price-tag">',
  '        <h2>标题</h2>',
  '        <ul>',
  '            <li>一</li>',
  '            <li>二</li>',
  '        </ul>',
  '    </div>',
  '</section>',
  '',
].join('\n');

const TWO_JS = [
  'function add(a, b) {',
  '  const sum = a + b;',
  '  if (sum) {',
  '    console.log(sum);',
  '    return sum;',
  '  }',
  '  return 0;',
  '}',
  '',
].join('\n');

const onDisk = (rel: string) => readFile(path.join(root, ...rel.split('/')), 'utf8');
const indentStatus = () => page.getByTestId('indent-status');
const lastPasteOutcome = () =>
  page.evaluate(() =>
    (window as unknown as { __noobideSmartEditTestHooks: { pasteOutcomes(): string[] } }).__noobideSmartEditTestHooks
      .pasteOutcomes()
      .at(-1),
  );
const rows = () => page.locator('.suggest-widget .monaco-list-row .label-name');

/** Opens another project while one is open (the welcome screen's button is gone by then). */
async function switchProject(folder: string): Promise<void> {
  await answerFolderDialog(app, folder);
  await page.getByTestId('open-other-folder').click();
  await expect(page.getByTestId('project-name')).toHaveText(path.basename(folder));
}

async function save(): Promise<void> {
  await page.keyboard.press('ControlOrMeta+S');
}

/** Opens the suggest widget at the cursor and returns its labels once `want` is among them. */
async function suggestions(want: string, timeout = 30_000): Promise<string[]> {
  let labels: string[] = [];
  await expect
    .poll(
      async () => {
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+Space');
        await rows()
          .first()
          .waitFor({ timeout: 2_000 })
          .catch(() => undefined);
        labels = await rows().allTextContents();
        return labels.includes(want);
      },
      { timeout, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  return labels;
}

/**
 * A fresh last line of the shown file with `typed` on it. Typed at 30 ms per key like a fast typist: with 0 ms between
 * synthetic key events Monaco can skip auto-closing a brace typed right after the previous key.
 */
async function typeOnNewLine(typed: string): Promise<void> {
  await focusEditor(page);
  await page.keyboard.press(DOC_END);
  await page.keyboard.press('Enter');
  await page.keyboard.type(typed, { delay: 30 });
}

/** Puts the file back as it was (a paste: typed text would be auto-indented line by line). */
async function clearAfter(original: string, rel: string): Promise<void> {
  await page.keyboard.press('Escape');
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), original);
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+V');
  await save();
  await expect.poll(() => onDisk(rel)).toBe(original);
}

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-smart-'));
  await writeFile(path.join(root, 'tabs.js'), TABS_JS);
  await writeFile(path.join(root, 'two.js'), TWO_JS);
  await mkdir(path.join(root, 'shop'), { recursive: true });
  await writeFile(path.join(root, 'shop', 'four.js'), FOUR_JS);
  await writeFile(path.join(root, 'shop', 'four.css'), FOUR_CSS);
  await writeFile(path.join(root, 'shop', 'product.html'), FOUR_HTML);
  await writeFile(path.join(root, 'shop', 'more.css'), FOUR_CSS.replace(/card/g, 'banner'));
  await writeFile(path.join(root, 'shop', 'util.mjs'), 'export const price = 3;\n');
  await mkdir(path.join(root, 'images'), { recursive: true });
  await writeFile(path.join(root, 'images', '猫 照片.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
});

test.afterAll(async () => {
  await app?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

test('a tab-indented file is detected; Enter and auto-close indent with a tab (S43.1, S43.2)', async () => {
  await openFile(page, 'tabs.js');
  await expect(indentStatus()).toHaveAttribute('data-insert-spaces', 'false');
  await expect(indentStatus()).toHaveAttribute('data-source', 'detected');
  await expect(indentStatus()).toContainText('Tab 宽度：4');
  await expect(indentStatus()).toContainText('从文件识别');
  await typeOnNewLine('if (ok) {');
  await page.keyboard.press('Enter');
  await page.keyboard.type('go();');
  await save();
  // Monaco auto-closed the brace; the new line inside it got one tab, the closing brace none.
  await expect.poll(() => onDisk('tabs.js')).toBe(`${TABS_JS}\nif (ok) {\n\tgo();\n}`);
  await clearAfter(TABS_JS, 'tabs.js');
});

test('a 4-space file indents with four spaces; Format keeps four (S43.2)', async () => {
  await openFile(page, 'shop/four.js');
  await expect(indentStatus()).toHaveAttribute('data-insert-spaces', 'true');
  await expect(indentStatus()).toHaveAttribute('data-tab-size', '4');
  await expect(indentStatus()).toContainText('空格：4');
  await typeOnNewLine('function more() {');
  await page.keyboard.press('Enter');
  await page.keyboard.type('return 1;');
  await save();
  await expect.poll(() => onDisk('shop/four.js')).toBe(`${FOUR_JS}\nfunction more() {\n    return 1;\n}`);
  await clearAfter(FOUR_JS, 'shop/four.js');

  await openFile(page, 'shop/four.css');
  await expect(indentStatus()).toHaveAttribute('data-tab-size', '4');
  await typeOnNewLine('h2{color:red;margin:0}');
  await page.keyboard.press('Shift+Alt+F');
  await save();
  // The formatter also puts blank lines between rules; what matters here is that it indents with four spaces.
  await expect.poll(() => onDisk('shop/four.css')).toContain('h2 {\n    color: red;\n    margin: 0\n}');
  const leads = (await onDisk('shop/four.css')).match(/^[ \t]+(?=\S)/gm) ?? [];
  expect(leads.length).toBeGreaterThan(5);
  expect(leads.every((lead) => lead === '    ')).toBe(true);
  await clearAfter(FOUR_CSS, 'shop/four.css');
});

test('pasting tab-indented code into a 2-space file re-indents it; Ctrl+Z restores the paste (S43.2)', async () => {
  await openFile(page, 'two.js');
  await expect(indentStatus()).toHaveAttribute('data-tab-size', '2');
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), 'if (a) {\n\tif (b) {\n\t\tgo();\n\t}\n}');
  await focusEditor(page);
  await page.keyboard.press(DOC_END);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+V');
  await expect.poll(lastPasteOutcome).toBe('reindented');
  await save();
  await expect.poll(() => onDisk('two.js')).toBe(`${TWO_JS}\nif (a) {\n  if (b) {\n    go();\n  }\n}`);
  await page.keyboard.press('ControlOrMeta+Z');
  await save();
  await expect.poll(() => onDisk('two.js')).toBe(`${TWO_JS}\nif (a) {\n\tif (b) {\n\t\tgo();\n\t}\n}`);
  await clearAfter(TWO_JS, 'two.js');
});

test('a whole-line paste (copied with nothing selected) never re-indents the line under the cursor (S43.2)', async () => {
  await openFile(page, 'two.js');
  await focusEditor(page);
  // Line 4 is "    console.log(sum);"; copy it with nothing selected, paste with the cursor in the middle of it.
  await page.keyboard.press(DOC_START); // ⌘↑ on macOS: Monaco does not bind ⌘Home
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ControlOrMeta+C');
  await page.keyboard.press('ControlOrMeta+V');
  await save();
  await expect
    .poll(() => onDisk('two.js'))
    .toBe(TWO_JS.replace('    console.log(sum);\n', '    console.log(sum);\n    console.log(sum);\n'));
  await clearAfter(TWO_JS, 'two.js');
});

test('converting a 4-space file to Spaces 2 changes every level (S43.2)', async () => {
  await openFile(page, 'shop/four.js');
  await indentStatus().click();
  const menu = page.getByRole('menu', { name: '缩进方式' });
  await menu.getByRole('menuitem', { name: '使用空格，宽度 2' }).click();
  await indentStatus().click();
  await menu.getByRole('menuitem', { name: '把整个文件改成当前缩进' }).click();
  await save();
  await expect.poll(() => onDisk('shop/four.js')).toBe(FOUR_JS.replace(/^( {4})+/gm, (m) => '  '.repeat(m.length / 4)));
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+Z');
  await save();
  await expect.poll(() => onDisk('shop/four.js')).toBe(FOUR_JS);
  await indentStatus().click();
  await menu.getByRole('menuitem', { name: '重新自动识别' }).click();
  await expect(indentStatus()).toHaveAttribute('data-tab-size', '4');
});

test('the status bar menu overrides, converts and detects again, from the keyboard (S43.2)', async () => {
  await openFile(page, 'two.js');
  await indentStatus().focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: '缩进方式' });
  await expect(menu).toBeVisible();
  // Spaces 2, Spaces 4, Tabs 2 ← two steps down.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: '使用 Tab，显示宽度 2' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(indentStatus()).toHaveAttribute('data-source', 'override');
  await expect(indentStatus()).toHaveAttribute('data-insert-spaces', 'false');
  await expect(indentStatus()).toContainText('你的选择');
  // The override survives a tab switch.
  await openFile(page, 'tabs.js');
  await expect(indentStatus()).toHaveAttribute('data-source', 'detected');
  await page
    .getByRole('tab', { name: /two\.js/ })
    .first()
    .click();
  await expect(tabOf(page, 'two.js')).toHaveAttribute('aria-selected', 'true');
  await expect(indentStatus()).toHaveAttribute('data-source', 'override');
  // Convert the file to tabs: one undoable edit.
  await indentStatus().click();
  await menu.getByRole('menuitem', { name: '把整个文件改成当前缩进' }).click();
  await save();
  await expect.poll(() => onDisk('two.js')).toBe(TWO_JS.replace(/^( {2})+/gm, (m) => '\t'.repeat(m.length / 2)));
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+Z');
  await save();
  await expect.poll(() => onDisk('two.js')).toBe(TWO_JS);
  // Detect again drops the override.
  await indentStatus().click();
  await menu.getByRole('menuitem', { name: '重新自动识别' }).click();
  await expect(indentStatus()).toHaveAttribute('data-source', 'detected');
  await expect(indentStatus()).toHaveAttribute('data-insert-spaces', 'true');
});

test('JavaScript selector strings suggest the project ids and classes (S43.5)', async () => {
  await openFile(page, 'script.js');
  await typeOnNewLine("document.querySelector('#");
  let labels = await suggestions('product-title');
  expect(labels).toEqual(expect.arrayContaining(['hi', 'hero', 'product-title']));
  // The item names the file that defines it, and no AI badge or ghost text is involved.
  await expect(page.locator('.suggest-widget .monaco-list-row', { hasText: 'product-title' }).first()).toContainText(
    'shop/product.html',
  );
  await expect(page.getByTestId('ai-ghost-badge')).toHaveCount(0);
  await expect(page.locator('.monaco-editor .ghost-text-decoration, .monaco-editor .ghost-text')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('End');
  await page.keyboard.type(').classList.add(');
  await page.keyboard.type("'");
  labels = await suggestions('price-tag');
  expect(labels).toEqual(expect.arrayContaining(['card', 'banner', 'price-tag']));
  await page.keyboard.press('Escape');
  await typeOnNewLine("document.getElementById('");
  labels = await suggestions('hero');
  expect(labels).toContain('hi');
  await page.keyboard.press('Escape');
});

test('CSS selectors suggest ids and classes from the HTML (S43.5)', async () => {
  await openFile(page, 'style.css');
  await typeOnNewLine('.');
  const labels = await suggestions('price-tag');
  expect(labels).toContain('card');
  await page.keyboard.press('Escape');
  await typeOnNewLine('#');
  expect(await suggestions('#product-title')).toContain('#hi');
  await page.keyboard.press('Escape');
});

test('src, href and import suggest project files relative to the current file (S43.5)', async () => {
  await openFile(page, '子 文件夹/页面 二.html');
  await typeOnNewLine('<img src="../');
  await suggestions('images/');
  await page.keyboard.press('Escape');
  await page.keyboard.type('images/');
  let labels = await suggestions('猫 照片.png');
  expect(labels).not.toContain('页面 二.html');
  await page.keyboard.press('Escape');
  await typeOnNewLine('<link rel="stylesheet" href="../');
  labels = await suggestions('style.css');
  expect(labels).not.toContain('script.js');
  await page.keyboard.press('Escape');

  await openFile(page, 'shop/four.js');
  await typeOnNewLine("import { price } from '");
  labels = await suggestions('util.mjs');
  expect(labels).not.toContain('four.css');
  await page.keyboard.press('Escape');
});

test('a beginner snippet inserts a click listener on a real project element (S43.5)', async () => {
  await openFile(page, 'two.js');
  await typeOnNewLine('click');
  await suggestions('click');
  const row = page.locator('.suggest-widget .monaco-list-row', { hasText: '点击元素时运行代码' }).first();
  await expect(row).toContainText('NoobIDE 片段');
  await row.click();
  await page.keyboard.press('Escape'); // leave the choice list on its first id
  await save();
  await expect
    .poll(() => onDisk('two.js'))
    .toMatch(/document\.querySelector\('#[\w-]+'\)\.addEventListener\('click', \(\) => \{\n {2}\n\}\);$/);
});

test('latency: a project id is listed within 500 ms of typing the trigger (S43.6)', async () => {
  await openFile(page, 'script.js');
  const samples: number[] = [];
  for (let i = 0; i < 7; i += 1) {
    await typeOnNewLine("document.querySelector('");
    const started = Date.now();
    await page.keyboard.type('#');
    await rows()
      .filter({ hasText: /^product-title$/ })
      .first()
      .waitFor({ timeout: 10_000 });
    samples.push(Date.now() - started);
    await page.keyboard.press('Escape');
  }
  const provider = await page.evaluate(() =>
    (
      window as unknown as { __noobideSmartEditTestHooks: { completionTimings(): number[] } }
    ).__noobideSmartEditTestHooks.completionTimings(),
  );
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? Infinity;
  const providerSorted = [...provider].sort((a, b) => a - b);
  const p95 = providerSorted[Math.floor(providerSorted.length * 0.95)] ?? Infinity;
  test.info().annotations.push({
    type: 'latency',
    description: JSON.stringify({ visibleMs: samples, medianVisibleMs: median, providerP95Ms: Number(p95.toFixed(2)) }),
  });
  console.log(
    `[S43.6] trigger→visible ms ${JSON.stringify(samples)} median ${median}; provider p95 ${p95.toFixed(2)} ms over ${provider.length}`,
  );
  expect(median).toBeLessThanOrEqual(500);
  expect(p95).toBeLessThanOrEqual(10);
});

test('a new empty file follows the project convention (S43.3)', async () => {
  // A project whose confident files all use 4 spaces (the first project mixes 2 and 4: no convention there).
  const four = path.join(tmp, '四 空格 项目');
  await mkdir(four, { recursive: true });
  await writeFile(path.join(four, 'index.html'), FOUR_HTML);
  await writeFile(path.join(four, 'style.css'), FOUR_CSS);
  await writeFile(path.join(four, 'app.js'), FOUR_JS);
  await switchProject(four);
  await writeFile(path.join(four, 'new.js'), '');
  await expect(treeRow(page, 'new.js')).toBeVisible({ timeout: 15_000 });
  await openFile(page, 'new.js');
  await expect(indentStatus()).toHaveAttribute('data-source', 'project');
  await expect(indentStatus()).toHaveAttribute('data-tab-size', '4');
  await expect(indentStatus()).toContainText('沿用项目习惯');
  await focusEditor(page);
  await page.keyboard.type('if (x) {', { delay: 30 });
  await page.keyboard.press('Enter');
  await page.keyboard.type('y();', { delay: 30 });
  await save();
  await expect.poll(() => readFile(path.join(four, 'new.js'), 'utf8')).toBe('if (x) {\n    y();\n}');
});

test('a project with no indentation evidence uses the template default (S43.3)', async () => {
  const empty = path.join(tmp, '空 项目');
  await mkdir(empty, { recursive: true });
  await writeFile(path.join(empty, 'index.html'), '');
  await switchProject(empty);
  await openFile(page, 'index.html');
  await expect(indentStatus()).toHaveAttribute('data-source', 'default');
  await expect(indentStatus()).toHaveAttribute('data-tab-size', '2');
  await expect(indentStatus()).toContainText('模板默认');
  expect(consoleErrors).toEqual([]);
});
