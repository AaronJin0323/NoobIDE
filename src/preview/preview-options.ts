import { createHash } from 'node:crypto';
import type { WebPreferences } from 'electron';

/**
 * webPreferences for the user's webpage (S04.3, PLAN §8, AGENTS.md "Preview isolation"). Stricter than the
 * workbench: no preload at all, so the page has no bridge to IDE IPC. Pure factory so a unit test pins every value,
 * and the manager asserts them again before creating a view.
 */
export function createPreviewWebPreferences(partition: string): WebPreferences {
  return {
    partition,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    spellcheck: false,
    devTools: true,
  };
}

export const REQUIRED_PREVIEW_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
} as const satisfies Partial<WebPreferences>;

/** Names of required preview preferences that `prefs` violates, including any preload (empty array = isolated). */
export function insecurePreviewPreferences(prefs: WebPreferences): string[] {
  const bad = Object.entries(REQUIRED_PREVIEW_PREFERENCES)
    .filter(([key, value]) => prefs[key as keyof WebPreferences] !== value)
    .map(([key]) => key);
  if (prefs.preload !== undefined) bad.push('preload');
  if (typeof prefs.partition !== 'string' || !prefs.partition.startsWith(PARTITION_PREFIX)) bad.push('partition');
  return bad;
}

const PARTITION_PREFIX = 'persist:noobide-preview-';

/**
 * One browser session per project folder (PLAN §8: separate preview sessions and storage per project). Derived from
 * the real root path so the same folder gets the same storage across restarts, while the name holds no path text.
 * Electron keeps persistent partitions under the app-data directory, never in the project.
 */
export function partitionForProject(realRoot: string): string {
  return PARTITION_PREFIX + createHash('sha256').update(realRoot, 'utf8').digest('hex').slice(0, 32);
}
