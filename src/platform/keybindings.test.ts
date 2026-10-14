import { describe, expect, it } from 'vitest';
import {
  keybindingAccelerator,
  keybindingLabel,
  matchesKeybinding,
  resolveKeybinding,
  type KeyStroke,
} from './keybindings';

const stroke = (key: string, mods: Partial<Omit<KeyStroke, 'key'>> = {}): KeyStroke => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('keybinding labels (S24.1)', () => {
  it('renders ⌘S on macOS and Ctrl+S on Windows from one binding', () => {
    const save = { key: 's', primary: true };
    expect(keybindingLabel(save, 'mac')).toBe('⌘S');
    expect(keybindingLabel(save, 'windows')).toBe('Ctrl+S');
    expect(keybindingLabel(save, 'other')).toBe('Ctrl+S');
  });

  it('uses Apple modifier order and symbols on macOS, Ctrl+Shift+Alt on Windows', () => {
    const b = { key: 'r', primary: true, shift: true, alt: true, ctrl: true };
    expect(keybindingLabel(b, 'mac')).toBe('⌃⌥⇧⌘R');
    expect(keybindingLabel(b, 'windows')).toBe('Ctrl+Shift+Alt+R');
    expect(keybindingLabel({ key: 'Tab', ctrl: true }, 'mac')).toBe('⌃⇥');
    expect(keybindingLabel({ key: 'Tab', ctrl: true }, 'windows')).toBe('Ctrl+Tab');
    expect(keybindingLabel({ key: '=', primary: true }, 'mac')).toBe('⌘+');
    expect(keybindingLabel({ key: '=', primary: true }, 'windows')).toBe('Ctrl+=');
  });

  it('builds Electron accelerators per platform', () => {
    expect(keybindingAccelerator({ key: 's', primary: true }, 'mac')).toBe('Cmd+S');
    expect(keybindingAccelerator({ key: 's', primary: true }, 'windows')).toBe('Ctrl+S');
    expect(keybindingAccelerator({ key: 'm', primary: true, shift: true }, 'windows')).toBe('Ctrl+Shift+M');
    expect(keybindingAccelerator({ key: 'Tab', ctrl: true, shift: true }, 'mac')).toBe('Ctrl+Shift+Tab');
  });

  it('picks the platform override before the shared binding', () => {
    const keys = { all: { key: 'Delete' }, mac: { key: 'Backspace', primary: true } };
    expect(resolveKeybinding(keys, 'mac')).toEqual({ key: 'Backspace', primary: true });
    expect(resolveKeybinding(keys, 'windows')).toEqual({ key: 'Delete' });
    expect(resolveKeybinding(undefined, 'mac')).toBeNull();
  });
});

describe('keybinding matching (S24.1)', () => {
  const save = { key: 's', primary: true };

  it('maps primary to ⌘ on macOS and Ctrl on Windows', () => {
    expect(matchesKeybinding(save, 'mac', stroke('s', { metaKey: true }))).toBe(true);
    expect(matchesKeybinding(save, 'mac', stroke('s', { ctrlKey: true }))).toBe(false);
    expect(matchesKeybinding(save, 'windows', stroke('s', { ctrlKey: true }))).toBe(true);
    expect(matchesKeybinding(save, 'windows', stroke('s', { metaKey: true }))).toBe(false);
    expect(matchesKeybinding(save, 'windows', stroke('S', { ctrlKey: true }))).toBe(true); // Caps Lock
  });

  it('refuses extra modifiers', () => {
    expect(matchesKeybinding(save, 'mac', stroke('s', { metaKey: true, shiftKey: true }))).toBe(false);
    expect(matchesKeybinding(save, 'windows', stroke('s', { ctrlKey: true, altKey: true }))).toBe(false);
  });

  it('accepts + and - with or without Shift and from the keypad', () => {
    const zoomIn = { key: '=', primary: true };
    expect(matchesKeybinding(zoomIn, 'windows', stroke('=', { ctrlKey: true }))).toBe(true);
    expect(matchesKeybinding(zoomIn, 'windows', stroke('+', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchesKeybinding(zoomIn, 'mac', stroke('+', { metaKey: true }))).toBe(true);
    expect(matchesKeybinding({ key: '-', primary: true }, 'mac', stroke('_', { metaKey: true, shiftKey: true }))).toBe(
      true,
    );
  });

  it('matches the literal Control key on macOS (Ctrl+Tab)', () => {
    const next = { key: 'Tab', ctrl: true };
    expect(matchesKeybinding(next, 'mac', stroke('Tab', { ctrlKey: true }))).toBe(true);
    expect(matchesKeybinding(next, 'mac', stroke('Tab', { metaKey: true }))).toBe(false);
    expect(matchesKeybinding(next, 'windows', stroke('Tab', { ctrlKey: true }))).toBe(true);
  });

  it('recognises a letter by its physical key when Option changes the character', () => {
    const b = { key: 'r', primary: true, alt: true };
    expect(matchesKeybinding(b, 'mac', stroke('®', { metaKey: true, altKey: true, code: 'KeyR' }))).toBe(true);
  });
});
