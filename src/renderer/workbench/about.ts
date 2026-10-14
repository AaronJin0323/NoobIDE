/**
 * S28.1 About dialog: how it is opened and what it shows.
 *
 * Anything (the S24 command registry / menus, a keyboard shortcut) opens it with `openAbout()`; the workbench hosts
 * the dialog and hides the native preview view while it is open, like its other modal windows.
 */
export const OPEN_ABOUT_EVENT = 'noobide:open-about';

export function openAbout(target: EventTarget = window): void {
  target.dispatchEvent(new Event(OPEN_ABOUT_EVENT));
}

export interface AboutVersions {
  /** The app version: package.json "version", the same value Electron reports as app.getVersion(). */
  readonly app: string;
  readonly electron: string | null;
  readonly chromium: string | null;
}

/** Runtime versions from the renderer's user agent ("… Chrome/x.y.z.w Electron/a.b.c …"). Null when missing. */
export function aboutVersions(appVersion: string, userAgent: string): AboutVersions {
  const electron = /\bElectron\/([0-9][0-9A-Za-z.-]*)/.exec(userAgent)?.[1] ?? null;
  const chromium = /\bChrome\/([0-9][0-9.]*)/.exec(userAgent)?.[1] ?? null;
  return { app: appVersion, electron, chromium };
}

/** One line for bug reports, e.g. "NoobIDE 0.1.0 (Electron 44.7.0, Chromium 140.0.0.0)". */
export function aboutLine(v: AboutVersions): string {
  const runtime = [v.electron && `Electron ${v.electron}`, v.chromium && `Chromium ${v.chromium}`].filter(Boolean);
  return `NoobIDE ${v.app}${runtime.length ? ` (${runtime.join(', ')})` : ''}`;
}
