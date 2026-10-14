import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react';
import { cssVariables, type ColorScheme } from './tokens';
import { useMediaQuery } from './useMediaQuery';

const ThemeContext = createContext<ColorScheme>('dark');

/**
 * Follows the system colour scheme (S30.1): light only when the system asks for light, dark otherwise. Writes the
 * tokens onto <html> as custom properties before paint, so the stylesheet never holds colour values of its own.
 * A persisted light/dark/system choice arrives with settings (S24.4).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme: ColorScheme = useMediaQuery('(prefers-color-scheme: light)') ? 'light' : 'dark';

  useLayoutEffect(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(cssVariables(scheme))) root.style.setProperty(name, value);
    root.style.colorScheme = scheme;
    root.dataset.theme = scheme;
  }, [scheme]);

  return <ThemeContext.Provider value={scheme}>{children}</ThemeContext.Provider>;
}

export function useColorScheme(): ColorScheme {
  return useContext(ThemeContext);
}
