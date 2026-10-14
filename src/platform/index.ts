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

/**
 * The usual file-name case sensitivity of the platform's default volumes (NTFS and APFS: insensitive). Only a
 * fallback: src/workspace/paths probes the real volume, since a Mac can have a case-sensitive APFS volume and a
 * Windows folder can be marked case-sensitive (S07.1).
 */
export function defaultCaseSensitive(platform: NodeJS.Platform = process.platform): boolean {
  return platformId(platform) === 'other';
}

/** macOS re-creates a window when the dock icon is clicked and no windows are open (PLAN §3). */
export function recreatesWindowOnActivate(platform: NodeJS.Platform = process.platform): boolean {
  return platformId(platform) === 'mac';
}
