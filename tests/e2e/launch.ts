import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication } from '@playwright/test';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Chromium refuses to start as root without --no-sandbox (Linux containers / CI). Never needed on a normal
 * Windows or macOS account. The workbench keeps sandbox:true in webPreferences regardless.
 */
export function electronArgs(): string[] {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  return isRoot ? ['--no-sandbox', '.'] : ['.'];
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
  options: { userDataDir?: string } = {},
): Promise<ElectronApplication> {
  let userDataDir = options.userDataDir;
  if (!userDataDir) {
    userDataDir = mkdtempSync(path.join(tempRoot(), 'noobide-e2e-userdata-'));
    tempUserDataDirs.push(userDataDir);
  }
  const args = [`--user-data-dir=${userDataDir}`, ...electronArgs()];
  return electron.launch({
    args,
    cwd: repoRoot,
    env: { ...process.env, ...env } as Record<string, string>,
  });
}
