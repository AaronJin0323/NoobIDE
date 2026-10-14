/**
 * Platform adapter — the only module that may read `process.platform` (AGENTS.md invariant, enforced by ESLint).
 * Main process and preload only; the renderer gets the id from `window.noobide.platform` and uses labels.ts.
 * Grows in S24 (menus, shortcuts) and S25.
 */
import type { PlatformId } from './labels';

export type { PlatformId } from './labels';
export { isMac, isWindows, modifierLabel, revealLabelKey, shortcutLabel } from './labels';

export function platformId(platform: NodeJS.Platform = process.platform): PlatformId {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'windows';
  return 'other';
}

/** Windows (and Linux dev runs) exit when the last window closes; macOS keeps the app alive (PLAN §3). */
export function quitsWhenLastWindowCloses(platform: NodeJS.Platform = process.platform): boolean {
  return platformId(platform) !== 'mac';
}

/** macOS re-creates a window when the dock icon is clicked and no windows are open (PLAN §3). */
export function recreatesWindowOnActivate(platform: NodeJS.Platform = process.platform): boolean {
  return platformId(platform) === 'mac';
}

/**
 * Backoff (ms) for retrying a rename over a file that is briefly held open by another program. On Windows,
 * antivirus scanners, search indexers, sync clients and editors open files without FILE_SHARE_DELETE, so the rename
 * of a save fails with EPERM/EACCES/EBUSY for a moment (S10.1). POSIX renames do not hit this; no retries there.
 */
export function lockedRenameBackoffMs(platform: NodeJS.Platform = process.platform): readonly number[] {
  return platformId(platform) === 'windows' ? [25, 50, 100, 200, 400] : [];
}

/** Whether a directory can be opened and fsynced so a completed rename survives a power loss (not on Windows). */
export function canSyncDirectory(platform: NodeJS.Platform = process.platform): boolean {
  return platformId(platform) !== 'windows';
}
