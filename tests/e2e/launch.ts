import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { backgroundLoadFromEnv } from './load-cpu';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The OS language the suite runs under (S59.2). With no saved choice the app starts in the OS language (zh* → zh-CN,
 * else en), and CI machines are English, while the suite's expectations assume zh-CN. Three layers pin it:
 * - `--lang=zh-CN` sets the locale Chromium and main's app.getLocale() report on Windows and Linux;
 * - on macOS Chromium ignores `--lang` for the application locale and reads AppleLanguages, so the launch also passes
 *   the Cocoa argument domain `-AppleLanguages (zh-CN)` (after the app path, where Electron leaves it alone);
 * - launchApp seeds `settings.json` with `locale: zh-CN` when the app-data folder has none (a saved choice).
 * A test of the first-run language passes its own `--lang=…` in launchApp's `args`; then none of this applies.
 */
export const E2E_LANG_SWITCH = '--lang=zh-CN';
export const E2E_APPLE_LANGUAGES = ['-AppleLanguages', '(zh-CN)'] as const;

/**
 * Chromium refuses to start as root without --no-sandbox (Linux containers / CI). Never needed on a normal
 * Windows or macOS account. The workbench keeps sandbox:true in webPreferences regardless. Pins the OS language
 * (above) unless `pinLanguage` is false. The app path '.' is always the first positional argument.
 */
export function electronArgs({ pinLanguage = true }: { pinLanguage?: boolean } = {}): string[] {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const sandbox = isRoot ? ['--no-sandbox'] : [];
  if (!pinLanguage) return [...sandbox, '.'];
  const apple = process.platform === 'darwin' ? [...E2E_APPLE_LANGUAGES] : [];
  return [E2E_LANG_SWITCH, ...sandbox, '.', ...apple];
}

/**
 * The saved-choice layer of the language pin: a minimal settings file (version 1, locale zh-CN; every other field
 * takes its default) written only when the app-data folder has no settings file yet, so a test's own file, and the
 * file of an earlier launch into the same folder, are never touched.
 */
export function seedZhCnSettings(userDataDir: string): void {
  const file = path.join(userDataDir, 'settings.json');
  if (existsSync(file)) return;
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: 1, locale: 'zh-CN' }, null, 2)}\n`, { flag: 'wx' });
}

/**
 * The OS temp folder with symbolic links resolved. On macOS `os.tmpdir()` is under `/var/folders/…`, a link to
 * `/private/var/folders/…`; the app resolves a project root to its real path (the static server's realpath guard
 * depends on it) and shows that, so tests that compare shown paths must start from the real path too.
 */
export function tempRoot(): string {
  return realpathSync.native(os.tmpdir());
}

const tempUserDataDirs: string[] = [];
process.once('exit', () => {
  for (const dir of tempUserDataDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Chromium helpers may still hold a file; the OS temp cleanup gets it later.
    }
  }
});

/**
 * Launches the app from the production Vite build in .vite/ (package.json "main"). Every run gets its own app-data
 * directory (Chromium's --user-data-dir, which Electron's app.getPath('userData') follows): a fresh temporary one by
 * default, or `userDataDir` when a test relaunches into the same data (recovery journal, history). Tests therefore
 * neither see nor touch the developer's real data, and an open NoobIDE does not hold the single-instance lock.
 */
export async function launchApp(
  env: Record<string, string> = {},
  options: { userDataDir?: string; /** Extra Chromium/Electron switches. */ args?: string[] } = {},
): Promise<ElectronApplication> {
  backgroundLoadFromEnv(); // S58.4: NOOBIDE_E2E_LOAD=1 runs the suite on a loaded machine
  let userDataDir = options.userDataDir;
  if (!userDataDir) {
    userDataDir = mkdtempSync(path.join(tempRoot(), 'noobide-e2e-userdata-'));
    tempUserDataDirs.push(userDataDir);
  }
  const extra = options.args ?? [];
  const pinLanguage = !extra.some((arg) => arg.startsWith('--lang='));
  if (pinLanguage) seedZhCnSettings(userDataDir);
  const args = [`--user-data-dir=${userDataDir}`, ...extra, ...electronArgs({ pinLanguage })];
  const app = await electron.launch({
    args,
    cwd: repoRoot,
    env: { ...process.env, ...env } as Record<string, string>,
  });
  const size = /^(\d+)x(\d+)$/.exec(process.env.NOOBIDE_E2E_WINDOW ?? '');
  if (size) {
    // Reproduces a smaller screen (the Windows CI runner's display is 1024×768, so its window is much shorter than
    // the 1280×800 default): e.g. NOOBIDE_E2E_WINDOW=1024x600 sets the first window's content size.
    await app.firstWindow();
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]?.setContentSize(w, h), [
      Number(size[1]),
      Number(size[2]),
    ] as const);
  }
  return app;
}
