import { describe, expect, it } from 'vitest';
import { translate, type Locale, type MessageKey } from '../i18n/index';
import { failureText, undoFailureText } from './ProposalReview';
import { withKeyStore } from './ai-status';

const tr = (locale: Locale) => (key: MessageKey) => translate(locale, key);

describe('AI proposal failures never show internal error codes', () => {
  it('explains a failed write by its cause, like a failed save', () => {
    const zh = tr('zh-CN');
    const en = tr('en');
    expect(failureText(zh, { code: 'write-failed', detail: 'permission-denied' })).toBe(zh('save.error.permission'));
    expect(failureText(en, { code: 'write-failed', detail: 'disk-full' })).toBe(en('save.error.diskFull'));
    expect(failureText(en, { code: 'write-failed', detail: 'busy' })).toBe(en('save.error.busy'));
    expect(failureText(zh, { code: 'write-failed' })).toBe('没能写入文件。');
    expect(failureText(zh, undefined)).toBe('没能写入文件。');
    expect(failureText(en, { code: 'write-failed', detail: 'EWHATEVER' })).toBe('The file could not be written.');
    for (const locale of ['zh-CN', 'en'] as const) {
      for (const detail of [
        'permission-denied',
        'protected-folder',
        'busy',
        'disk-full',
        'not-found',
        'odd',
        undefined,
      ]) {
        const text = failureText(
          tr(locale),
          detail === undefined ? { code: 'write-failed' } : { code: 'write-failed', detail },
        );
        expect(text).not.toMatch(/permission-denied|protected-folder|disk-full|not-found|\(\?\)|（\?）|\{detail\}/);
      }
    }
  });

  it('other failures keep their own explanation, and undo uses the same text', () => {
    const en = tr('en');
    expect(failureText(en, { code: 'not-found', detail: 'ENOENT' })).toBe(en('agent.failure.not-found'));
    expect(undoFailureText(en, { code: 'write-failed', detail: 'permission-denied' })).toBe(
      en('save.error.permission'),
    );
    expect(undoFailureText(en, { code: 'changed-since' })).toBe(en('agent.undo.changed'));
  });
});

describe('where the API key is kept is named per platform', () => {
  it('macOS Keychain on a Mac, Windows Data Protection on Windows, generic elsewhere', () => {
    const zh = tr('zh-CN');
    const en = tr('en');
    expect(withKeyStore(zh('ai.state.noSecureStorage'), zh, 'mac')).toContain('macOS 钥匙串不可用');
    expect(withKeyStore(zh('ai.state.noSecureStorage'), zh, 'windows')).toContain('Windows 数据保护功能不可用');
    expect(withKeyStore(zh('ai.state.noKey'), zh, 'windows')).not.toContain('钥匙串');
    expect(withKeyStore(en('ai.settings.key.hint'), en, 'mac')).toContain('the macOS Keychain');
    expect(withKeyStore(en('ai.settings.key.hint'), en, 'windows')).toContain('Windows Data Protection');
    expect(withKeyStore(en('ai.settings.key.hint'), en, 'windows')).not.toMatch(/keychain/i);
    expect(withKeyStore(en('ai.settings.noSecureStorage'), en, 'other')).toContain('the system’s secure storage');
    expect(withKeyStore('no placeholder', en, 'mac')).toBe('no placeholder');
  });

  it('every text that mentions the key store uses the placeholder, in both locales', () => {
    const keys: MessageKey[] = [
      'ai.state.noKey',
      'ai.state.noSecureStorage',
      'ai.settings.key.hint',
      'ai.settings.key.error.no-secure-storage',
      'ai.settings.noSecureStorage',
    ];
    for (const locale of ['zh-CN', 'en'] as const) {
      for (const key of keys) {
        const text = translate(locale, key);
        expect(text, `${locale} ${key}`).toContain('{keyStore}');
        expect(text, `${locale} ${key}`).not.toMatch(/钥匙串|keychain/i);
      }
    }
  });
});
