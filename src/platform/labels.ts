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

/** S18.3: Monaco's "Format Document" shortcut as each platform writes it. */
export function formatShortcutLabel(id: PlatformId): string {
  return isMac(id) ? '⇧⌥F' : 'Shift+Alt+F';
}

/** i18n key for "show in the file manager": Finder on macOS, File Explorer on Windows. */
export type RevealLabelKey = 'reveal.finder' | 'reveal.explorer' | 'reveal.fileManager';

export function revealLabelKey(id: PlatformId): RevealLabelKey {
  if (isMac(id)) return 'reveal.finder';
  if (isWindows(id)) return 'reveal.explorer';
  return 'reveal.fileManager';
}

// ── S08: file tree commands ────────────────────────────────────────────────────────────────────────────────────

/** i18n key for the OS trash: the Recycle Bin on Windows, the Trash on macOS. */
export type TrashLabelKey = 'trash.windows' | 'trash.mac' | 'trash.other';

export function trashLabelKey(id: PlatformId): TrashLabelKey {
  if (isMac(id)) return 'trash.mac';
  if (isWindows(id)) return 'trash.windows';
  return 'trash.other';
}

export type TreeCommand = 'rename' | 'delete' | 'reveal';

/** Shortcut text shown in the file tree's menu: Finder conventions on macOS, File Explorer / VS Code on Windows. */
export function treeShortcutLabel(id: PlatformId, command: TreeCommand): string {
  switch (command) {
    case 'rename':
      return 'F2';
    case 'delete':
      return isMac(id) ? '⌘⌫' : 'Delete';
    case 'reveal':
      return isMac(id) ? '⌥⌘R' : 'Shift+Alt+R';
  }
}

/** Whether a keydown in the file tree triggers a command. `key` and modifiers as in KeyboardEvent. */
export function treeCommandForKey(
  id: PlatformId,
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
): TreeCommand | null {
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  if (e.key === 'F2' && plain) return 'rename';
  if (e.key === 'Delete' && plain) return 'delete';
  if (isMac(id) && e.key === 'Backspace' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return 'delete';
  const r = e.key.toLowerCase() === 'r' || e.key === '®';
  if (isMac(id) && r && e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey) return 'reveal';
  if (!isMac(id) && r && e.shiftKey && e.altKey && !e.ctrlKey && !e.metaKey) return 'reveal';
  return null;
}

// ── S25.3: OS privacy protection ───────────────────────────────────────────────────────────────────────────────

/** i18n key explaining that the OS privacy protection blocked a folder, with the platform's way to allow NoobIDE. */
export type ProtectedFolderKey = 'protected.mac' | 'protected.windows' | 'protected.other';

export function protectedFolderKey(id: PlatformId): ProtectedFolderKey {
  if (isMac(id)) return 'protected.mac';
  if (isWindows(id)) return 'protected.windows';
  return 'protected.other';
}
