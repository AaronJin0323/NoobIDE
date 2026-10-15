import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { partitionForProject } from '../../src/preview/preview-options';
import type { ProblemRecord, ProblemSource } from '../../src/shared/problem';
import { launchApp } from './launch';
import { collectConsoleErrors } from './project';
import { copyFixture, evalInPreview, openProject, previewInfo, waitForPreviewState } from './preview-helpers';

/**
 * S16.2–S16.6 end to end: the runtime capture adapter in main turns what the real sandboxed preview reports into
 * ProblemRecords with project-relative paths, attributes them to page loads, keeps them bounded, and explains
 * errors from other websites. Records are read the way the Problems panel reads them: `window.noobide.problems`.
 * Every project sits under a path with Chinese characters and spaces (copyFixture).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let consoleErrors: string[];
const temps: string[] = [];

interface Snapshot {
  current: { sessionId: string; generation: number } | null;
  records: ProblemRecord[];
  stats: { dropped: Record<ProblemSource, number>; evicted: Record<ProblemSource, number> };
}

/** The list exactly as the workbench gets it over the restricted bridge. */
const listed = () =>
  page.evaluate(async () => {
    const result = await window.noobide?.problems?.list();
    return result?.ok ? [...result.value] : [];
  });
/** Main's snapshot (generation and volume counters) through the read-only test hook. */
const snapshot = () =>
  app.evaluate(() =>
    (globalThis as unknown as { __noobideTestHooks: { problems(): Snapshot } }).__noobideTestHooks.problems(),
  );
const byMessage = (records: readonly ProblemRecord[], text: string) =>
  records.find((r) => r.originalMessage.includes(text));
const byRequest = (records: readonly ProblemRecord[], requestedPath: string) =>
  records.find((r) => r.resource?.requestedPath === requestedPath);

async function project(fixture: string): Promise<string> {
  const { tmp, root } = await copyFixture(fixture);
  temps.push(tmp);
  return root;
}

async function startPreview(root: string): Promise<void> {
  await openProject(app, page, root);
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
}

test.beforeAll(async () => {
  app = await launchApp();
  page = await app.firstWindow();
  consoleErrors = collectConsoleErrors(page);
  await page.locator('.monaco-editor .view-lines').waitFor();
});

test.afterAll(async () => {
  await app?.close();
  for (const tmp of temps) await rm(tmp, { recursive: true, force: true });
});

let runtimeRoot = '';

test('syntax errors, exceptions, rejections, console errors and module failures map to project files (S16.2)', async () => {
  runtimeRoot = await project('预览 运行时');
  await startPreview(runtimeRoot);
  await expect.poll(async () => (await listed()).length, { timeout: 20_000 }).toBe(13); // 8 runtime + console, 5 resource
  const records = await listed();
  const projectId = records[0]?.projectId;
  expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

  expect(byMessage(records, "Unexpected token ';'")).toMatchObject({
    source: 'runtime',
    code: 'SyntaxError',
    file: '脚本/语法 错误.js',
    line: 2,
  });
  expect(byMessage(records, 'Cannot set properties of null')).toMatchObject({
    source: 'runtime',
    code: 'TypeError',
    file: '脚本/同步 异常.js',
    line: 3,
  });
  expect(byMessage(records, '数据加载失败')).toMatchObject({
    source: 'runtime',
    code: 'unhandledrejection',
    file: '脚本/未处理 拒绝.js',
    line: 3,
    originalMessage: 'Uncaught (in promise) Error: 数据加载失败',
  });
  expect(byMessage(records, '显示欢迎')).toMatchObject({
    source: 'runtime',
    code: 'ReferenceError',
    file: 'index.html', // an inline <script>
    line: 21,
  });
  expect(byMessage(records, '自定义错误')).toMatchObject({
    source: 'console',
    severity: 'error',
    file: '脚本/控制台.js',
    line: 2,
  });
  expect(byMessage(records, '自定义警告')).toMatchObject({ source: 'console', severity: 'warning', line: 3 });
  expect(byMessage(records, '普通日志')).toBeUndefined();
  // Module load failures: a missing export (reported in the importing file, with its line), a bare specifier, and a
  // module file that does not exist (the failed request, with the importing module as initiator).
  expect(byMessage(records, "does not provide an export named '相减'")).toMatchObject({
    source: 'runtime',
    code: 'SyntaxError',
    file: '脚本/模块 入口.js',
    line: 2,
  });
  const bare = byMessage(records, 'Failed to resolve module specifier');
  // Chromium reports the bare import against the page with no line: no file is claimed (the explanation names the
  // specifier instead).
  expect(bare).toMatchObject({ source: 'runtime', code: 'TypeError' });
  expect(bare?.file).toBeUndefined();
  expect(byRequest(records, '脚本/不存在 的模块.js')).toMatchObject({
    source: 'resource',
    code: 'resource-failed',
    resource: { status: 404, resourceType: 'script', initiatorFile: '脚本/模块 缺失.js' },
  });
  for (const r of records) {
    expect(r.projectId).toBe(projectId);
    expect(r.preview?.generation).toBe(1);
    expect(r.stale).toBeUndefined();
  }

  // The Problems panel is fed by this list (no longer by its preview-event fallback).
  await page.getByTestId('problems-toggle').click();
  await expect(page.getByTestId('problems-badge-runtime')).toHaveText(
    String(records.filter((r) => r.source !== 'resource').length),
  );
  await expect(page.getByTestId('problems-badge-resource')).toHaveText(
    String(records.filter((r) => r.source === 'resource').length),
  );
  await page.getByTestId('problems-toggle').click();
});

