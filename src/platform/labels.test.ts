import { describe, expect, it } from 'vitest';
import {
  formatShortcutLabel,
  isMac,
  isWindows,
  modifierLabel,
  revealLabelKey,
  shortcutLabel,
  trashLabelKey,
  treeCommandForKey,
  treeShortcutLabel,
} from './labels';
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

describe('file tree commands (S08.3, S08.5)', () => {
  const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it('names the trash per platform', () => {
    expect(trashLabelKey('windows')).toBe('trash.windows');
    expect(trashLabelKey('mac')).toBe('trash.mac');
    expect(trashLabelKey('other')).toBe('trash.other');
  });

  it('uses File Explorer conventions on Windows', () => {
    expect(treeCommandForKey('windows', key('F2'))).toBe('rename');
    expect(treeCommandForKey('windows', key('Delete'))).toBe('delete');
    expect(treeCommandForKey('windows', key('R', { shiftKey: true, altKey: true }))).toBe('reveal');
    expect(treeCommandForKey('windows', key('Backspace', { metaKey: true }))).toBeNull();
    expect(treeShortcutLabel('windows', 'reveal')).toBe('Shift+Alt+R');
    expect(treeShortcutLabel('windows', 'delete')).toBe('Delete');
  });

  it('uses Finder conventions on macOS', () => {
    expect(treeCommandForKey('mac', key('Backspace', { metaKey: true }))).toBe('delete');
    expect(treeCommandForKey('mac', key('Delete'))).toBe('delete');
    expect(treeCommandForKey('mac', key('®', { metaKey: true, altKey: true }))).toBe('reveal');
    expect(treeCommandForKey('mac', key('R', { shiftKey: true, altKey: true }))).toBeNull();
    expect(treeShortcutLabel('mac', 'delete')).toBe('⌘⌫');
    expect(treeShortcutLabel('mac', 'reveal')).toBe('⌥⌘R');
  });
});

describe('formatShortcutLabel (S18.3)', () => {
  it('follows each platform', () => {
    expect(formatShortcutLabel('windows')).toBe('Shift+Alt+F');
    expect(formatShortcutLabel('other')).toBe('Shift+Alt+F');
    expect(formatShortcutLabel('mac')).toBe('⇧⌥F');
  });
});
