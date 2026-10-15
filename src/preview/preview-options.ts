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
    // S05.5: alert/confirm/prompt/beforeunload never open a dialog; a page cannot block the IDE with one.
    disableDialogs: true,
    spellcheck: false,
    devTools: true,
    // S25.4: no Web Bluetooth. On macOS, navigator.bluetooth.requestDevice() makes Chromium open CoreBluetooth in
    // the main process before any permission handler runs; the system then ends the whole IDE for a privacy
    // violation (no Bluetooth usage description). The page sees no navigator.bluetooth, as in Firefox/Safari.
    disableBlinkFeatures: PREVIEW_DISABLED_BLINK_FEATURES,
  };
}

export const PREVIEW_DISABLED_BLINK_FEATURES = 'WebBluetooth';

/**
 * Chromium features switched off for the whole app (`--disable-features`, set by main before it is ready).
 * IsolateSandboxedIframes: Chromium would give a sandboxed `srcdoc` iframe its own process and start its scripts
 * before a DevTools protocol client can install the console limit there (the frame does not wait for the debugger,
 * decision 0016, second amendment); kept in the page's process it gets the limit like every other frame. The preview
 * already runs in its own sandboxed process, apart from the IDE, so this costs no isolation from the IDE.
 */
export const DISABLED_CHROMIUM_FEATURES = 'IsolateSandboxedIframes';

/**
 * Chromium switches without a value, set for the whole app by main before it is ready (S05.8).
 * disable-renderer-backgrounding: Chromium lowers the OS priority of a renderer process with no visible page
 * (Windows: Idle priority class; macOS: background QoS). A new preview view gets its page guard (decision 0016) while
 * it is not yet in the window, so its renderer started backgrounded; with the CPU busy it got almost no CPU and the
 * guard's DevTools commands went unanswered for 45 s (macOS CI runner, 3 cores), leaving the page unguarded. With the
 * switch every renderer keeps the priority it was launched with. Page visibility (document.hidden), rAF and timer
 * throttling of a hidden preview are unchanged. Also not lowered for a hidden or minimised IDE: Chromium's renderer
 * "backgrounded" mode (V8 memory-saving GC, background memory purge, Windows memory priority) — a small cost for one
 * workbench and one preview. A hidden preview in an endless loop competes at normal priority, as a visible one does.
 */
export const CHROMIUM_SWITCHES = ['disable-renderer-backgrounding'] as const;

export const REQUIRED_PREVIEW_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  disableDialogs: true,
  disableBlinkFeatures: PREVIEW_DISABLED_BLINK_FEATURES,
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