test('resource failures carry the requested path and the initiator file (S16.4)', async () => {
  const records = await listed();
  expect(byRequest(records, '图片/不存在 的图.png')).toMatchObject({
    source: 'resource',
    resource: { status: 404, resourceType: 'image', initiatorFile: 'index.html' },
  });
  expect(byRequest(records, '图片/背景 缺失.png')).toMatchObject({
    resource: { status: 404, resourceType: 'image', initiatorFile: '样式/主 样式.css' },
  });
  expect(byRequest(records, '数据/缺失 的数据.json')).toMatchObject({
    resource: { status: 404, resourceType: 'fetch', initiatorFile: 'index.html' },
  });
  // A network error (the host name never resolves): no status, the Chromium error name, the page as initiator.
  const remote = records.find((r) => r.resource?.requestedUrl.startsWith('https://noobide-e2e.invalid/'));
  expect(remote).toMatchObject({
    source: 'resource',
    resource: { resourceType: 'image', initiatorFile: 'index.html', netError: expect.stringMatching(/^net::ERR_/) },
  });
  expect(remote?.resource?.requestedPath).toBeUndefined();
  expect(remote?.resource?.status).toBeUndefined();
});

test('a refresh starts a new generation; problems that did not happen again are marked stale (S16.3)', async () => {
  const before = await snapshot();
  expect(before.current?.generation).toBe(1);
  // Fix one file outside the editor, then refresh the preview.
  await writeFile(
    path.join(runtimeRoot, '脚本', '同步 异常.js'),
    "// 已修好\nconst box = document.body;\nbox.dataset.ok = '1';\n",
  );
  await page.getByTestId('preview-reload').click();
  await expect.poll(async () => (await snapshot()).current?.generation, { timeout: 20_000 }).toBe(2);
  await waitForPreviewState(page, 'running');
  await expect.poll(async () => byMessage(await listed(), "Unexpected token ';'")?.count, { timeout: 20_000 }).toBe(2);
  const after = await snapshot();
  expect(after.current?.sessionId).toBe(before.current?.sessionId);
  // One counter: problem records are numbered by the preview's own page-load generation (status pill, S14.1), the
  // same number the one-click fix counts loads with (S22.5).
  expect(after.current?.generation).toBe((await previewInfo(app)).status.generation);

  const records = await listed();
  const fixed = byMessage(records, 'Cannot set properties of null');
  expect(fixed).toMatchObject({ stale: true, count: 1, preview: { generation: 1 } });
  const again = byMessage(records, "Unexpected token ';'");
  expect(again?.stale).toBeUndefined();
  expect(again?.preview?.generation).toBe(1); // first occurrence kept
  expect(again?.last?.preview?.generation).toBe(2);

  // "Clear resolved" removes exactly the stale ones.
  const removed = await page.evaluate(async () => {
    const result = await window.noobide?.problems?.clearResolved();
    return result?.ok ? result.value : -1;
  });
  expect(removed).toBe(records.filter((r) => r.stale).length);
  expect(byMessage(await listed(), 'Cannot set properties of null')).toBeUndefined();
  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');
});

