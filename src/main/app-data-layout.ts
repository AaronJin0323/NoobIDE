import path from 'node:path';

/**
 * Where NoobIDE keeps its own data inside the app-data directory (`app.getPath('userData')`: `%APPDATA%\NoobIDE` on
 * Windows, `~/Library/Application Support/NoobIDE` on macOS). One place for the names so main.ts, the upgrade tests
 * (S28.4) and the user docs agree. Nothing here is ever written into a project folder (AGENTS.md); the only file
 * NoobIDE writes into a project is `.noobide/project.json`.
 *
 * The directory name comes from the product name, never from the version, so every version reads and writes the same
 * place: installing vN+1 over vN (Squirrel on Windows, replacing the app on macOS) keeps all of it, and uninstalling
 * the app leaves it in place (docs/decisions/0023-upgrade-and-uninstall.md).
 */
export const APP_DATA_ENTRIES = {
  /** Interface language, theme, font size, session restore (versioned, S13.1). */
  settings: 'settings.json',
  /** Recently opened project folders (S13.3). */
  recentProjects: 'recent-projects.json',
  /** Last open project, its tabs and the layout (S13.4). */
  session: 'session.json',
  /** Onboarding walkthrough progress (S23.1). */
  walkthrough: 'walkthrough.json',
  /** Preview trust (hashed folder paths) and one-time notes (S14.2/S14.4). */
  preview: 'preview.json',
  /** AI API keys, encrypted with Electron safeStorage (S31.2, decision 0025). Never plaintext. */
  aiKeys: 'ai-keys.json',
  /** AI settings: on/off, provider, models per purpose, inline completions (S31.3). */
  aiConfig: 'ai-config.json',
  /** Projects allowed to send code to the AI provider (hashed real roots, like preview trust) (S31.3). */
  aiConsent: 'ai-consent.json',
  /** Unsaved-edit journal for crash recovery (S12): one record per dirty buffer. */
  recovery: 'recovery',
  /** Local history: per-project indexes and content-addressed blobs (S21). */
  history: 'history',
  /** Rotating, content-free logs (S13.6). */
  logs: 'logs',
} as const;

export type AppDataEntry = keyof typeof APP_DATA_ENTRIES;

export function appDataPath(userData: string, entry: AppDataEntry): string {
  return path.join(userData, APP_DATA_ENTRIES[entry]);
}
