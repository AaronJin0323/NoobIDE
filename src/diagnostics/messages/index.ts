import type { MessageRef } from '../../shared/problem';
import { en } from './en';
import { zhCN, type DiagnosticsMessageKey } from './zh-CN';

export type { DiagnosticsMessageKey };

/** Same locale ids as the renderer's i18n (zh-CN default, en required). */
export type DiagnosticsLocale = 'zh-CN' | 'en';

export const DIAGNOSTICS_MESSAGES: Record<DiagnosticsLocale, Record<DiagnosticsMessageKey, string>> = {
  'zh-CN': zhCN,
  en,
};

/** Typed constructor: rules can only reference keys that exist in the dictionaries. */
export function msg(key: DiagnosticsMessageKey, params?: Readonly<Record<string, string | number>>): MessageRef {
  return params ? { key, params } : { key };
}

export function isDiagnosticsMessageKey(key: string): key is DiagnosticsMessageKey {
  return Object.prototype.hasOwnProperty.call(zhCN, key);
}

/**
 * Fills `{param}` placeholders. Param values are inserted as plain text (the UI renders text, never HTML).
 * An unknown key renders as the key itself so a bad reference is visible rather than silently empty.
 */
export function formatMessage(locale: DiagnosticsLocale, ref: MessageRef): string {
  const template = isDiagnosticsMessageKey(ref.key) ? DIAGNOSTICS_MESSAGES[locale][ref.key] : ref.key;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = ref.params?.[name];
    return v === undefined ? whole : String(v);
  });
}
