import { describe, expect, it } from 'vitest';
import { translate, type Locale, type MessageKey } from '../i18n/index';
import { indentButtonLabel } from './IndentStatus';
import { shouldReturnFocus } from './focus-trap';
import { saveButtonShown } from './TopBar';
import { tabTooltip } from './TabBar';

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

describe('key features keep a visible, labelled control', () => {
  it('S47.3: offers the Save button only while a save cannot happen on its own', () => {
    expect(saveButtonShown('failed')).toBe(true); // saving again is the way out of a failed save
    expect(saveButtonShown('conflict')).toBe(true); // the user must decide (the command takes them to the banner)
    expect(saveButtonShown('deleted')).toBe(true);
    // Ordinary typing with autosave on: the state word changes in its slot, no button flashes.
    for (const state of ['clean', 'dirty', 'saving', 'saved', null] as const) {
      expect(saveButtonShown(state)).toBe(false);
    }
    // A retry in flight after a failed write keeps the button (and the focus the user gave it); any other write
    // in flight shows the state word only.
    expect(saveButtonShown('saving', true, true)).toBe(true);
    expect(saveButtonShown('saving', true, false)).toBe(false);
    // Autosave off: unsaved edits need the user, so the button is offered.
    expect(saveButtonShown('dirty', false)).toBe(true);
    for (const state of ['clean', 'saving', 'saved', null] as const) {
      expect(saveButtonShown(state, false)).toBe(false);
    }
  });

  it('S47.3: the save pill words are short in both languages; the sentence is in the banner', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      for (const key of [
        'save.clean',
        'save.dirty',
        'save.saving',
        'save.saved',
        'save.failed',
        'save.conflict',
        'save.deleted',
        'topbar.saveStatus.noFile',
      ] as const) {
        const word = translate(locale, key);
        expect(word.length, `${locale} ${key}`).toBeLessThanOrEqual(locale === 'en' ? 16 : 8);
        expect(word, `${locale} ${key}`).not.toMatch(/—|。|\./);
      }
      // The explanation of a failed save is a full sentence in the banner, not in the pill.
      expect(translate(locale, 'save.kept').length).toBeGreaterThan(translate(locale, 'save.failed').length);
    }
  });

  it('S47.3: a tab names its state in the tooltip, after the path', () => {
    expect(tabTooltip('src/app.js', null)).toBe('src/app.js');
    expect(tabTooltip('src/app.js', '未保存')).toBe('src/app.js · 未保存');
  });

  it('names the Lessons rail button and its tooltip in both languages', () => {
    expect(translate('zh-CN', 'rail.lessons')).toBe('课程');
    expect(translate('en', 'rail.lessons')).toBe('Lessons');
    for (const locale of ['zh-CN', 'en'] as const) {
      expect(translate(locale, 'rail.lessons.title').length).toBeGreaterThan(translate(locale, 'rail.lessons').length);
    }
  });
});
