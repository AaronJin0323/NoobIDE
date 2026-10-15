import { rm } from 'node:fs/promises';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { Annotation, AnnotationCandidates, AnnotationPick } from '../../src/shared/ipc/annotations-contract';
import { launchApp } from './launch';
import { copyFixture, evalInPreview, openProject, previewInfo, waitForPreviewState } from './preview-helpers';
import { collectConsoleErrors } from './project';

/**
 * S41 (decision 0030): preview annotations in the real app. The project path has Chinese characters and spaces.
 * Part 1 drives main through the workbench's own bridge (`window.noobide.annotations`) and the preview through
 * native input events, to prove the picking mechanics and isolation (S41.3/S41.4).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp = '';
let root = '';
let projectId = '';
let consoleErrors: string[];
/** DOM changes the page saw while loading (the parser adds text after the script); nothing may add to it. */
let baseline = 0;

type Res<T> = { ok: true; value: T } | { ok: false; code: string };

/** Calls the annotations bridge from the workbench (as the strip does). */
function bridge<T>(method: string, request: unknown): Promise<Res<T>> {
  return page.evaluate(
    ([m, r]) =>
      (window.noobide as unknown as { annotations: Record<string, (x: unknown) => Promise<unknown>> }).annotations[
        m as string
      ]!(r) as Promise<Res<unknown>>,
    [method, request] as const,
  ) as Promise<Res<T>>;
}

/** Where an element of the preview is, in the view's coordinates (test-only read of the page). */
async function centerOf(selector: string): Promise<{ x: number; y: number }> {
  return evalInPreview(
    app,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
  );
}

/** A real mouse click into the preview view (native input, like the user's). */
async function clickPreview(point: { x: number; y: number }): Promise<void> {
  const info = await previewInfo(app);
  await app.evaluate(
    ({ webContents }, { id, x, y }) => {
      const wc = webContents.fromId(id);
      if (!wc) return;
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    },
    { id: info.previewWebContentsId ?? -1, ...point },
  );
}

async function keyInPreview(key: string): Promise<void> {
  const info = await previewInfo(app);
  await app.evaluate(
    ({ webContents }, { id, keyCode }) => {
      const wc = webContents.fromId(id);
      wc?.sendInputEvent({ type: 'keyDown', keyCode });
      wc?.sendInputEvent({ type: 'keyUp', keyCode });
    },
    { id: info.previewWebContentsId ?? -1, keyCode: key },
  );
}

/** The preview's isolation facts (S04.3), as in preview-snapshot.spec.ts. */
async function isolationFacts() {
  const info = await previewInfo(app);
  const globals = await evalInPreview<Record<string, string>>(
    app,
    `({ require: typeof require, process: typeof process, noobide: typeof noobide, ipc: typeof ipcRenderer,
        names: Object.getOwnPropertyNames(window).sort().join(',') })`,
  );
  return {
    webContentsId: info.previewWebContentsId,
    partition: info.partition,
    sandbox: info.webPreferences?.sandbox,
    contextIsolation: info.webPreferences?.contextIsolation,
    nodeIntegration: info.webPreferences?.nodeIntegration,
    preload: info.webPreferences?.preload ?? null,
    globals,
  };
}

const pageCounters = () => evalInPreview<{ clicks: number; mutations: number }>(app, `({ clicks: window.clicks, mutations: window.mutations })`); // prettier-ignore

test.beforeAll(async () => {
  const copy = await copyFixture('预览 标注');
  tmp = copy.tmp;
  root = copy.root;
  app = await launchApp({ NOOBIDE_AI_FAKE: '1' });
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
  await openProject(app, page, root);
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
  projectId = (await previewInfo(app)).status.projectId ?? '';
  // The page's own script ran (it counts clicks and DOM changes); the count settles once the page has loaded.
  await expect.poll(async () => (await pageCounters()).clicks).toBe(0);
  await page.waitForTimeout(500);
  baseline = (await pageCounters()).mutations;
});

