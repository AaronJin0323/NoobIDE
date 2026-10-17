import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, tempRoot } from './launch';
import { switchLanguage, projectMenu } from './project';
import { copyFixture, evalInPreview, openProject, previewInfo, waitForPreviewState } from './preview-helpers';

/**
 * S15 preview layout end to end: splitters drag (mouse) and persist, the files panel collapses and stays collapsed
 * (S15.1); the narrow Code / Preview switch moves the native view with it (S15.2); the viewport switch changes only
 * the width (S15.3); the view follows fullscreen, hides under dialogs and menus, hands the keyboard focus over, and
 * stays on the stage at fractional and Retina scale factors (S15.5 / S15.6 automatable parts).
 */
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication | null = null;
let page: Page;
let fixture: { tmp: string; root: string };
let userData: string;

async function start(args: string[] = []) {
  app = await launchApp({}, { userDataDir: userData, args });
  page = await app.firstWindow();
  await page.getByTestId('rail').waitFor();
}

async function stop() {
  const current = app;
  app = null;
  await current?.close();
}

function electron(): ElectronApplication {
  if (!app) throw new Error('app is not running');
  return app;
}

/**
 * Sets the window's content size. Exact only when the forced scale factor matches the display's: with
 * --force-device-scale-factor=2 on a Windows display scaled to 150 % the window comes out one pixel larger
 * (1281×801 for 1280×800), so the wait accepts that pixel; layout sizes are checked against the page itself.
 */
async function setContentSize(width: number, height: number) {
  await electron().evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
    { width, height },
  );
  await page.waitForFunction((w) => Math.abs(window.innerWidth - w) <= 1, width);
}

