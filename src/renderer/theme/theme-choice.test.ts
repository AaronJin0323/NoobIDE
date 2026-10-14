import { describe, expect, it } from 'vitest';
import { loadThemeChoice, resolveScheme, saveThemeChoice, type ThemeStore } from './theme-choice';
import { zoomFontSize, DEFAULT_FONT_SIZE, MAX_FONT_SIZE, MIN_FONT_SIZE } from '../workbench/zoom';
import { EDITOR_FONT_SIZE, parseSettingsPatch, upgradeSettings } from '../../shared/settings';

const memory = (): ThemeStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

describe('theme choice (S24.4)', () => {
  it('follows the system only when asked to', () => {
    expect(resolveScheme('system', true)).toBe('light');
    expect(resolveScheme('system', false)).toBe('dark');
    expect(resolveScheme('light', false)).toBe('light');
    expect(resolveScheme('dark', true)).toBe('dark');
  });

  it('keeps the choice across reloads and ignores junk', () => {
    const store = memory();
    expect(loadThemeChoice(store)).toBe('system');
    saveThemeChoice(store, 'light');
    expect(loadThemeChoice(store)).toBe('light');
    store.data.set('noobide.theme', 'neon');
    expect(loadThemeChoice(store)).toBe('system');
    const broken: ThemeStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadThemeChoice(broken)).toBe('system');
    expect(() => saveThemeChoice(broken, 'dark')).not.toThrow();
  });

  it('theme and font zoom are settings fields that survive a reload of the file', () => {
    expect(parseSettingsPatch({ theme: 'dark' })).toEqual({ theme: 'dark' });
    expect(parseSettingsPatch({ theme: 'neon' })).toBeNull();
    expect(parseSettingsPatch({ editorFontSize: 20 })).toEqual({ editorFontSize: 20 });
    const loaded = upgradeSettings({ version: 1, theme: 'light', editorFontSize: 20 });
    expect(loaded).toMatchObject({ ok: true, settings: { theme: 'light', editorFontSize: 20 } });
  });

  it('zoom limits are the settings schema limits', () => {
    expect([MIN_FONT_SIZE, DEFAULT_FONT_SIZE, MAX_FONT_SIZE]).toEqual([
      EDITOR_FONT_SIZE.min,
      EDITOR_FONT_SIZE.default,
      EDITOR_FONT_SIZE.max,
    ]);
    expect(zoomFontSize(MAX_FONT_SIZE, 1)).toBe(MAX_FONT_SIZE);
    expect(parseSettingsPatch({ editorFontSize: zoomFontSize(MAX_FONT_SIZE, 1) })).not.toBeNull();
  });
});
