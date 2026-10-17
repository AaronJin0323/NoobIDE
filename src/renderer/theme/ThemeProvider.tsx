import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { DensityChoice, ThemeChoice } from '../../shared/settings';
import { loadDensity, saveDensity } from './density';
import { cssVariables, type ColorScheme } from './tokens';
import { useMediaQuery } from './useMediaQuery';
import { loadThemeChoice, resolveScheme, saveThemeChoice } from './theme-choice';

const ThemeContext = createContext<ColorScheme>('dark');

interface ThemeChoiceValue {
  readonly choice: ThemeChoice;
  setChoice(choice: ThemeChoice): void;
}

const ThemeChoiceContext = createContext<ThemeChoiceValue>({ choice: 'system', setChoice: () => undefined });

interface DensityValue {
  readonly density: DensityChoice;
  setDensity(density: DensityChoice): void;
}

const DensityContext = createContext<DensityValue>({ density: 'comfortable', setDensity: () => undefined });

function sessionStore(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Applies the colour theme (S30.1, S24.4): light, dark, or the system's scheme (light only when the system asks for
 * light, dark otherwise). The choice is persisted in the app settings. Writes the tokens onto <html> as custom
 * properties before paint, so the stylesheet never holds colour values of its own.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemLight = useMediaQuery('(prefers-color-scheme: light)');
  const [choice, setChoiceState] = useState<ThemeChoice>(() => loadThemeChoice(sessionStore()));
  const scheme = resolveScheme(choice, systemLight);
  const [density, setDensityState] = useState<DensityChoice>(() => loadDensity(sessionStore()));

  // The persisted setting is the source of truth; a choice made before it arrives wins over it.
  const chosen = useRef(false);
  const densityChosen = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void window.noobide?.settings?.get().then((result) => {
      if (cancelled || !result.ok) return;
      if (!chosen.current) {
        saveThemeChoice(sessionStore(), result.value.settings.theme);
        setChoiceState(result.value.settings.theme);
      }
      if (!densityChosen.current) {
        saveDensity(sessionStore(), result.value.settings.density);
        setDensityState(result.value.settings.density);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setChoice = useCallback((next: ThemeChoice) => {
    chosen.current = true;
    saveThemeChoice(sessionStore(), next);
    setChoiceState(next);
    void window.noobide?.settings?.update({ theme: next });
  }, []);

  const setDensity = useCallback((next: DensityChoice) => {
    densityChosen.current = true;
    saveDensity(sessionStore(), next);
    setDensityState(next);
    void window.noobide?.settings?.update({ density: next });
  }, []);

  // S50.4: data-density on <html> selects the control, row and radius tokens (styles.css).
  useLayoutEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  const previousScheme = useRef<ColorScheme | null>(null);
  useLayoutEffect(() => {
    const root = document.documentElement;
    // S40.4: a theme switch is instant. Without this, every control's hover transition would fade its colours from
    // the old theme to the new one at its own speed, and the window would look uneven for a moment.
    let frame = 0;
    if (previousScheme.current !== null && previousScheme.current !== scheme) {
      root.dataset.themeSwitching = '';
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => delete root.dataset.themeSwitching);
      });
    }
    previousScheme.current = scheme;
    for (const [name, value] of Object.entries(cssVariables(scheme))) root.style.setProperty(name, value);
    root.style.colorScheme = scheme;
    root.dataset.theme = scheme;
    root.dataset.themeChoice = choice;
    return () => {
      if (frame === 0) return;
      cancelAnimationFrame(frame);
      delete root.dataset.themeSwitching;
    };
  }, [scheme, choice]);

  const choiceValue = useMemo(() => ({ choice, setChoice }), [choice, setChoice]);
  const densityValue = useMemo(() => ({ density, setDensity }), [density, setDensity]);
  return (
    <ThemeChoiceContext.Provider value={choiceValue}>
      <DensityContext.Provider value={densityValue}>
        <ThemeContext.Provider value={scheme}>{children}</ThemeContext.Provider>
      </DensityContext.Provider>
    </ThemeChoiceContext.Provider>
  );
}

export function useColorScheme(): ColorScheme {
  return useContext(ThemeContext);
}

/** S50.4: the interface density and how to change it. */
export function useDensity(): DensityValue {
  return useContext(DensityContext);
}

/** S24.4: the user's theme choice (system / light / dark) and how to change it. */
export function useThemeChoice(): ThemeChoiceValue {
  return useContext(ThemeChoiceContext);
}
