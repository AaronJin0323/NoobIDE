import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { loadLocale, saveLocale, translate, type Locale, type MessageKey } from './index';

interface I18nValue {
  locale: Locale;
  t: (key: MessageKey) => string;
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
  const [locale, setLocaleState] = useState<Locale>(() => loadLocale(sessionStore()));

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // S13.1: the persisted setting (app data) is the source of truth; sessionStorage only avoids a flash on reload.
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
    () => ({ locale, setLocale, t: (key: MessageKey) => translate(locale, key) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside <I18nProvider>');
  return value;
}
