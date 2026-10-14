import { quitsWhenLastWindowCloses, recreatesWindowOnActivate } from '../platform/index';

/** The parts of Electron's `app` the lifecycle uses (an EventEmitter in tests). */
export interface LifecycleApp {
  on(event: 'window-all-closed' | 'activate' | 'second-instance', listener: () => void): unknown;
  quit(): void;
}

export interface LifecycleDeps {
  readonly platform?: NodeJS.Platform;
  windowCount(): number;
  createWindow(): void;
  /** Restores and focuses the first window (a second launch of the app). */
  focusFirstWindow(): void;
}

/**
 * Window lifecycle by platform convention (S24.2, PLAN §3): on Windows (and Linux dev runs) the app exits when its
 * last window closes; on macOS it keeps running in the dock, and clicking the dock icon (activate) or launching it
 * again opens a new window when none is open.
 */
export function installWindowLifecycle(app: LifecycleApp, deps: LifecycleDeps): void {
  app.on('window-all-closed', () => {
    if (quitsWhenLastWindowCloses(deps.platform)) app.quit();
  });
  app.on('activate', () => {
    if (recreatesWindowOnActivate(deps.platform) && deps.windowCount() === 0) deps.createWindow();
  });
  app.on('second-instance', () => {
    if (deps.windowCount() === 0) deps.createWindow();
    else deps.focusFirstWindow();
  });
}
