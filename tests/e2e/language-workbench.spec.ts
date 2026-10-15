import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { collectConsoleErrors, editorOption, makeProject, openFile, openProject, tabOf } from './project';
import { DOC_END } from './keys';

/**
 * Language features in the workbench (S18.3 formatting, S18.4 multi-file JS + worker recovery). One app, one
 * project with a Chinese path and spaces (tests/fixtures/中文 路径 项目, copied to a temp folder).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;
let consoleErrors: string[];

interface Marker {
  resource: string;
  code?: string;
  message: string;
  line: number;
}
interface EditorTestHooks {
  preFormat: { uri: string; languageId: string }[];
  killWorkers(kind: string): number;
  restartCount(): number;
  markers(): Marker[];
}
type HookWindow = { __noobideEditorTestHooks: EditorTestHooks };
const preFormat = () => page.evaluate(() => (window as unknown as HookWindow).__noobideEditorTestHooks.preFormat);
const markersOf = (file: string) =>
  page.evaluate(
    (f) => (window as unknown as HookWindow).__noobideEditorTestHooks.markers().filter((m) => m.resource.endsWith(f)),
    file,
  );
const restartCount = () =>
  page.evaluate(() => (window as unknown as HookWindow).__noobideEditorTestHooks.restartCount());
const killWorkers = (kind: string) =>
  page.evaluate((k) => (window as unknown as HookWindow).__noobideEditorTestHooks.killWorkers(k), kind);

/** Opens the suggest widget at the cursor and returns the labels it offers (polls until `want` shows up). */
async function suggestions(want: string, timeout = 30_000): Promise<string[]> {
  let labels: string[] = [];
  await expect
    .poll(
      async () => {
        // Escape first: a request that went to a dead worker leaves the widget "loading" until it is closed.
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+Space');
        const rows = page.locator('.suggest-widget .monaco-list-row .label-name');
        await rows
          .first()
          .waitFor({ timeout: 2_000 })
          .catch(() => undefined);
        labels = await rows.allTextContents();
        return labels.includes(want);
      },
      { timeout, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  await page.keyboard.press('Escape');
  return labels;
}

const onDisk = (rel: string) => readFile(path.join(root, ...rel.split('/')), 'utf8');

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-e2e-lang-'));
  await writeFile(path.join(root, 'style.css'), 'h1{color:red;margin:0}\n');
  await writeFile(path.join(root, 'script.js'), 'function add(a,b){\nreturn a+b\n}\n');
  // S18.4: an ES module importing a file that stays closed, and two classic scripts sharing a global.
  await mkdir(path.join(root, 'js'), { recursive: true });
  await writeFile(path.join(root, 'js', 'util.mjs'), 'export function greet(name) {\n  return `Hi ${name}`;\n}\n');
  await writeFile(path.join(root, 'js', 'main.js'), "import * as util from './util.mjs';\n\nutil.gr\n");
  await writeFile(path.join(root, 'js', 'config.js'), "const appTitle = '我的主页';\n");
  await writeFile(path.join(root, 'js', 'app.js'), 'console.log(appTitle);\nconsole.log(apTitle);\n');
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

test('Format button formats CSS, saves it, and fires the pre-format hook first (S18.3)', async () => {
  await openFile(page, 'style.css');
  const before = (await preFormat())?.length ?? 0;
  const button = await editorOption(page, 'format-document');
  await expect(button).toHaveText('整理格式');
  await expect(button).toHaveAttribute('title', process.platform === 'darwin' ? /⇧⌥F/ : /Shift\+Alt\+F/);
  await button.click();
  await expect.poll(() => onDisk('style.css')).toBe('h1 {\n  color: red;\n  margin: 0\n}');
  const events = (await preFormat()) ?? [];
  expect(events.length).toBe(before + 1);
  expect(events.at(-1)).toMatchObject({ languageId: 'css' });
  expect(decodeURIComponent(events.at(-1)?.uri ?? '')).toContain('中文 路径 项目/style.css');
  // Formatting is a normal edit: Ctrl/Cmd+Z brings the original text back (and autosave writes it).
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+Z');
  await expect.poll(() => onDisk('style.css')).toBe('h1{color:red;margin:0}\n');
});

test('Shift+Alt+F formats JavaScript and fires the hook (S18.3)', async () => {
  await openFile(page, 'script.js');
  await expect(tabOf(page, 'script.js')).toHaveAttribute('aria-selected', 'true');
  const before = (await preFormat())?.length ?? 0;
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Shift+Alt+F');
  await expect.poll(() => onDisk('script.js')).toBe('function add(a, b) {\n  return a + b\n}\n');
  const events = (await preFormat()) ?? [];
  expect(events.length).toBe(before + 1);
  expect(events.at(-1)).toMatchObject({ languageId: 'javascript' });
});

test('relative ES module import of a closed file resolves for completion (S18.4)', async () => {
  await openFile(page, 'js/main.js');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press(DOC_END);
  await page.keyboard.press('ArrowUp'); // end of `util.gr`
  await page.keyboard.press('End');
  const labels = await suggestions('greet');
  expect(labels).toContain('greet');
});

test('a global from another (closed) script is known; a misspelling of it is still reported (S18.4)', async () => {
  await openFile(page, 'js/app.js');
  await expect
    .poll(async () => (await markersOf('js/app.js')).map((m) => `${m.line}:${m.code}`), { timeout: 30_000 })
    .toEqual(['2:2552']);
  const [marker] = await markersOf('js/app.js');
  expect(marker?.message).toContain("'apTitle'");
  expect(marker?.message).toContain("'appTitle'");
});

test('a killed language worker is restarted and the editor stays usable (S18.4)', async () => {
  test.setTimeout(120_000);
  await openFile(page, 'script.js');
  const restartsBefore = await restartCount();
  expect(await killWorkers('ts')).toBeGreaterThan(0);
  // Typing is never blocked by the dead worker: the text shows up at once.
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press(DOC_END);
  await page.keyboard.press('Enter');
  await page.keyboard.type('const heading = docu');
  await expect(page.locator('.view-lines')).toContainText('const heading = docu');
  // The supervisor notices the unanswered request, replaces the worker, and completion works again.
  await suggestions('document', 60_000);
  expect(await restartCount()).toBeGreaterThan(restartsBefore);
  // Diagnostics come back too: an undefined name in the edited file is reported by the new worker.
  await page.keyboard.press(DOC_END);
  await page.keyboard.press('Enter');
  await page.keyboard.type('console.log(userNmae);');
  await expect
    .poll(async () => (await markersOf('script.js')).map((m) => m.code), { timeout: 30_000 })
    .toContain('2304');
});

test('no console errors during the language run', () => {
  expect(consoleErrors).toEqual([]);
});
