import { describe, expect, it } from 'vitest';
import { translate, type Locale, type MessageKey } from '../i18n/index';
import { loadFailedKey, noticeText } from './console-notice';

const tr = (locale: Locale) => (key: MessageKey) => translate(locale, key);

describe('console notices for blocked links and failed loads', () => {
  it('explains a blocked link in the user’s language and names the real “Open in browser” button', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      const t = tr(locale);
      for (const how of ['navigate', 'new-window'] as const) {
        const { text, detail } = noticeText({ kind: 'link-blocked', how }, 'navigation blocked', t);
        expect(text).toContain(`“${t('preview.openExternal')}”`);
        expect(text).not.toContain('{button}');
        expect(text).not.toMatch(/navigation blocked|window\.open blocked/);
        expect(detail).toBeUndefined();
      }
    }
    expect(noticeText({ kind: 'link-blocked', how: 'navigate' }, '', tr('zh-CN')).text).toContain('只显示这个项目');
    expect(noticeText({ kind: 'link-blocked', how: 'new-window' }, '', tr('en')).text).toContain('new windows');
  });

  it('maps common Chromium load errors to a friendly explanation and keeps the raw code as detail', () => {
    expect(loadFailedKey(-102)).toBe('preview.notice.loadFailed.server');
    expect(loadFailedKey(-118)).toBe('preview.notice.loadFailed.timeout');
    expect(loadFailedKey(-6)).toBe('preview.notice.loadFailed.notFound');
    expect(loadFailedKey(-105)).toBe('preview.notice.loadFailed.offline');
    expect(loadFailedKey(-20)).toBe('preview.notice.loadFailed.blocked');
    expect(loadFailedKey(-999)).toBe('preview.notice.loadFailed.other');
    const t = tr('zh-CN');
    const refused = noticeText({ kind: 'load-failed', code: -102 }, 'ERR_CONNECTION_REFUSED', t);
    expect(refused.text).toBe(t('preview.notice.loadFailed.server'));
    expect(refused.text).not.toContain('ERR_');
    expect(refused.detail).toBe('ERR_CONNECTION_REFUSED');
    expect(noticeText({ kind: 'load-failed', code: -3 }, '  ', t).detail).toBeUndefined();
  });

  it('still explains the existing notices', () => {
    const t = tr('en');
    expect(noticeText({ kind: 'permission-denied', permission: 'camera' }, '', t).text).toContain('camera');
    expect(noticeText({ kind: 'console-flood-stopped' }, '', t).text).toBe(t('preview.notice.consoleFloodStopped'));
  });
});
