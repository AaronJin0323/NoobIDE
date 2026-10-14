/**
 * Light / dark / follow-the-system theme choice (S24.4). The choice is a persisted setting (src/shared/settings,
 * app data); sessionStorage only keeps it across reloads of the workbench so the page does not flash the other
 * scheme before the stored setting arrives.
 */
import { isThemeChoice, type ThemeChoice } from '../../shared/settings';
import type { ColorScheme } from './tokens';

/** The scheme on screen: the explicit choice, or the system's when following it (dark unless it asks for light). */
export function resolveScheme(choice: ThemeChoice, systemPrefersLight: boolean): ColorScheme {
  if (choice === 'system') return systemPrefersLight ? 'light' : 'dark';
  return choice;
}

export interface ThemeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'noobide.theme';

export function loadThemeChoice(store: ThemeStore | undefined): ThemeChoice {
  try {
    const saved = store?.getItem(STORAGE_KEY);
    return isThemeChoice(saved) ? saved : 'system';
  } catch {
    return 'system';
  }
}

export function saveThemeChoice(store: ThemeStore | undefined, choice: ThemeChoice): void {
  try {
    store?.setItem(STORAGE_KEY, choice);
  } catch {
    // Not fatal: the choice still applies (and is persisted in settings).
  }
}