test.afterAll(async () => {
  await app?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

test('picking with the mouse: the page does not get the click, isolation is unchanged (S41.3)', async () => {
  const before = await isolationFacts();
  expect(before).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, preload: null });
  expect(before.globals).toMatchObject({ require: 'undefined', process: 'undefined', noobide: 'undefined' });

  const button = await centerOf('#send');
  const picking = bridge<AnnotationPick>('pick', { projectId });
  // Inspect mode is on once main has set it; clicks before that would reach the page, so wait for it.
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __noobideTestHooks: { annotationPicking(): boolean } }).__noobideTestHooks.annotationPicking())).toBe(true); // prettier-ignore
  await clickPreview(button);
  const picked = await picking;
  expect(picked.ok).toBe(true);
  if (!picked.ok) return;
  expect(picked.value.target).toMatchObject({
    kind: 'element',
    tag: 'button',
    id: 'send',
    classes: ['cta'],
    text: '发送',
    selector: 'button#send',
    rules: [{ sheet: { kind: 'file', path: '样式 表.css' }, selector: '.cta', occurrence: 1 }],
  });
  expect(picked.value.source).toEqual({
    state: 'found',
    html: { relPath: 'index.html', startLine: 17, endLine: 17, match: 'exact' },
    css: [{ relPath: '样式 表.css', startLine: 3, endLine: 6, match: 'exact', selector: '.cta' }],
  });
  // The click went to the inspector, not to the page; the page saw no DOM change; nothing new in the page.
  expect(await pageCounters()).toEqual({ clicks: 0, mutations: baseline });
  expect(await isolationFacts()).toEqual(before);
  // After pick mode, clicks reach the page again.
  await clickPreview(button);
  await expect.poll(() => pageCounters()).toEqual({ clicks: 1, mutations: baseline });
});

test('Esc in the page and Cancel end pick mode (S41.3)', async () => {
  const hooks = () => app.evaluate(() => (globalThis as unknown as { __noobideTestHooks: { annotationPicking(): boolean } }).__noobideTestHooks.annotationPicking()); // prettier-ignore
  let picking = bridge<AnnotationPick>('pick', { projectId });
  await expect.poll(hooks).toBe(true);
  await keyInPreview('Escape');
  expect(await picking).toMatchObject({ ok: false, code: 'cancelled' });
  picking = bridge<AnnotationPick>('pick', { projectId });
  await expect.poll(hooks).toBe(true);
  expect(await bridge('cancelPick', { projectId })).toEqual({ ok: true, value: null });
  expect(await picking).toMatchObject({ ok: false, code: 'cancelled' });
  expect(await hooks()).toBe(false);
});

test('keyboard list, script-created elements, regions and highlight (S41.3)', async () => {
  const before = await isolationFacts();
  const list = await bridge<AnnotationCandidates>('candidates', { projectId });
  expect(list.ok).toBe(true);
  if (!list.ok) return;
  const labels = list.value.items.map((i) => i.label);
  expect(labels).toContain('h1 "我的 小店"');
  expect(labels).toContain('button#send "发送"');
  // An element only the script created is listed, and found on the page, but not in the HTML file.
  const orange = list.value.items.find((i) => i.label.startsWith('li "橙子'));
  expect(orange).toBeDefined();
  const resolved = await bridge<AnnotationPick>('resolve', { projectId, how: { kind: 'path', path: orange?.path } });
  expect(resolved).toMatchObject({ ok: true, value: { target: { tag: 'li' }, source: { state: 'not-found', html: null } } }); // prettier-ignore
  // The <h1> is styled by the page's <style> block.
  const h1 = list.value.items.find((i) => i.label.startsWith('h1'));
  const heading = await bridge<AnnotationPick>('resolve', { projectId, how: { kind: 'path', path: h1?.path } });
  expect(heading).toMatchObject({
    ok: true,
    value: {
      source: {
        state: 'found',
        html: { relPath: 'index.html', startLine: 13 },
        css: [{ relPath: 'index.html', startLine: 8, endLine: 8, selector: 'h1' }],
      },
    },
  });
  // A region around the special-offer card resolves to the card.
  const card = await evalInPreview<{ x: number; y: number; width: number; height: number }>(
    app,
    `(() => { const r = document.querySelector('.card').getBoundingClientRect();
       return { x: (r.left + 4) / innerWidth, y: (r.top + 4) / innerHeight, width: (r.width - 8) / innerWidth,
                height: (r.height - 8) / innerHeight }; })()`,
  );
  const region = await bridge<AnnotationPick>('resolve', { projectId, how: { kind: 'region', ...card } });
  expect(region).toMatchObject({
    ok: true,
    value: { target: { kind: 'region', tag: 'section', classes: ['card'] }, source: { state: 'found' } },
  });
  // Show it on the page with the protocol overlay, then hide it.
  if (region.ok) {
    const saved = await bridge<Annotation>('save', { projectId, pickId: region.value.pickId, note: '这块区域太挤了' });
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(await bridge('highlight', { projectId, id: saved.value.id })).toEqual({ ok: true, value: null });
      expect(await bridge('highlight', { projectId, id: null })).toEqual({ ok: true, value: null });
      expect(await bridge('remove', { projectId, id: saved.value.id })).toEqual({ ok: true, value: null });
    }
  }
  expect((await pageCounters()).mutations).toBe(baseline);
  expect(await isolationFacts()).toEqual(before);
});

test('no workbench console errors during part 1', () => {
  expect(consoleErrors).toEqual([]);
});
