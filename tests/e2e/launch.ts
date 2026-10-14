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

/** Launches the app from the production Vite build in .vite/ (package.json "main"). */
export async function launchApp(env: Record<string, string> = {}): Promise<ElectronApplication> {
  return electron.launch({
    args: electronArgs(),
    cwd: repoRoot,
    env: { ...process.env, ...env } as Record<string, string>,
  });
}
