/**
 * Platform-dependent labels (S03.2). Pure: takes the platform id instead of reading `process.platform`, so the
 * renderer can use it with the id that preload exposes (`window.noobide.platform`).
 */
export type PlatformId = 'mac' | 'windows' | 'other';

export const isMac = (id: PlatformId): boolean => id === 'mac';
export const isWindows = (id: PlatformId): boolean => id === 'windows';

/** The primary shortcut modifier as users see it: ⌘ on macOS, Ctrl elsewhere. */
export function modifierLabel(id: PlatformId): string {
  return isMac(id) ? '⌘' : 'Ctrl';
}

/** Shortcut text in each platform's convention: `⌘S` on macOS, `Ctrl+S` on Windows and Linux. */
export function shortcutLabel(id: PlatformId, key: string): string {
  return isMac(id) ? `${modifierLabel(id)}${key}` : `${modifierLabel(id)}+${key}`;
}

/** i18n key for "show in the file manager": Finder on macOS, File Explorer on Windows. */
export type RevealLabelKey = 'reveal.finder' | 'reveal.explorer' | 'reveal.fileManager';

export function revealLabelKey(id: PlatformId): RevealLabelKey {
  if (isMac(id)) return 'reveal.finder';
  if (isWindows(id)) return 'reveal.explorer';
  return 'reveal.fileManager';
}
