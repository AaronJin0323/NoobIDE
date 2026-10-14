/**
 * Platform adapter — the only module that may read `process.platform` (AGENTS.md invariant, enforced by ESLint).
 * Main-process only. Grows in S03 (filesystem quirks, app-data), S24 (menus, shortcuts) and S25.
 */
export type PlatformId = 'mac' | 'windows' | 'other';

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
