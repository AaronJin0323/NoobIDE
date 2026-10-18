import { describe, expect, it } from 'vitest';
import { en } from './en';
import { zhCN } from './zh-CN';
import { DEFAULT_LOCALE, loadLocale, osLocale, otherLocale, saveLocale, translate, type LocaleStore } from './index';

function memoryStore(): LocaleStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('i18n dictionaries', () => {
  it('zh-CN is the default locale', () => {
    expect(DEFAULT_LOCALE).toBe('zh-CN');
    expect(loadLocale(undefined)).toBe('zh-CN');
  });

  it('en defines exactly the zh-CN keys, all non-empty', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
    for (const [key, value] of [...Object.entries(zhCN), ...Object.entries(en)]) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it('translates per locale', () => {
    expect(translate('zh-CN', 'region.files')).toBe('文件');
    expect(translate('en', 'region.files')).toBe('Files');
    expect(otherLocale('zh-CN')).toBe('en');
  });
});

describe('locale persistence for the session (S02.5)', () => {
  it('round-trips through the store and ignores unknown values', () => {
    const store = memoryStore();
    saveLocale(store, 'en');
    expect(loadLocale(store)).toBe('en');
    store.data.set('noobide.locale', 'fr');
    expect(loadLocale(store)).toBe('zh-CN');
  });

  it('falls back to the default when storage throws', () => {
    const broken: LocaleStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadLocale(broken)).toBe('zh-CN');
    expect(() => saveLocale(broken, 'en')).not.toThrow();
  });
});

describe('first-run language from the OS (S59.2)', () => {
  it('maps the browser languages: zh* to zh-CN, anything else (or nothing) to en', () => {
    for (const zh of ['zh-CN', 'zh-Hans', 'zh-Hans-CN', 'zh-TW', 'zh-HK', 'zh']) expect(osLocale([zh])).toBe('zh-CN');
    expect(osLocale(['en-US'])).toBe('en');
    expect(osLocale(['fr'])).toBe('en');
    expect(osLocale([])).toBe('en');
  });

  it('the OS locale applies only when nothing is saved; a saved choice wins', () => {
    const store = memoryStore();
    expect(loadLocale(store, 'en')).toBe('en');
    expect(loadLocale(undefined, 'en')).toBe('en');
    saveLocale(store, 'zh-CN');
    expect(loadLocale(store, 'en')).toBe('zh-CN');
    saveLocale(store, 'en');
    expect(loadLocale(store, 'zh-CN')).toBe('en');
    store.data.set('noobide.locale', 'fr');
    expect(loadLocale(store, 'en')).toBe('en');
  });

  it('falls back to the OS locale when storage throws', () => {
    const broken: LocaleStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => undefined,
    };
    expect(loadLocale(broken, 'en')).toBe('en');
  });
});
