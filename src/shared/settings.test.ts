import { describe, expect, it } from 'vitest';
import { LOCALES } from '../renderer/i18n/index';
import {
  DEFAULT_SETTINGS,
  SETTINGS_LOCALES,
  SETTINGS_VERSION,
  parseSettingsPatch,
  upgradeSettings,
  type SettingsMigration,
} from './settings';

describe('settings schema (S13.1)', () => {
  it('defaults: version, zh-CN, system theme, 16px, restore on', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      version: SETTINGS_VERSION,
      locale: 'zh-CN',
      theme: 'system',
      editorFontSize: 16,
      restoreSession: true,
    });
  });

  it('the stored locales are exactly the interface locales', () => {
    expect([...SETTINGS_LOCALES]).toEqual([...LOCALES]);
  });

  it('a current file is read as it is', () => {
    const file = { version: 1, locale: 'en', theme: 'dark', editorFontSize: 20, restoreSession: false };
    expect(upgradeSettings(file)).toEqual({ ok: true, settings: file, migratedFrom: null, resetFields: [] });
  });

  it('missing fields take their defaults; one invalid field never resets the others', () => {
    const result = upgradeSettings({ version: 1, locale: 'fr', editorFontSize: 99, restoreSession: false });
    expect(result).toEqual({
      ok: true,
      settings: { ...DEFAULT_SETTINGS, restoreSession: false },
      migratedFrom: null,
      resetFields: ['locale', 'editorFontSize'],
    });
  });

  it('unknown fields are dropped (only the schema is kept)', () => {
    const result = upgradeSettings({ version: 1, locale: 'en', password: 'x', lastFile: 'C:/secret' });
    expect(result.ok && result.settings).toEqual({ ...DEFAULT_SETTINGS, locale: 'en' });
  });

  it('a file without a version is version 0 and migrates to the current version', () => {
    const result = upgradeSettings({ locale: 'en' });
    expect(result).toEqual({
      ok: true,
      settings: { ...DEFAULT_SETTINGS, locale: 'en' },
      migratedFrom: 0,
      resetFields: [],
    });
  });

  it('runs a chain of migrations in order (v1 → v2 → v3)', () => {
    const steps: SettingsMigration[] = [
      { from: 2, migrate: (raw) => ({ ...raw, version: 3, editorFontSize: (raw.size as number) + 2 }) },
      { from: 1, migrate: ({ language, ...raw }) => ({ ...raw, version: 2, locale: language, size: 12 }) },
    ];
    const result = upgradeSettings({ version: 1, language: 'en' }, steps, 3);
    expect(result).toEqual({
      ok: true,
      settings: { ...DEFAULT_SETTINGS, locale: 'en', editorFontSize: 14 },
      migratedFrom: 1,
      resetFields: [],
    });
  });

  it('rejects what it cannot understand instead of guessing', () => {
    expect(upgradeSettings('just text')).toEqual({ ok: false, reason: 'not-an-object' });
    expect(upgradeSettings(null)).toEqual({ ok: false, reason: 'not-an-object' });
    expect(upgradeSettings([1, 2])).toEqual({ ok: false, reason: 'not-an-object' });
    expect(upgradeSettings({ version: 'one' })).toEqual({ ok: false, reason: 'bad-version' });
    expect(upgradeSettings({ version: -1 })).toEqual({ ok: false, reason: 'bad-version' });
    expect(upgradeSettings({ version: SETTINGS_VERSION + 1 })).toEqual({ ok: false, reason: 'newer-version' });
    expect(upgradeSettings({ version: 1 }, [], 2)).toEqual({ ok: false, reason: 'migration-failed' });
    const throwing: SettingsMigration = {
      from: 1,
      migrate: () => {
        throw new Error('boom');
      },
    };
    expect(upgradeSettings({ version: 1 }, [throwing], 2)).toEqual({ ok: false, reason: 'migration-failed' });
    const wrongVersion: SettingsMigration = { from: 1, migrate: (raw) => ({ ...raw, version: 5 }) };
    expect(upgradeSettings({ version: 1 }, [wrongVersion], 2)).toEqual({ ok: false, reason: 'migration-failed' });
  });

  it('the IPC patch accepts only known keys with valid values', () => {
    expect(parseSettingsPatch({ locale: 'en' })).toEqual({ locale: 'en' });
    expect(parseSettingsPatch({ theme: 'light', editorFontSize: 18 })).toEqual({ theme: 'light', editorFontSize: 18 });
    for (const bad of [
      {},
      null,
      'en',
      [],
      { locale: 'fr' },
      { version: 2 },
      { editorFontSize: 16.5 },
      { editorFontSize: 100 },
      { restoreSession: 'yes' },
      { locale: 'en', extra: 1 },
    ]) {
      expect(parseSettingsPatch(bad)).toBeNull();
    }
  });
});
