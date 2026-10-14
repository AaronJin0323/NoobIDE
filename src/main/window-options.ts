import type { BrowserWindowConstructorOptions, WebPreferences } from 'electron';

/**
 * Security-relevant webPreferences for the trusted workbench window (S02.2, PLAN §8, Electron security checklist).
 * Kept as a pure factory so a unit test can pin every value. The preview (user webpages) gets its own, stricter
 * factory in S04 with no preload at all.
 */
export function createWorkbenchWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
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
  };
}

/** The values that must never change without a decision record. Used by tests and by a startup assertion. */
export const REQUIRED_WORKBENCH_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
} as const satisfies Partial<WebPreferences>;

/** Returns the names of required preferences that `prefs` violates (empty array = secure). */
export function insecurePreferences(prefs: WebPreferences): string[] {
  return Object.entries(REQUIRED_WORKBENCH_PREFERENCES)
    .filter(([key, value]) => prefs[key as keyof WebPreferences] !== value)
    .map(([key]) => key);
}

export function createWorkbenchWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    title: 'NoobIDE',
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: createWorkbenchWebPreferences(preloadPath),
  };
}
