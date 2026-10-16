import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions, WebPreferences } from 'electron';
import { THEMES, type ColorScheme } from '../renderer/theme/tokens';
import type { ThemeChoice } from '../shared/settings';
import { isMac, isWindows, type PlatformId } from '../platform/labels';

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

/** The window's first size when the screen allows it; 1280×800 was too short for editor, preview and walkthrough. */
export const PREFERRED_WINDOW = { width: 1440, height: 900 } as const;
export const FALLBACK_WINDOW = { width: 1280, height: 800 } as const;
export const MIN_WINDOW = { width: 640, height: 480 } as const;

/**
 * The first window size: PREFERRED_WINDOW, but never larger than the display's work area (the screen without the
 * taskbar / Dock and menu bar) and never below the minimum size. Without a work area (not known): 1280×800.
 */
export function defaultWindowSize(workArea?: { readonly width: number; readonly height: number }): {
  width: number;
  height: number;
} {
  if (!workArea || !(workArea.width > 0) || !(workArea.height > 0)) return { ...FALLBACK_WINDOW };
  const fit = (preferred: number, available: number, min: number) =>
    Math.max(min, Math.min(preferred, Math.floor(available)));
  return {
    width: fit(PREFERRED_WINDOW.width, workArea.width, MIN_WINDOW.width),
    height: fit(PREFERRED_WINDOW.height, workArea.height, MIN_WINDOW.height),
  };
}

/**
 * The colour scheme of the native window background (S46): the saved theme choice (S24.4), where 'system'
 * follows the OS setting. The renderer resolves the same choice, so the first paint matches the window behind it.
 */
export function windowColorScheme(theme: ThemeChoice, systemDark: boolean): ColorScheme {
  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return theme;
}

/** Height of the workbench top bar (`--topbar-h` in styles.css): the integrated title bar is exactly this tall. */
export const TITLE_BAR_HEIGHT = 52;

/**
 * Windows: the caption buttons (minimise, maximise, close) drawn over the top bar's right end, in the theme's colours
 * so they read as part of the workbench instead of a native strip in the OS colour scheme.
 */
export function titleBarOverlay(scheme: ColorScheme): TitleBarOverlayOptions {
  return { color: THEMES[scheme].bg, symbolColor: THEMES[scheme].text, height: TITLE_BAR_HEIGHT };
}

/**
 * The window frame: on Windows and macOS the native title bar is hidden and the workbench top bar takes its place
 * (it is the drag area; window controls are the themed overlay on Windows and the inset traffic lights on macOS).
 * Elsewhere the native frame stays.
 */
export function workbenchFrameOptions(platform: PlatformId, scheme: ColorScheme): BrowserWindowConstructorOptions {
  if (isWindows(platform)) return { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(scheme) };
  // Traffic lights (12 px buttons) centred vertically in the top bar.
  if (isMac(platform)) return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 20 } };
  return {};
}

export function createWorkbenchWindowOptions(
  preloadPath: string,
  workArea?: { readonly width: number; readonly height: number },
  scheme: ColorScheme = 'light',
  platform: PlatformId = 'other',
): BrowserWindowConstructorOptions {
  return {
    title: 'NoobIDE',
    ...defaultWindowSize(workArea),
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    // The window background is the theme's `bg`, so a dark window never flashes white before the first paint.
    backgroundColor: THEMES[scheme].bg,
    ...workbenchFrameOptions(platform, scheme),
    webPreferences: createWorkbenchWebPreferences(preloadPath),
  };
}
