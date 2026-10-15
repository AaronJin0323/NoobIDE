import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { repoRoot, tempRoot } from './launch';
import { focusEditor } from './project';

/** Shared steps for the preview e2e specs (S04, S05). */

export interface PreviewInfo {
  status: { state: string; projectId: string | null; failure?: string; url?: string; generation?: number };
  origin: string | null;
  partition: string | null;
  previewPid: number | null;
  previewWebContentsId: number | null;
  viewBounds: { x: number; y: number; width: number; height: number } | null;
  viewVisible: boolean | null;
  webPreferences: Record<string, unknown> | null;
  blockedRequests: { scheme: string; host: string }[];
  pageGuarded?: boolean | null;
  /** The console flood guard's last stop decisions (counts and timings). */
  floodTrace?: { kind: string; ms: number; inWindow: number; limit: number; stopped?: boolean }[];
}

export async function answerFolderDialog(app: ElectronApplication, folder: string | null): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    const fake = async () => ({ canceled: chosen === null, filePaths: chosen === null ? [] : [chosen] });
    (dialog as unknown as { showOpenDialog: typeof fake }).showOpenDialog = fake;
  }, folder);
}

export async function openProject(app: ElectronApplication, page: Page, folder: string): Promise<void> {
  await answerFolderDialog(app, folder);
  // Whichever entry the screen shows once it has rendered (welcome: open-folder; a project open: open-other-folder).
  await page.getByTestId('open-folder').or(page.getByTestId('open-other-folder')).first().click();
  await expect(page.getByTestId('project-name')).toHaveText(path.basename(folder));
}

/** Copies a fixture to a temp folder whose path has Chinese characters and spaces. */
export async function copyFixture(fixture: string, name = fixture): Promise<{ tmp: string; root: string }> {
  const tmp = await mkdtemp(path.join(tempRoot(), 'noobide-e2e-'));
  const root = path.join(tmp, '网页 练习', name);
  await mkdir(path.dirname(root), { recursive: true });
  await cp(path.join(repoRoot, 'tests', 'fixtures', fixture), root, { recursive: true });
  return { tmp, root };
}

export function previewInfo(app: ElectronApplication): Promise<PreviewInfo> {
  return app.evaluate(() =>
    (globalThis as unknown as { __noobideTestHooks: { preview(): PreviewInfo } }).__noobideTestHooks.preview(),
  );
}

export async function waitForPreviewState(page: Page, state: string, timeout = 20_000): Promise<void> {
  await expect(page.getByTestId('preview-state')).toHaveAttribute('data-state', state, { timeout });
}

/** Runs code inside the preview page (the test drives main, the page itself has no bridge). */
export async function evalInPreview<T>(app: ElectronApplication, code: string): Promise<T> {
  const info = await previewInfo(app);
  if (info.previewWebContentsId === null) throw new Error('no preview');
  return app.evaluate(({ webContents }, { id, js }) => webContents.fromId(id)?.executeJavaScript(js, true), {
    id: info.previewWebContentsId,
    js: code,
  }) as Promise<T>;
}

/** Replaces the whole editor text through the clipboard (typing markup would trigger Monaco's auto-closing). */
export async function replaceEditorText(app: ElectronApplication, page: Page, text: string): Promise<void> {
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+V');
}

export async function workbenchPid(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId() ?? -1);
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
