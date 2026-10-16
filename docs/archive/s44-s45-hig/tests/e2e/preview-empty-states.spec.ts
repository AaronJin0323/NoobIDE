import { rm } from 'node:fs/promises';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { launchApp } from './launch';
import { makeProject, openFile, openProject } from './project';
import { switchLanguage } from './language-switch';

/**
 * S45.3 (HIG Empty states, Layout, Toolbars) at the 1280×800 default window, in zh-CN and en: the preview, Problems and
 * console empty states are a title plus one short sentence of at most two lines (the longer reason behind "Why?"),
 * and the preview header keeps its title and state word when the AI panel narrows the pane.
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let tmp: string;
let root: string;

test.beforeAll(async () => {
  ({ tmp, root } = await makeProject('noobide-empty-states-'));
  app = await launchApp();
  page = await app.firstWindow();
  await page.getByTestId('rail').waitFor();
});

test.afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

/** How many lines of text the element takes. */
async function lines(el: Locator): Promise<number> {
  return el.evaluate((e) => {
    const style = getComputedStyle(e);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
    return Math.round(e.getBoundingClientRect().height / lineHeight);
  });
}

async function expectSteadyHeader(title: string) {
  const header = page.getByTestId('preview-toolbar');
  await expect(header.locator('.preview-title')).toBeVisible();
  await expect(header.locator('.preview-title')).toHaveText(title);
  const state = page.getByTestId('preview-state').locator('.state-pill-text');
  await expect(state).toBeVisible();
  expect(await state.evaluate((e) => e.scrollWidth <= e.clientWidth + 1 && e.clientWidth > 12)).toBe(true);
}

for (const locale of ['zh-CN', 'en'] as const) {
  test(`${locale}: short empty states and a steady preview header`, async () => {
    if (locale === 'en') await switchLanguage(page);
    else {
      await openProject(app, page, root);
      await openFile(page, 'index.html');
    }
    const zh = locale === 'zh-CN';

    // Preview: a folder from the computer waits for Start — title, one sentence (≤ 2 lines), Start, then "Why?".
    const consent = page.getByTestId('preview-consent');
    await expect(consent).toBeVisible({ timeout: 20_000 });
    const sentence = consent.locator('.empty-detail').first();
    await expect(sentence).toBeVisible();
    expect(await lines(sentence)).toBeLessThanOrEqual(2);
    await expect(consent.locator('.empty-title')).toHaveCount(1);
    await expect(consent.getByTestId('preview-start')).toHaveCount(1);
    const why = consent.getByTestId('preview-more-info');
    await expect(why.locator('summary')).toHaveText(zh ? '为什么？' : 'Why?');
    await expect(why.locator('.empty-more-detail')).toBeHidden();
    await why.locator('summary').click();
    await expect(why.locator('.empty-more-detail')).toContainText(zh ? '为了安全' : 'For safety');
    await why.locator('summary').click();
    await expect(why.locator('.empty-more-detail')).toBeHidden();

    // Console: one quiet line.
    const consoleEmpty = page.getByTestId('preview-console-empty');
    await expect(consoleEmpty).toHaveText(zh ? '网页还没有输出。' : 'The page has not logged anything yet.');
    expect(await lines(consoleEmpty)).toBe(1);

    // Problems: one calm empty state, one short sentence.
    await page.getByTestId('problems-toggle').click();
    const none = page.getByTestId('problems-none');
    await expect(none).toBeVisible({ timeout: 20_000 });
    expect(await lines(none.locator('.empty-detail'))).toBeLessThanOrEqual(2);
    await page.getByTestId('problems-toggle').click();

    // A narrower pane (the AI panel open): the title and the state word stay; the width choices become icons.
    await expectSteadyHeader(zh ? '预览' : 'Preview');
    await page.getByTestId('rail-ai').click();
    await expectSteadyHeader(zh ? '预览' : 'Preview');
    await expect(page.getByTestId('viewport-desktop')).toHaveAccessibleName(zh ? '桌面宽度' : 'Desktop');
    await page.getByTestId('rail-ai').click();
  });
}
