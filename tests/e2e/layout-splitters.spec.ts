import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, tempRoot } from './launch';
import { copyFixture, openProject, previewInfo, waitForPreviewState } from './preview-helpers';

/**
 * S49.1 splitter physics end to end: a click on a divider does nothing (4 px dead zone); dragging the code / preview
 * divider across the preview covers the native view with the last picture of the page and gives the live view back
 * on release; Escape rolls a drag back; a double-click resets the default sizes; dragging the files divider under
 * 120 px collapses the panel like the rail button (which shows it) and dragging back out reopens it.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication | null = null;
let page: Page;
let fixture: { tmp: string; root: string };
let userData: string;

function electron(): ElectronApplication {
  if (!app) throw new Error('app is not running');
  return app;
}

const box = async (testId: string) => {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} is not shown`);
  return b;
};

const stageRect = () =>
  page.getByTestId('preview-stage').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });

/** The native view is shown and sits on the stage (edge-rounded: within half a pixel on every edge): it is live. */
async function expectLive() {
  await expect
    .poll(async () => {
      const [info, r] = [await previewInfo(electron()), await stageRect()];
      const b = info.viewBounds;
      if (info.viewVisible !== true || b === null) return 'hidden';
      const close = (a: number, e: number) => Math.abs(a - e) <= 0.5;
      return close(b.x, r.x) &&
        close(b.y, r.y) &&
        close(b.x + b.width, r.x + r.width) &&
        close(b.y + b.height, r.y + r.height)
        ? 'live'
        : JSON.stringify({ view: b, stage: r });
    })
    .toBe('live');
}
const viewVisible = async () => (await previewInfo(electron())).viewVisible;
const valueNow = async (testId: string) => Number(await page.getByTestId(testId).getAttribute('aria-valuenow'));

/** Presses the middle of a divider (once nothing else is on top of it) and returns where. */
async function press(testId: string) {
  const b = await box(testId);
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await expect
    .poll(() =>
      page.evaluate(
        ({ px, py }) => document.elementFromPoint(px, py)?.closest('[role="separator"]')?.getAttribute('data-testid'),
        { px: x, py: y },
      ),
    )
    .toBe(testId);
  await page.mouse.move(x, y);
  await page.mouse.down();
  return { x, y };
}

async function startPreview() {
  const state = page.getByTestId('preview-state');
  const consent = page.getByTestId('preview-consent');
  await expect
    .poll(async () => ((await consent.count()) > 0 ? 'consent' : await state.getAttribute('data-state')), {
      timeout: 20_000,
    })
    .toMatch(/^(consent|starting|running)$/);
  if ((await consent.count()) > 0) await page.getByTestId('preview-consent-start').click();
  await waitForPreviewState(page, 'running');
}

test.beforeAll(async () => {
  fixture = await copyFixture('预览 多文件');
  userData = await mkdtemp(path.join(tempRoot(), 'noobide-splitter-userdata-'));
  app = await launchApp({}, { userDataDir: userData });
  page = await app.firstWindow();
  await page.getByTestId('rail').waitFor();
  await electron().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800));
  await page.waitForFunction(() => Math.abs(window.innerWidth - 1280) <= 1);
  await openProject(electron(), page, fixture.root);
  await startPreview();
  await expectLive();
});

