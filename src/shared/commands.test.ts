import { describe, expect, it } from 'vitest';
import {
  HELP_MENU_COMMANDS,
  PROJECT_MENU_COMMANDS,
  COMMANDS,
  COMMAND_IDS,
  INITIAL_COMMAND_CONTEXT,
  commandChecked,
  commandForKeyStroke,
  commandShortcutLabel,
  isCommandEnabled,
  isCommandId,
  parseCommandContext,
} from './commands';
import { en } from '../renderer/i18n/en';
import { zhCN } from '../renderer/i18n/zh-CN';
import { keybindingLabel, resolveKeybinding } from '../platform/keybindings';

const key = (k: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  key: k,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
});

describe('command registry (S24.1)', () => {
  it('lists every command once, each with a translated label', () => {
    expect(COMMANDS.map((c) => c.id)).toEqual([...COMMAND_IDS]);
    for (const command of COMMANDS) {
      expect(zhCN[command.label]).toBeTruthy();
      expect(en[command.label]).toBeTruthy();
    }
  });

  it('renders the save hint as ⌘S on macOS and Ctrl+S on Windows', () => {
    expect(commandShortcutLabel('save', 'mac')).toBe('⌘S');
    expect(commandShortcutLabel('save', 'windows')).toBe('Ctrl+S');
    expect(commandShortcutLabel('toggle-problems', 'mac')).toBe('⇧⌘M');
    expect(commandShortcutLabel('toggle-problems', 'windows')).toBe('Ctrl+Shift+M');
    expect(commandShortcutLabel('close-project', 'mac')).toBeNull();
  });

  it('resolves key presses per platform', () => {
    expect(commandForKeyStroke('mac', key('s', { meta: true }))).toBe('save');
    expect(commandForKeyStroke('mac', key('s', { ctrl: true }))).toBeNull();
    expect(commandForKeyStroke('windows', key('s', { ctrl: true }))).toBe('save');
    expect(commandForKeyStroke('windows', key('s', { meta: true }))).toBeNull();
    expect(commandForKeyStroke('mac', key('Tab', { ctrl: true }))).toBe('next-tab');
    expect(commandForKeyStroke('windows', key('Tab', { ctrl: true, shift: true }))).toBe('previous-tab');
    expect(commandForKeyStroke('windows', key('+', { ctrl: true, shift: true }))).toBe('zoom-in');
    expect(commandForKeyStroke('mac', key('0', { meta: true }))).toBe('zoom-reset');
    expect(commandForKeyStroke('windows', key('x'))).toBeNull();
  });

  it('never binds one key press to two commands on a platform', () => {
    for (const platform of ['mac', 'windows'] as const) {
      const labels = COMMANDS.map((c) => resolveKeybinding(c.keys, platform))
        .filter((b) => b !== null)
        .map((b) => keybindingLabel(b, platform));
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it('applies when clauses', () => {
    const none = INITIAL_COMMAND_CONTEXT;
    const editing = { hasProject: true, hasActiveTab: true, modalOpen: false, theme: 'system' as const };
    expect(isCommandEnabled('save', none)).toBe(false);
    expect(isCommandEnabled('save', editing)).toBe(true);
    expect(isCommandEnabled('save', { ...editing, modalOpen: true, theme: 'system' as const })).toBe(true);
    expect(isCommandEnabled('close-project', none)).toBe(false);
    expect(isCommandEnabled('close-project', editing)).toBe(true);
    expect(isCommandEnabled('zoom-in', { ...editing, modalOpen: true, theme: 'system' as const })).toBe(false);
    expect(isCommandEnabled('open-logs', none)).toBe(true);
  });

  it('the in-window menus only name registered commands, each in one menu (S47.4)', () => {
    const entries = [...PROJECT_MENU_COMMANDS, ...HELP_MENU_COMMANDS].filter((entry) => entry !== '-');
    for (const entry of entries) expect(isCommandId(entry)).toBe(true);
    expect(new Set(entries).size).toBe(entries.length);
    // The project menu: close, history, lessons (reveal is added by the workbench); the help menu: theme, AI,
    // glossary, logs, settings (language is added by the workbench).
    expect(PROJECT_MENU_COMMANDS).toEqual(['close-project', 'show-history', 'help-walkthrough']);
    expect(HELP_MENU_COMMANDS[0]).toBe('theme-system');
    expect(HELP_MENU_COMMANDS.at(-1)).toBe('ai-settings');
  });

  it('validates the context the renderer reports', () => {
    expect(
      parseCommandContext({ hasProject: true, hasActiveTab: false, modalOpen: false, theme: 'system' as const }),
    ).toEqual({
      hasProject: true,
      hasActiveTab: false,
      modalOpen: false,
      theme: 'system',
    });
    expect(parseCommandContext({ hasProject: true, hasActiveTab: false })).toBeNull();
    expect(parseCommandContext({ hasProject: true, hasActiveTab: false, modalOpen: false, theme: 'neon' })).toBeNull();
    expect(
      parseCommandContext({ hasProject: 1, hasActiveTab: false, modalOpen: false, theme: 'system' as const }),
    ).toBeNull();
    expect(parseCommandContext({ hasProject: true, hasActiveTab: false, modalOpen: false, x: true })).toBeNull();
    expect(parseCommandContext(null)).toBeNull();
    expect(isCommandId('save')).toBe(true);
    expect(isCommandId('rm -rf')).toBe(false);
  });

  it('theme commands are a choice: exactly the current one is checked (S24.4)', () => {
    const light = { ...INITIAL_COMMAND_CONTEXT, theme: 'light' as const };
    expect(commandChecked('theme-light', light)).toBe(true);
    expect(commandChecked('theme-dark', light)).toBe(false);
    expect(commandChecked('theme-system', INITIAL_COMMAND_CONTEXT)).toBe(true);
    expect(commandChecked('save', light)).toBeNull();
  });

  it('registers find and replace once, with per-platform keys and both languages (S51.1)', () => {
    for (const id of ['find', 'replace'] as const) {
      expect(COMMANDS.filter((c) => c.id === id)).toHaveLength(1);
    }
    expect(zhCN['command.find']).toBe('查找');
    expect(en['command.find']).toBe('Find');
    expect(zhCN['command.replace']).toBe('替换');
    expect(en['command.replace']).toBe('Replace');
    expect(commandShortcutLabel('find', 'windows')).toBe('Ctrl+F');
    expect(commandShortcutLabel('find', 'mac')).toBe('⌘F');
    expect(commandShortcutLabel('replace', 'windows')).toBe('Ctrl+H');
    expect(commandShortcutLabel('replace', 'mac')).toBe('⌥⌘F');
    expect(commandForKeyStroke('windows', key('h', { ctrl: true }))).toBe('replace');
    expect(commandForKeyStroke('mac', key('h', { meta: true }))).toBeNull(); // ⌘H hides the app on macOS
    // ⌥ changes the produced character on macOS (⌥⌘F gives "ƒ"); the physical key still counts.
    expect(commandForKeyStroke('mac', { ...key('ƒ', { meta: true, alt: true }), code: 'KeyF' })).toBe('replace');
    expect(commandForKeyStroke('mac', key('f', { meta: true }))).toBe('find');
    const editing = { hasProject: true, hasActiveTab: true, modalOpen: false, theme: 'system' as const };
    expect(isCommandEnabled('find', editing)).toBe(true);
    expect(isCommandEnabled('find', { ...editing, hasActiveTab: false })).toBe(false);
    expect(isCommandEnabled('replace', { ...editing, modalOpen: true })).toBe(false);
  });

  it('find and replace in files: Ctrl/Cmd+Shift+F and Ctrl/Cmd+Shift+H, with a project or without (S51.3, S51.4)', () => {
    expect(commandShortcutLabel('find-in-files', 'windows')).toBe('Ctrl+Shift+F');
    expect(commandShortcutLabel('find-in-files', 'mac')).toBe('⇧⌘F');
    expect(commandShortcutLabel('replace-in-files', 'windows')).toBe('Ctrl+Shift+H');
    expect(commandShortcutLabel('replace-in-files', 'mac')).toBe('⇧⌘H');
    expect(en['command.findInFiles']).toBe('Find in Files');
    expect(zhCN['command.replaceInFiles']).toBe('在文件中替换');
    // Without a project the panel explains how to start (it opens, but has nothing to search).
    expect(isCommandEnabled('find-in-files', INITIAL_COMMAND_CONTEXT)).toBe(true);
    expect(isCommandEnabled('replace-in-files', { ...INITIAL_COMMAND_CONTEXT, modalOpen: true })).toBe(false);
  });

  it('quick open is Ctrl/Cmd+P and needs a project (S51.5)', () => {
    expect(commandShortcutLabel('quick-open', 'windows')).toBe('Ctrl+P');
    expect(commandShortcutLabel('quick-open', 'mac')).toBe('⌘P');
    expect(commandForKeyStroke('windows', key('p', { ctrl: true }))).toBe('quick-open');
    expect(commandForKeyStroke('windows', key('p', { ctrl: true, shift: true }))).toBe('command-palette');
    expect(zhCN['command.quickOpen']).toBe('按名称打开文件…');
    expect(en['command.quickOpen']).toBe('Go to File…');
    expect(isCommandEnabled('quick-open', INITIAL_COMMAND_CONTEXT)).toBe(false);
    expect(isCommandEnabled('quick-open', { ...INITIAL_COMMAND_CONTEXT, hasProject: true })).toBe(true);
  });
});
