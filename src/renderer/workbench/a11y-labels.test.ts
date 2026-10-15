import { describe, expect, it } from 'vitest';
import { translate, type Locale, type MessageKey } from '../i18n/index';
import { indentButtonLabel } from './IndentStatus';
import { shouldReturnFocus } from './focus-trap';

const tr = (locale: Locale) => (key: MessageKey) => translate(locale, key);

describe('indentation status: the accessible name includes the mixed tabs/spaces warning', () => {
  it('names the warning when the file mixes tabs and spaces, in both languages', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      const t = tr(locale);
      const mixed = indentButtonLabel(t, { insertSpaces: true, tabSize: 2, source: 'detected', mixed: true });
      expect(mixed).toContain(t('smartEdit.indent.mixed'));
      expect(mixed).toContain(t('smartEdit.indent.source.detected'));
      const clean = indentButtonLabel(t, { insertSpaces: false, tabSize: 4, source: 'default', mixed: false });
      expect(clean).not.toContain(t('smartEdit.indent.mixed'));
      expect(clean).not.toMatch(/\{\w+\}/);
    }
    expect(indentButtonLabel(tr('en'), { insertSpaces: true, tabSize: 2, source: 'detected', mixed: true })).toBe(
      'Indentation: Spaces: 2 (detected from the file; this file mixes tabs and spaces). Press to change',
    );
  });
});

describe('dialogs give the focus back when they close', () => {
  const body = { isConnected: true } as unknown as Element;
  const opener = { isConnected: true, focus: () => undefined };
  it('returns it to a still-present opener when the focus was lost with the dialog', () => {
    expect(shouldReturnFocus(opener, body, body)).toBe(true);
    expect(shouldReturnFocus(opener, null, body)).toBe(true);
    expect(shouldReturnFocus(opener, { isConnected: false } as unknown as Element, body)).toBe(true);
  });

  it('never steals the focus from a control the user moved to, nor targets a gone or missing opener', () => {
    expect(shouldReturnFocus(opener, { isConnected: true } as unknown as Element, body)).toBe(false);
    expect(shouldReturnFocus({ isConnected: false, focus: () => undefined }, body, body)).toBe(false);
    expect(shouldReturnFocus(null, body, body)).toBe(false);
    expect(shouldReturnFocus(body, body, body)).toBe(false);
  });
});