const box = async (testId: string) => {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} is not shown`);
  return b;
};

/** The stage in CSS px (unrounded). */
const stageRect = () =>
  page.getByTestId('preview-stage').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });

/** The native view sits exactly on `expected` (edge-rounded, so within half a pixel on every edge). */
async function expectViewOn(expected: () => Promise<{ x: number; y: number; width: number; height: number }>) {
  await expect
    .poll(async () => {
      const [info, r] = [await previewInfo(electron()), await expected()];
      const b = info.viewBounds;
      if (info.viewVisible !== true || b === null) return 'hidden';
      const close = (a: number, e: number) => Math.abs(a - e) <= 0.5;
      return close(b.x, r.x) &&
        close(b.y, r.y) &&
        close(b.x + b.width, r.x + r.width) &&
        close(b.y + b.height, r.y + r.height)
        ? 'on stage'
        : JSON.stringify({ view: b, stage: r });
    })
    .toBe('on stage');
}

const expectViewOverStage = () => expectViewOn(stageRect);
const viewVisible = async () => (await previewInfo(electron())).viewVisible;

async function drag(testId: string, dx: number) {
  const b = await box(testId);
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  // The press must land on the divider: wait until nothing (a late layout change, a transient overlay) is on top of
  // that point. A drag that started elsewhere was seen once in a full run (the width stayed at its default).
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
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

async function startPreview() {
  // S14.4: opening a project always tries an automatic start; main runs it for a trusted project (after a restart),
  // otherwise the stage asks for consent. Wait for that decision instead of guessing with a fixed delay: under load
  // the automatic start could begin after the guess, and the Start button then vanished under the click.
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

/**
 * The layout the app wrote to app data (S13.4 session.json, 300 ms after the last change), as the dividers show it.
 * Waiting for the file replaces a fixed delay before quitting, which lost the write when the machine was busy.
 */
async function expectLayoutSaved(expected: { filesWidth: string | null; share: string | null; filesOpen: boolean }) {
  await expect
    .poll(async () => {
      try {
        const { layout } = JSON.parse(await readFile(path.join(userData, 'session.json'), 'utf8')) as {
          layout: { filesWidth: number; editorShare: number; filesOpen: boolean } | null;
        };
        if (!layout) return null;
        return {
          filesWidth: String(layout.filesWidth),
          share: String(Math.round(layout.editorShare * 100)),
          filesOpen: layout.filesOpen,
        };
      } catch {
        return null; // not written yet (or replaced at this instant: the write is atomic)
      }
    })
    .toEqual(expected);
}

test.beforeAll(async () => {
  fixture = await copyFixture('预览 多文件');
  userData = await mkdtemp(path.join(tempRoot(), 'noobide-layout-userdata-'));
});

test.afterAll(async () => {
  await stop().catch(() => undefined);
  await rm(fixture.tmp, { recursive: true, force: true }).catch(() => undefined);
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

test('S15.1: dividers drag with the mouse, the view follows, sizes and the collapsed files panel persist', async () => {
  await start();
  await setContentSize(1280, 800);
  await openProject(electron(), page, fixture.root);
  await startPreview();
  await expectViewOverStage();

  const filesBefore = (await box('region-files')).width;
  await drag('splitter-files', 80);
  await expect.poll(async () => Math.round((await box('region-files')).width)).toBe(Math.round(filesBefore + 80));
  await expectViewOverStage();

  const shareBefore = Number(await page.getByTestId('splitter-editor').getAttribute('aria-valuenow'));
  const previewBefore = (await box('region-preview')).width;
  await drag('splitter-editor', 120); // more code, less preview
  await expect
    .poll(async () => Number(await page.getByTestId('splitter-editor').getAttribute('aria-valuenow')))
    .toBeGreaterThan(shareBefore);
  expect((await box('region-preview')).width).toBeLessThan(previewBefore - 100);
  await expectViewOverStage();
  // Keyboard still works on the same divider (S13.4 contract): one step back.
  await page.getByTestId('splitter-editor').focus();
  await page.keyboard.press('ArrowLeft');
  await expectViewOverStage();

  const filesWidth = await page.getByTestId('splitter-files').getAttribute('aria-valuenow');
  const share = await page.getByTestId('splitter-editor').getAttribute('aria-valuenow');
  const filesPx = (await box('region-files')).width;

  // Collapse the files panel: its divider goes, the editor and the preview take the space, the view follows.
  await page.getByTestId('rail-files').click();
  await expect(page.getByTestId('region-files')).toBeHidden();
  await expect(page.getByTestId('splitter-files')).toHaveCount(0);
  await expectViewOverStage();

  await expectLayoutSaved({ filesWidth, share, filesOpen: false });
  await stop();

  await start();
  await setContentSize(1280, 800);
  await expect(page.getByTestId('project-name')).toHaveText(path.basename(fixture.root));
  await expect(page.getByTestId('region-files')).toBeHidden(); // still collapsed
  await expect(page.getByTestId('splitter-editor')).toHaveAttribute('aria-valuenow', share ?? '');
  await page.getByTestId('rail-files').click();
  await expect(page.getByTestId('splitter-files')).toHaveAttribute('aria-valuenow', filesWidth ?? '');
  expect(Math.abs((await box('region-files')).width - filesPx)).toBeLessThanOrEqual(0.5);
  await startPreview();
  await expectViewOverStage();
});

test('S15.2: below the width threshold the Code / Preview switch moves the native view with it', async () => {
  await setContentSize(800, 600);
  const narrowSwitch = page.getByTestId('narrow-switch');
  await expect(narrowSwitch).toBeVisible();
  await expect(page.getByTestId('splitter-editor')).toHaveCount(0); // a toggle, not three columns
  await narrowSwitch.getByRole('button', { name: '代码' }).click();
  await expect(page.getByTestId('region-preview')).toBeHidden();
  await expect.poll(viewVisible).toBe(false);

  await narrowSwitch.getByRole('button', { name: '预览' }).click();
  await expect(page.getByTestId('region-editor')).toBeHidden();
  await expectViewOverStage();
  // The preview takes the whole middle column.
  expect((await stageRect()).width).toBeGreaterThan(600);

  // The files drawer is drawn over the preview: the view gets out of its way, then comes back.
  await page.getByTestId('rail-files').click();
  await expect(page.getByTestId('region-files')).toBeVisible();
  await expect.poll(viewVisible).toBe(false);
  await page.getByTestId('rail-files').click();
  await expectViewOverStage();

  await narrowSwitch.getByRole('button', { name: '代码' }).click();
  await expect.poll(viewVisible).toBe(false);

  await setContentSize(1280, 800);
  await expect(narrowSwitch).toBeHidden();
  await expectViewOverStage();
});

test('S15.3: the mobile choice changes only the width, and says so', async () => {
  await setContentSize(1600, 900); // a stage wider than the mobile width
  await page.getByTestId('splitter-editor').focus();
  await page.keyboard.press('Home'); // most of the width to the preview
  expect((await stageRect()).width).toBeGreaterThan(500);
  const desktop = page.getByTestId('viewport-desktop');
  const mobile = page.getByTestId('viewport-mobile');
  await expect(page.getByTestId('viewport-switch')).toHaveAttribute('aria-label', '页面宽度');
  await expect(desktop).toHaveText('桌面宽度');
  await expect(mobile).toHaveText('手机宽度 375px');
  await expect(desktop).toHaveAttribute('aria-pressed', 'true');
  const before = await evalInPreview<{ ua: string; touch: number; dpr: number; width: number }>(
    electron(),
    '({ ua: navigator.userAgent, touch: navigator.maxTouchPoints, dpr: devicePixelRatio, width: innerWidth })',
  );

  await mobile.click();
  await expect(mobile).toHaveAttribute('aria-pressed', 'true');
  await expect(desktop).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('viewport-switch')).toContainText('不是手机模拟');
  await expectViewOn(async () => {
    const s = await stageRect();
    return { x: s.x + Math.floor((s.width - 375) / 2), y: s.y, width: 375, height: s.height };
  });
  await expect.poll(() => evalInPreview<number>(electron(), 'innerWidth')).toBe(375);
  // Not device emulation: user agent, touch support and pixel ratio are unchanged.
  const after = await evalInPreview<{ ua: string; touch: number; dpr: number }>(
    electron(),
    '({ ua: navigator.userAgent, touch: navigator.maxTouchPoints, dpr: devicePixelRatio })',
  );
  expect(after).toEqual({ ua: before.ua, touch: before.touch, dpr: before.dpr });

  await desktop.click();
  await expectViewOverStage();
  await expect.poll(() => evalInPreview<number>(electron(), 'innerWidth')).toBe(before.width);

  // English labels say "width" too.
  await switchLanguage(page);
  await expect(mobile).toHaveText('Mobile width 375px');
  await expect(desktop).toHaveText('Desktop width');
  await mobile.click();
  await expect(page.getByTestId('viewport-switch')).toContainText('not phone emulation');
  await desktop.click();
  await switchLanguage(page);
  await expect(desktop).toHaveText('桌面宽度');
});

test('S15.6: dialogs and menus drawn over the preview hide the view while they are open', async () => {
  await expectViewOverStage();
  // The About dialog (native menu → workbench dialog with a full-window backdrop).
  await electron().evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('about');
    (item?.click as () => void)();
  });
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(viewVisible).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectViewOverStage();

  // The workbench's own "more actions" menu, which drops down over the preview column.
  await page.getByTestId('app-menu').click();
  const list = page.locator('#app-menu-list');
  await expect(list).toBeVisible();
  const overlapsStage = await list.evaluate((el) => {
    const m = el.getBoundingClientRect();
    const s = document.querySelector('[data-testid="preview-stage"]')!.getBoundingClientRect();
    return m.left < s.right && s.left < m.right && m.top < s.bottom && s.top < m.bottom;
  });
  await expect.poll(viewVisible).toBe(!overlapsStage);
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expectViewOverStage();

  // Any other modal backdrop (e.g. a confirmation) is detected generically, not from a fixed list.
  await page.evaluate(() => {
    const backdrop = document.createElement('div');
    backdrop.className = 'dialog-backdrop';
    backdrop.id = 'test-backdrop';
    document.body.appendChild(backdrop);
  });
  await expect.poll(viewVisible).toBe(false);
  await page.evaluate(() => document.getElementById('test-backdrop')?.remove());
  await expectViewOverStage();

  // A menu that does not reach the stage leaves the view alone.
  await page.evaluate(() => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.id = 'test-menu';
    Object.assign(menu.style, { position: 'fixed', left: '0px', top: '0px', width: '40px', height: '40px' });
    document.body.appendChild(menu);
  });
  await page.waitForTimeout(200);
  expect(await viewVisible()).toBe(true);
  await page.evaluate(() => document.getElementById('test-menu')?.remove());
});

test('S15.6: keyboard focus goes into the page with Enter and comes back with F6 / Shift+F6', async () => {
  const previewId = async () => (await previewInfo(electron())).previewWebContentsId;
  const focusState = async () =>
    electron().evaluate(
      ({ BrowserWindow, webContents }, previewId) => {
        const win = BrowserWindow.getAllWindows()[0];
        return {
          window: win?.isFocused() ?? false,
          page: previewId === null ? false : (webContents.fromId(previewId)?.isFocused() ?? false),
          workbench: win?.webContents.isFocused() ?? false,
        };
      },
      await previewId(),
    );
  // Keyboard focus is judged with the OS focus state, so the window must be the active one. macOS may refuse to
  // activate an app while the user works in another one (cooperative activation); the check is skipped then rather
  // than reported as a product failure.
  const focusWindow = async () => {
    for (let i = 0; i < 25; i += 1) {
      const focused = await electron().evaluate(({ app: electronApp, BrowserWindow }) => {
        electronApp.focus({ steal: true });
        const win = BrowserWindow.getAllWindows()[0];
        win?.focus();
        return win?.isFocused() ?? false;
      });
      if (focused) return;
      await page.waitForTimeout(200);
    }
    test.skip(true, 'the OS did not give the NoobIDE window the focus (another app is active)');
  };
  await focusWindow();

  // Starting or refreshing the page does not take the keyboard focus away from the workbench (FocusGuard): after a
  // save refreshes the preview, the next key presses must still reach the editor.
  const workbenchKeepsFocus = async () => {
    // A load may move the focus for a moment (the view takes it natively); it must come straight back and stay.
    await expect.poll(async () => (await focusState()).page, { timeout: 2_000 }).toBe(false);
    for (let i = 0; i < 10; i += 1) {
      const state = await focusState();
      expect(state.page).toBe(false);
      // Another app may take the OS focus meanwhile (e.g. a parallel test run); only judge while the window has it.
      if (state.window) expect(state.workbench).toBe(true);
      await page.waitForTimeout(100);
    }
  };
  await page.getByTestId('preview-stop').click();
  await waitForPreviewState(page, 'stopped');
  await focusWindow();
  await electron().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.focus());
  await expect.poll(focusState).toEqual({ window: true, page: false, workbench: true });
  await page.getByTestId('preview-start').click();
  await waitForPreviewState(page, 'running');
  await workbenchKeepsFocus();
  const generation = Number(await page.getByTestId('preview-state').getAttribute('data-generation'));
  await page.getByTestId('preview-reload').click();
  // The reload is a new generation (refreshing → running); waiting for it replaces a fixed 300 ms delay.
  await expect
    .poll(async () => Number(await page.getByTestId('preview-state').getAttribute('data-generation')))
    .toBeGreaterThan(generation);
  await waitForPreviewState(page, 'running');
  await workbenchKeepsFocus();
  // Showing the view again after an overlay closes does not take the focus either.
  await page.evaluate(() => {
    const backdrop = document.createElement('div');
    backdrop.className = 'dialog-backdrop';
    backdrop.id = 'test-backdrop';
    document.body.appendChild(backdrop);
  });
  await expect.poll(viewVisible).toBe(false);
  await page.evaluate(() => document.getElementById('test-backdrop')?.remove());
  await expect.poll(viewVisible).toBe(true);
  await workbenchKeepsFocus();

  const id = await previewId();
  expect(id).not.toBeNull();
  const stage = page.getByTestId('preview-stage');
  await expect(stage).toHaveAttribute('tabindex', '0');
  await expect(stage).toHaveAttribute('aria-label', /Enter.*F6/);
  await focusWindow();
  await stage.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await focusState()).page).toBe(true);
  // Keys now reach the page.
  await evalInPreview(electron(), `window.__keys = []; addEventListener('keydown', e => __keys.push(e.key)); 1`);
  await electron().evaluate(({ webContents }, previewId) => {
    const wc = webContents.fromId(previewId as number);
    wc?.sendInputEvent({ type: 'keyDown', keyCode: 'a' });
    wc?.sendInputEvent({ type: 'char', keyCode: 'a' });
    wc?.sendInputEvent({ type: 'keyUp', keyCode: 'a' });
  }, id);
  await expect.poll(() => evalInPreview<string[]>(electron(), 'window.__keys')).toContain('a');

  // A dialog drawn over the page hides it, and the hidden page does not keep the keyboard focus.
  await page.evaluate(() => {
    const backdrop = document.createElement('div');
    backdrop.className = 'dialog-backdrop';
    backdrop.id = 'test-backdrop-2';
    document.body.appendChild(backdrop);
  });
  await expect.poll(viewVisible).toBe(false);
  await expect.poll(focusState).toMatchObject({ page: false, workbench: true });
  await page.evaluate(() => document.getElementById('test-backdrop-2')?.remove());
  await expect.poll(viewVisible).toBe(true);
  await focusWindow();
  await stage.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await focusState()).page).toBe(true);

  // F6 in the page: focus returns to the workbench and moves on to the region after the preview.
  await electron().evaluate(({ webContents }, previewId) => {
    const wc = webContents.fromId(previewId as number);
    wc?.sendInputEvent({ type: 'keyDown', keyCode: 'F6' });
    wc?.sendInputEvent({ type: 'keyUp', keyCode: 'F6' });
  }, id);
  await expect.poll(async () => (await focusState()).workbench).toBe(true);
  expect(await focusState()).toMatchObject({ page: false });
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.closest('[data-testid^="region-"]')?.getAttribute('data-testid')),
    )
    .toBe('region-problems');
  expect(await evalInPreview<string[]>(electron(), 'window.__keys')).not.toContain('F6'); // the page never saw it

  // Shift+F6 from the page goes to the region before the preview (the editor).
  await focusWindow();
  await stage.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await focusState()).page).toBe(true);
  await electron().evaluate(({ webContents }, previewId) => {
    const wc = webContents.fromId(previewId as number);
    wc?.sendInputEvent({ type: 'keyDown', keyCode: 'F6', modifiers: ['shift'] });
    wc?.sendInputEvent({ type: 'keyUp', keyCode: 'F6', modifiers: ['shift'] });
  }, id);
  await expect.poll(async () => (await focusState()).workbench).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.closest('[data-testid^="region-"]')?.getAttribute('data-testid')),
    )
    .toBe('region-editor');
});

test('S15.6: the view follows the window into and out of fullscreen', async () => {
  await setContentSize(1000, 700);
  await expectViewOverStage();
  const before = await stageRect();
  /** Native fullscreen; false when macOS does not run the transition (e.g. the app is not the active one). */
  const fullScreen = (on: boolean) =>
    electron().evaluate(
      ({ BrowserWindow }, wanted) =>
        new Promise<boolean>((resolve) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (!win) return resolve(false);
          const timer = setTimeout(() => resolve(win.isFullScreen() === wanted), 10_000);
          const done = () => {
            clearTimeout(timer);
            resolve(true);
          };
          if (wanted) win.once('enter-full-screen', done);
          else win.once('leave-full-screen', done);
          win.setFullScreen(wanted);
        }),
      on,
    );
  if (!(await fullScreen(true))) {
    await fullScreen(false);
    test.skip(true, 'the OS did not enter fullscreen (the window is not active)');
  }
  await expect.poll(async () => (await stageRect()).width).toBeGreaterThan(before.width);
  await expectViewOverStage();
  expect(await fullScreen(false)).toBe(true);
  await expectViewOverStage();
});

test('a 1280×800 window with the walkthrough and Problems open keeps a usable preview (zh-CN and en)', async () => {
  // 1280×720 content: what a 1280×800 window leaves under the Windows title and menu bars (≈ 1266×737 at 150 %).
  await setContentSize(1280, 720);
  await projectMenu(page, 'help-walkthrough');
  await expect(page.getByTestId('walkthrough')).toBeVisible();
  if ((await page.getByTestId('problems-panel').isHidden()) === true) await page.getByTestId('rail-problems').click();
  await expect(page.getByTestId('problems-panel')).toBeVisible();
  const check = async (locale: string) => {
    await expectViewOverStage();
    const info = await previewInfo(electron());
    expect(info.viewBounds?.height ?? 0, `${locale}: preview height`).toBeGreaterThanOrEqual(200);
    // The walkthrough's buttons and the problems panel are still on screen (they give way, they do not vanish).
    const inView = (testId: string) =>
      page.getByTestId(testId).evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
      });
    expect(await inView('walkthrough-next'), `${locale}: walkthrough Next`).toBe(true);
    expect(await inView('problems-toggle'), `${locale}: problems toggle`).toBe(true);
    // Key features are never hidden: the "Annotate page" entry and the primary preview action are fully inside the
    // preview pane and the window, with nothing scrolled (the rows above the stage never scroll; the stage gives way).
    const keyControls = await page.getByTestId('region-preview').evaluate((pane) => {
      const p = pane.getBoundingClientRect();
      const inside = (selector: string) => {
        const el = pane.querySelector(selector);
        if (!el) return `${selector}: missing`;
        const r = el.getBoundingClientRect();
        const ok =
          r.width > 0 &&
          r.height > 0 &&
          r.top >= p.top &&
          r.bottom <= p.bottom &&
          r.left >= p.left &&
          r.right <= p.right &&
          r.top >= 0 &&
          r.bottom <= window.innerHeight;
        return ok ? 'inside' : `${selector}: ${JSON.stringify({ el: r, pane: p })}`;
      };
      const chrome = pane.querySelector('[data-testid="preview-chrome"]');
      return {
        annotate: inside('[data-testid="annotate-menu"]'),
        list: inside('[data-testid="annotations-toggle"]'),
        primary: inside('[data-testid="preview-reload"]'),
        toolbar: inside('[data-testid="preview-toolbar"]'),
        console: inside('[data-testid="console-head"]'),
        chromeScrolled: chrome ? chrome.scrollTop !== 0 || chrome.scrollHeight > chrome.clientHeight + 1 : true,
      };
    });
    expect(keyControls, `${locale}: key preview controls`).toEqual({
      annotate: 'inside',
      list: 'inside',
      primary: 'inside',
      toolbar: 'inside',
      console: 'inside',
      chromeScrolled: false,
    });
    await expect(page.getByTestId('annotate-menu')).toHaveAttribute('data-available', 'true');
  };
  await check('zh-CN');
  await switchLanguage(page);
  await expect(page.getByTestId('viewport-desktop')).toHaveText('Desktop width');
  await check('en');
  await switchLanguage(page);
  // A 1280×800 content area keeps it too.
  await setContentSize(1280, 800);
  await expectViewOverStage();
  expect((await previewInfo(electron())).viewBounds?.height ?? 0).toBeGreaterThanOrEqual(200);
  // 1366×768 laptop (≈ 1366×677 content) with the walkthrough and Problems open: still nothing hidden.
  await setContentSize(1366, 677);
  await check('zh-CN 1366×677');
  await page.getByTestId('walkthrough-close').click();
  await expect(page.getByTestId('walkthrough')).toHaveCount(0);
  // Problems open alone at 1280×720: the Annotate entry is on screen without scrolling.
  await setContentSize(1280, 720);
  await expectViewOverStage();
  const annotate = await page.getByTestId('annotate-menu').boundingBox();
  const pane = await page.getByTestId('region-preview').boundingBox();
  expect(annotate && pane && annotate.y >= pane.y && annotate.y + annotate.height <= pane.y + pane.height).toBe(true);
  expect(await page.getByTestId('preview-chrome').evaluate((el) => el.scrollTop)).toBe(0);
});

for (const factor of [1.5, 2]) {
  test(`S15.5/S15.6: at scale factor ${factor} the view stays on the stage and divider sizes persist exactly`, async () => {
    await stop();
    await start([`--force-device-scale-factor=${factor}`]);
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(factor);
    await setContentSize(1280, 800);
    await startPreview();
    await expectViewOverStage();
    await drag('splitter-files', 37);
    await drag('splitter-editor', -53);
    await expectViewOverStage();
    await page.getByTestId('viewport-mobile').click();
    await expect.poll(() => evalInPreview<number>(electron(), 'innerWidth')).toBe(375);
    await page.getByTestId('viewport-desktop').click();
    await expectViewOverStage();
    const filesWidth = await page.getByTestId('splitter-files').getAttribute('aria-valuenow');
    const share = await page.getByTestId('splitter-editor').getAttribute('aria-valuenow');
    const filesPx = (await box('region-files')).width;
    await expectLayoutSaved({ filesWidth, share, filesOpen: true });
    await stop();

    await start([`--force-device-scale-factor=${factor}`]);
    await setContentSize(1280, 800);
    await expect(page.getByTestId('splitter-files')).toHaveAttribute('aria-valuenow', filesWidth ?? '');
    await expect(page.getByTestId('splitter-editor')).toHaveAttribute('aria-valuenow', share ?? '');
    expect(Math.abs((await box('region-files')).width - filesPx)).toBeLessThanOrEqual(0.5);
    await startPreview();
    await expectViewOverStage();
    await stop();
  });
}
