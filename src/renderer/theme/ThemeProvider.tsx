import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ThemeChoice } from '../../shared/settings';
import { cssVariables, type ColorScheme } from './tokens';
import { useMediaQuery } from './useMediaQuery';
import { loadThemeChoice, resolveScheme, saveThemeChoice } from './theme-choice';

const ThemeContext = createContext<ColorScheme>('dark');

interface ThemeChoiceValue {
  readonly choice: ThemeChoice;
  setChoice(choice: ThemeChoice): void;
}

const ThemeChoiceContext = createContext<ThemeChoiceValue>({ choice: 'system', setChoice: () => undefined });

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

  // The persisted setting is the source of truth; a choice made before it arrives wins over it.
  const chosen = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void window.noobide?.settings?.get().then((result) => {
      if (cancelled || chosen.current || !result.ok) return;
      saveThemeChoice(sessionStore(), result.value.settings.theme);
      setChoiceState(result.value.settings.theme);
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

  useLayoutEffect(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(cssVariables(scheme))) root.style.setProperty(name, value);
    root.style.colorScheme = scheme;
    root.dataset.theme = scheme;
    root.dataset.themeChoice = choice;
  }, [scheme, choice]);

  const choiceValue = useMemo(() => ({ choice, setChoice }), [choice, setChoice]);
  return (
    <ThemeChoiceContext.Provider value={choiceValue}>
      <ThemeContext.Provider value={scheme}>{children}</ThemeContext.Provider>
    </ThemeChoiceContext.Provider>
  );
}

export function useColorScheme(): ColorScheme {
  return useContext(ThemeContext);
}

/** S24.4: the user's theme choice (system / light / dark) and how to change it. */
export function useThemeChoice(): ThemeChoiceValue {
  return useContext(ThemeChoiceContext);
}