test.afterAll(async () => {
  const current = app;
  app = null;
  await current?.close().catch(() => undefined);
  await rm(fixture.tmp, { recursive: true, force: true }).catch(() => undefined);
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

test('S49.1: a click inside the 4 px dead zone does not move a divider; the value is announced in words', async () => {
  const editor = page.getByTestId('splitter-editor');
  await expect(editor).toHaveAttribute('aria-valuenow', '50');
  await expect(editor).toHaveAttribute('aria-valuetext', '代码占 50%，预览占 50%');
  await expect(page.getByTestId('splitter-files')).toHaveAttribute('aria-valuetext', '文件面板宽 220 像素');

  const { x, y } = await press('splitter-editor');
  await page.mouse.move(x + 3, y);
  await page.mouse.up();
  await expect(editor).toHaveAttribute('aria-valuenow', '50');
  expect(await viewVisible()).toBe(true); // never covered by a click
});

test('S49.1: dragging across the preview covers it with the last picture, then the live view comes back', async () => {
  const total = (await box('region-editor')).width + (await box('region-preview')).width;
  const start = (await valueNow('splitter-editor')) / 100;
  const { x, y } = await press('splitter-editor');
  // Pressed but not dragged yet: the view is still live (and its picture is taken now).
  await page.mouse.move(x + 2, y);
  expect(await viewVisible()).toBe(true);

  await page.mouse.move(x + 40, y, { steps: 4 });
  await expect(page.getByTestId('region-preview')).toHaveAttribute('data-resizing', 'true');
  await expect.poll(viewVisible).toBe(false); // the native view cannot swallow the drag
  await expect(page.getByTestId('preview-resize-shot')).toBeVisible();
  await expect(page.getByTestId('preview-resize-shot')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(page.getByTestId('preview-resize-shot')).toHaveAttribute('alt', '调整宽度时显示的页面画面');

  await page.mouse.move(x + 150, y, { steps: 6 }); // well over where the native view was
  await page.mouse.up();
  const expected = Math.round((start + 150 / total) * 100);
  await expect.poll(() => valueNow('splitter-editor')).toBe(expected);
  await expect(page.getByTestId('region-preview')).not.toHaveAttribute('data-resizing', 'true');
  await expect(page.getByTestId('preview-resize-shot')).toHaveCount(0);
  await expectLive();
});

test('S49.1: Escape during a drag restores the start value and the live view', async () => {
  const before = await valueNow('splitter-editor');
  const { x, y } = await press('splitter-editor');
  await page.mouse.move(x - 120, y, { steps: 6 });
  await expect.poll(() => valueNow('splitter-editor')).toBeLessThan(before - 5);
  await expect.poll(viewVisible).toBe(false);
  await page.keyboard.press('Escape');
  await expect.poll(() => valueNow('splitter-editor')).toBe(before);
  await expectLive();
  // Moving on and releasing after Escape changes nothing more.
  await page.mouse.move(x - 200, y, { steps: 4 });
  await page.mouse.up();
  expect(await valueNow('splitter-editor')).toBe(before);
  await expectLive();
});

test('S49.1: a double-click resets the files width to 220 and the editor share to 0.5', async () => {
  const { x, y } = await press('splitter-files');
  await page.mouse.move(x + 90, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => valueNow('splitter-files')).toBe(310);
  expect(await valueNow('splitter-editor')).not.toBe(50);

  await page.getByTestId('splitter-files').dblclick();
  await expect.poll(() => valueNow('splitter-files')).toBe(220);
  await expect.poll(async () => Math.round((await box('region-files')).width)).toBe(220);
  await page.getByTestId('splitter-editor').dblclick();
  await expect.poll(() => valueNow('splitter-editor')).toBe(50);
  await expectLive();
});

test('S49.1: dragging the files divider under 120 px collapses the panel like the rail button; back out reopens', async () => {
  const rail = page.getByTestId('rail-files');
  await expect(rail).toHaveAttribute('aria-pressed', 'true');
  const width = await valueNow('splitter-files');

  // One gesture: in (collapses, the divider stays under the pointer), back out (reopens at the dragged width).
  let { x, y } = await press('splitter-files');
  await page.mouse.move(x - (width - 100), y, { steps: 8 });
  await expect(page.getByTestId('region-files')).toBeHidden();
  await expect(rail).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('splitter-files')).toHaveAttribute('aria-valuetext', '文件面板已收起');
  await page.mouse.move(x + 40, y, { steps: 8 });
  await expect(page.getByTestId('region-files')).toBeVisible();
  await expect(rail).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.up();
  await expect.poll(() => valueNow('splitter-files')).toBe(width + 40);

  // Released while collapsed: the same state as the rail button, which reopens it at the width the drag began with.
  ({ x, y } = await press('splitter-files'));
  await page.mouse.move(x - (width + 40 - 90), y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('region-files')).toBeHidden();
  await expect(rail).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('splitter-files')).toHaveCount(0);
  await expectLive();
  await rail.click();
  await expect(page.getByTestId('region-files')).toBeVisible();
  await expect(page.getByTestId('splitter-files')).toHaveAttribute('aria-valuenow', String(width + 40));
  await expectLive();
});
