import type { SettingsLocale } from './settings';

/**
 * S59.2 (owner decision H.4): the interface language on first run, before the user has chosen one. Any Chinese OS
 * language (zh, zh-CN, zh-Hans, zh-Hans-CN, zh-TW, zh-HK…) starts in zh-CN; every other language, or none known,
 * starts in en. Only the first (the OS's own) preferred language counts. A saved choice always wins over this: the
 * caller uses it only where no valid locale has been saved.
 *
 * Main passes `[app.getLocale()]` and the renderer `navigator.languages`; both follow the OS language (and the
 * `--lang` switch the e2e suite uses to pin zh-CN), so the two sides agree.
 */
export function localeFromOsLanguages(languages: readonly string[] | undefined | null): SettingsLocale {
  const first = languages?.find((language) => typeof language === 'string' && language.trim() !== '');
  return first !== undefined && /^zh(?:[-_]|$)/i.test(first.trim()) ? 'zh-CN' : 'en';
}
