/**
 * S50.4: the interface density (comfortable / compact). The choice is a persisted setting (src/shared/settings, app
 * data); sessionStorage only keeps it across reloads of the workbench so the window does not jump between densities
 * before the stored setting arrives. It is applied as `data-density` on <html>, which selects --control-h, --row-h
 * and --radius-control in styles.css.
 */
import { isDensityChoice, type DensityChoice } from '../../shared/settings';
import type { ThemeStore } from './theme-choice';

const STORAGE_KEY = 'noobide.density';

export function loadDensity(store: ThemeStore | undefined): DensityChoice {
  try {
    const saved = store?.getItem(STORAGE_KEY);
    return isDensityChoice(saved) ? saved : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

export function saveDensity(store: ThemeStore | undefined, density: DensityChoice): void {
  try {
    store?.setItem(STORAGE_KEY, density);
  } catch {
    // Not fatal: the density still applies (and is persisted in settings).
  }
}

/** The tokens each density selects (mirrors styles.css; unit-tested against it). */
export const DENSITY_TOKENS: Readonly<Record<DensityChoice, Readonly<Record<string, string>>>> = {
  comfortable: { '--control-h': '32px', '--row-h': '32px', '--radius-control': '8px' },
  compact: { '--control-h': '28px', '--row-h': '28px', '--radius-control': '6px' },
};
