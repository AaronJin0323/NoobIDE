import { describe, expect, it } from 'vitest';
import { localeFromOsLanguages } from './os-locale';

describe('first-run interface language from the OS language (S59.2)', () => {
  it.each(['zh-CN', 'zh-Hans', 'zh-Hans-CN', 'zh-TW', 'zh-HK', 'zh', 'zh_CN', 'ZH-cn'])('%s starts in zh-CN', (os) => {
    expect(localeFromOsLanguages([os])).toBe('zh-CN');
  });

  it.each(['en-US', 'en', 'fr', 'fr-FR', 'ja-JP', 'de', 'zu', 'zhx'])('%s starts in en', (os) => {
    expect(localeFromOsLanguages([os])).toBe('en');
  });

  it('starts in en when no OS language is known', () => {
    expect(localeFromOsLanguages([])).toBe('en');
    expect(localeFromOsLanguages(undefined)).toBe('en');
    expect(localeFromOsLanguages(null)).toBe('en');
    expect(localeFromOsLanguages(['', '  '])).toBe('en');
  });

  it('uses the first (primary) OS language', () => {
    expect(localeFromOsLanguages(['zh-TW', 'en-US'])).toBe('zh-CN');
    expect(localeFromOsLanguages(['en-US', 'zh-CN'])).toBe('en');
    expect(localeFromOsLanguages(['', 'zh-CN'])).toBe('zh-CN');
  });
});
