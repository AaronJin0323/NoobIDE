import { describe, expect, it } from 'vitest';
import { en } from './en';
import { zhCN } from './zh-CN';
import { DEFAULT_LOCALE, loadLocale, otherLocale, saveLocale, translate, type LocaleStore } from './index';

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