test('a flood of console errors is rate limited and capped; repeats collapse with counts; errors survive (S16.5)', async () => {
  // 3000 messages paced within the in-page console limit (200 per second): about 23 s.
  test.setTimeout(120_000);
  await startPreview(await project('预览 错误洪水'));
  await expect
    .poll(() => evalInPreview<string>(app, 'document.body.dataset.sent ?? ""'), { timeout: 60_000 })
    .toBe('3000');
  await expect.poll(async () => byMessage(await listed(), '洪水之后的错误'), { timeout: 10_000 }).toBeTruthy();
  const { records, stats } = await snapshot();
  const consoleRecords = records.filter((r) => r.source === 'console');
  console.log(
    `error flood: ${consoleRecords.length} console records kept, dropped ${JSON.stringify(stats.dropped)}, ` +
      `evicted ${JSON.stringify(stats.evicted)}`,
  );
  // 3000 different messages: only a burst plus a steady rate become records; the rest are counted as dropped.
  expect(consoleRecords.length).toBeLessThan(1000);
  expect(stats.dropped.console).toBeGreaterThan(0);
  expect(consoleRecords.length + stats.dropped.console).toBeLessThanOrEqual(3001);
  // The repeated message is one record with a count, its first original and its latest repeat verbatim.
  const repeated = consoleRecords.filter((r) => r.originalMessage === '同一个错误');
  expect(repeated).toHaveLength(1);
  expect(repeated[0]?.count).toBeGreaterThan(1);
  expect(repeated[0]).toMatchObject({ file: '洪水.js', line: 8 });
  expect(repeated[0]?.last?.message).toBe('同一个错误');
  // The uncaught error after the flood is kept (console volume has its own budget).
  expect(byMessage(records, '洪水之后的错误')).toMatchObject({
    source: 'runtime',
    code: 'ReferenceError',
    file: '洪水.js',
  });
  expect(stats.dropped.runtime).toBe(0);
  // What the workbench receives is the same bounded list.
  expect((await listed()).length).toBe(records.length);
  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');
});

test('an error in a script from another website is recorded without a location, and explained (S16.6)', async () => {
  const root = await project('预览 跨域');
  // Serve the "other website" from the test (no network): a classic script that throws, without CORS headers.
  await app.evaluate(({ session }, partition) => {
    session.fromPartition(partition).protocol.handle(
      'https',
      () =>
        new Response('// 外部库\nfunction 出错() {\n  throw new Error("外部库出错");\n}\n出错();\n', {
          headers: { 'content-type': 'text/javascript; charset=utf-8' },
        }),
    );
  }, partitionForProject(root));
  await startPreview(root);
  // The page itself is only told "Script error." — the browser hides the details from it.
  await expect.poll(() => evalInPreview<string>(app, 'document.body.dataset.pageSaw ?? ""')).toBe('Script error.');
  await expect.poll(async () => byMessage(await listed(), '外部库出错'), { timeout: 10_000 }).toBeTruthy();
  const record = byMessage(await listed(), '外部库出错');
  expect(record).toMatchObject({
    source: 'runtime',
    originalMessage: 'Uncaught Error: 外部库出错',
    data: { scriptUrl: 'https://cdn.noobide-e2e.example/%E5%A4%96%E9%83%A8%20%E5%BA%93.js' },
  });
  expect(record?.file).toBeUndefined();
  expect(record?.line).toBeUndefined();

  // The Problems panel titles it with the cross-origin explanation (its text: runtime-capture.test.ts) and offers
  // "Show original error" but no "Go to code".
  await page.getByTestId('problems-toggle').click();
  const row = page.getByTestId('problem-row').filter({ hasText: '另一个网站的脚本报告了错误' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('cdn.noobide-e2e.example');
  await row.getByTestId('problem-summary').click();
  await expect(row.getByTestId('problem-show-original')).toBeVisible();
  await expect(row.getByTestId('problem-go-to')).toHaveCount(0);
  await page.getByTestId('problems-toggle').click();
  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');
  await app.evaluate(
    ({ session }, partition) => session.fromPartition(partition).protocol.unhandle('https'),
    partitionForProject(root),
  );
});

test('no console errors in the workbench during the runtime problems run', () => {
  expect(consoleErrors).toEqual([]);
});
