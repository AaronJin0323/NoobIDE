/**
 * Per-platform keybindings of the command registry (S24.1, PLAN §3: "Map shortcuts by platform through a shared
 * command system"). Pure: takes the platform id, so the renderer (hints, key handling) and main (native menu
 * accelerators) render the same binding the same way. One binding is written once with `primary` — ⌘ on macOS,
 * Ctrl on Windows — and is shown as `⌘S` in macOS menus and hints and as `Ctrl+S` on Windows.
 */
import { isMac, type PlatformId } from './labels';

export interface Keybinding {
  /** `KeyboardEvent.key` of the unshifted key: a letter (any case), a digit, `=`, `-`, `Tab`, `F2`, … */
  readonly key: string;
  /** ⌘ on macOS, Ctrl on Windows and Linux. */
  readonly primary?: boolean;
  /** The Control key itself on every platform (e.g. Ctrl+Tab also on macOS, like other editors). */
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  /** Option on macOS. */
  readonly alt?: boolean;
}

/** A command's bindings: one for every platform, optionally replaced on one of them. */
export interface PlatformKeybindings {
  readonly all?: Keybinding;
  readonly mac?: Keybinding;
  readonly windows?: Keybinding;
}

export function resolveKeybinding(keys: PlatformKeybindings | undefined, id: PlatformId): Keybinding | null {
  if (!keys) return null;
  return (isMac(id) ? keys.mac : keys.windows) ?? keys.all ?? null;
}

const MAC_KEY_SYMBOLS: Readonly<Record<string, string>> = {
  Tab: '⇥',
  Backspace: '⌫',
  Delete: '⌦',
  Enter: '↩',
  Escape: '⎋',
  '=': '+',
};

function keyName(key: string, id: PlatformId): string {
  const named = isMac(id) ? MAC_KEY_SYMBOLS[key] : undefined;
  if (named !== undefined) return named;
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * The text of a shortcut in menus and hints: Apple's modifier order and symbols on macOS (`⌃⌥⇧⌘S`, no separators),
 * `Ctrl+Shift+Alt+S` on Windows and Linux.
 */
export function keybindingLabel(binding: Keybinding, id: PlatformId): string {
  const key = keyName(binding.key, id);
  if (isMac(id)) {
    return `${binding.ctrl ? '⌃' : ''}${binding.alt ? '⌥' : ''}${binding.shift ? '⇧' : ''}${binding.primary ? '⌘' : ''}${key}`;
  }
  const parts: string[] = [];
  if (binding.primary || binding.ctrl) parts.push('Ctrl');
  if (binding.shift) parts.push('Shift');
  if (binding.alt) parts.push('Alt');
  parts.push(key);
  return parts.join('+');
}

/** The Electron accelerator string of a binding (native menus show it; main never registers global shortcuts). */
export function keybindingAccelerator(binding: Keybinding, id: PlatformId): string {
  const parts: string[] = [];
  if (isMac(id)) {
    if (binding.ctrl) parts.push('Ctrl');
    if (binding.alt) parts.push('Alt');
    if (binding.shift) parts.push('Shift');
    if (binding.primary) parts.push('Cmd');
  } else {
    if (binding.primary || binding.ctrl) parts.push('Ctrl');
    if (binding.shift) parts.push('Shift');
    if (binding.alt) parts.push('Alt');
  }
  parts.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return parts.join('+');
}

/** The parts of a KeyboardEvent the matcher reads (a plain object in tests). */
export interface KeyStroke {
  readonly key: string;
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * Keys whose shifted character is accepted as the same key with or without Shift: `+` is Shift+`=` on many layouts
 * (and the numeric keypad sends `+` and `-` directly), so ⌘+ / Ctrl++ zoom in whether or not Shift is held.
 */
const SHIFT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  '=': ['=', '+'],
  '-': ['-', '_'],
};

function sameKey(binding: Keybinding, stroke: KeyStroke): boolean {
  const aliases = SHIFT_ALIASES[binding.key];
  if (aliases) return aliases.includes(stroke.key);
  if (binding.key.length === 1 && /[a-z]/i.test(binding.key)) {
    // Option on macOS changes the produced character (⌥⌘R gives "®"), so the physical key also counts.
    return stroke.key.toLowerCase() === binding.key.toLowerCase() || stroke.code === `Key${binding.key.toUpperCase()}`;
  }
  if (binding.key.length === 1 && /[0-9]/.test(binding.key)) {
    return stroke.key === binding.key || stroke.code === `Digit${binding.key}`;
  }
  return stroke.key === binding.key;
}

/** Whether a key press is exactly this binding on this platform (no extra modifiers). */
export function matchesKeybinding(binding: Keybinding, id: PlatformId, stroke: KeyStroke): boolean {
  if (!sameKey(binding, stroke)) return false;
  const wantMeta = isMac(id) ? Boolean(binding.primary) : false;
  const wantCtrl = isMac(id) ? Boolean(binding.ctrl) : Boolean(binding.primary || binding.ctrl);
  if (stroke.metaKey !== wantMeta || stroke.ctrlKey !== wantCtrl) return false;
  if (stroke.altKey !== Boolean(binding.alt)) return false;
  if (SHIFT_ALIASES[binding.key] === undefined && stroke.shiftKey !== Boolean(binding.shift)) return false;
  return true;
}
