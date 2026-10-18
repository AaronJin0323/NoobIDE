import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { loadLocale, osLocale, saveLocale, translate, type Locale, type MessageKey } from './index';

interface I18nValue {
  locale: Locale;
  /** `count` picks the singular form of a counted message where the locale has one (see translate). */
  t: (key: MessageKey, count?: number) => string;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

function sessionStore(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => loadLocale(sessionStore(), osLocale()));

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // S13.1: the persisted setting (app data) is the source of truth; sessionStorage only avoids a flash on reload.
  // S59.2: with no saved choice main answers with the OS language's locale, the same one osLocale() starts with.
  // A choice the user makes before the stored value arrives wins over it.
  const chosen = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void window.noobide?.settings?.get().then((result) => {
      if (cancelled || chosen.current || !result.ok) return;
      saveLocale(sessionStore(), result.value.settings.locale);
      setLocaleState(result.value.settings.locale);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocale = useCallback((next: Locale) => {
    chosen.current = true;
    saveLocale(sessionStore(), next);
    setLocaleState(next);
    void window.noobide?.settings?.update({ locale: next }); // S13.1
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, t: (key: MessageKey, count?: number) => translate(locale, key, count) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside <I18nProvider>');
  return value;
}

/** S35: re-provides the workbench's value in a separate React root (the inline edit zone inside the code editor). */
export function I18nValueProvider({ value, children }: { value: I18nValue; children?: ReactNode }) {
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export type { I18nValue };
