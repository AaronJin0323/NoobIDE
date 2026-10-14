import { en } from './en';
import { zhCN, type MessageKey } from './zh-CN';

export type { MessageKey };
export type Locale = 'zh-CN' | 'en';

export const DEFAULT_LOCALE: Locale = 'zh-CN';
export const LOCALES: readonly Locale[] = ['zh-CN', 'en'];

const dictionaries: Record<Locale, Record<MessageKey, string>> = { 'zh-CN': zhCN, en };

export function translate(locale: Locale, key: MessageKey): string {
  return dictionaries[locale][key];
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function otherLocale(locale: Locale): Locale {
  return locale === 'zh-CN' ? 'en' : 'zh-CN';
}

/** Minimal storage surface so tests can pass a fake; the app passes window.sessionStorage. */
export interface LocaleStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'noobide.locale';

/**
 * The language choice lasts for the app session (S02.5). Persistent settings arrive in S13; until then
 * sessionStorage survives reloads of the workbench but not an app restart. Storage errors fall back to the default.
 */
export function loadLocale(store: LocaleStore | undefined): Locale {
  try {
    const saved = store?.getItem(STORAGE_KEY);
    return isLocale(saved) ? saved : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function saveLocale(store: LocaleStore | undefined, locale: Locale): void {
  try {
    store?.setItem(STORAGE_KEY, locale);
  } catch {
    // Not fatal: the choice still applies until the next reload.
  }
}
