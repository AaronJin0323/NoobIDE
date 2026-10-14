import { describe, expect, it } from 'vitest';
import { isMac, isWindows, modifierLabel, revealLabelKey, shortcutLabel } from './labels';
import { platformId } from './index';

describe('platform labels (S03.2)', () => {
  it('identifies the two supported platforms', () => {
    expect(isMac(platformId('darwin'))).toBe(true);
    expect(isWindows(platformId('darwin'))).toBe(false);
    expect(isWindows(platformId('win32'))).toBe(true);
    expect(isMac(platformId('win32'))).toBe(false);
    expect(isMac(platformId('linux')) || isWindows(platformId('linux'))).toBe(false);
  });

  it('renders modifiers and shortcuts in each platform convention', () => {
    expect(modifierLabel('mac')).toBe('⌘');
    expect(modifierLabel('windows')).toBe('Ctrl');
    expect(shortcutLabel('mac', 'S')).toBe('⌘S');
    expect(shortcutLabel('windows', 'S')).toBe('Ctrl+S');
    expect(shortcutLabel('other', 'S')).toBe('Ctrl+S');
  });

  it('names the file manager each platform uses', () => {
    expect(revealLabelKey('mac')).toBe('reveal.finder');
    expect(revealLabelKey('windows')).toBe('reveal.explorer');
    expect(revealLabelKey('other')).toBe('reveal.fileManager');
  });
});
