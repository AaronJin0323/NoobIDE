import { describe, expect, it } from 'vitest';
import {
  APP_MENU_GROUPS,
  COMMANDS,
  COMMAND_IDS,
  INITIAL_COMMAND_CONTEXT,
  commandChecked,
  commandLabel,
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
    const editing = { ...INITIAL_COMMAND_CONTEXT, hasProject: true, hasActiveTab: true };
    expect(isCommandEnabled('save', none)).toBe(false);
    expect(isCommandEnabled('save', editing)).toBe(true);
    expect(isCommandEnabled('save', { ...editing, modalOpen: true })).toBe(true);
    expect(isCommandEnabled('close-project', none)).toBe(false);
    expect(isCommandEnabled('close-project', editing)).toBe(true);
    expect(isCommandEnabled('zoom-in', { ...editing, modalOpen: true })).toBe(false);
    expect(isCommandEnabled('open-logs', none)).toBe(true);
  });

  it('the in-window menu only names registered commands, each once (S44.4 groups)', () => {
    const ids = APP_MENU_GROUPS.flatMap((group) => group.ids);
    for (const id of ids) expect(isCommandId(id)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of APP_MENU_GROUPS) if (group.heading) expect(zhCN[group.heading]).toBeTruthy();
  });

  it('toggle titles say what they will do now, never "show or hide" (S44.4, HIG Menus)', () => {
    const c = INITIAL_COMMAND_CONTEXT;
    const zh = (id: Parameters<typeof commandLabel>[0], context = c) => zhCN[commandLabel(id, context, 'mac')];
    const enOf = (id: Parameters<typeof commandLabel>[0], context = c) => en[commandLabel(id, context, 'windows')];
    expect(zh('toggle-files')).toBe('隐藏文件列表');
    expect(zh('toggle-files', { ...c, filesVisible: false })).toBe('显示文件列表');
    expect(enOf('toggle-problems')).toBe('Show problems');
    expect(enOf('toggle-problems', { ...c, problemsOpen: true })).toBe('Hide problems');
    expect(zh('ai-toggle-chat')).toBe('显示 AI 助手');
    expect(zh('ai-toggle-chat', { ...c, aiChatOpen: true })).toBe('隐藏 AI 助手');
    expect(zh('toggle-inline-ai')).toBe('开启 AI 代码建议');
    expect(enOf('toggle-inline-ai', { ...c, inlineAiOn: true })).toBe('Turn off AI suggestions');
    expect(zh('reveal-project')).toBe('在访达中显示');
    expect(enOf('reveal-project')).toBe('Show in File Explorer');
    // Every title of every command, in every state: no "or" titles in either language.
    const states = [c, { ...c, filesVisible: false, problemsOpen: true, aiChatOpen: true, inlineAiOn: true }];
    for (const command of COMMANDS) {
      for (const state of states) {
        const key = commandLabel(command.id, state, 'mac');
        expect(zhCN[key]).not.toMatch(/或/);
        expect(en[key]).not.toMatch(/\bor\b/);
      }
    }
  });

  it('the interface language is a choice with the current one checked (S44.4)', () => {
    expect(commandChecked('language-zh-CN', INITIAL_COMMAND_CONTEXT)).toBe(true);
    expect(commandChecked('language-en', INITIAL_COMMAND_CONTEXT)).toBe(false);
    expect(commandChecked('language-en', { ...INITIAL_COMMAND_CONTEXT, locale: 'en' })).toBe(true);
  });

  it('validates the context the renderer reports', () => {
    const valid = { ...INITIAL_COMMAND_CONTEXT, hasProject: true, locale: 'en' as const };
    expect(parseCommandContext(valid)).toEqual(valid);
    expect(parseCommandContext({ hasProject: true, hasActiveTab: false })).toBeNull();
    expect(parseCommandContext({ ...valid, theme: 'neon' })).toBeNull();
    expect(parseCommandContext({ ...valid, hasProject: 1 })).toBeNull();
    expect(parseCommandContext({ ...valid, filesVisible: 'yes' })).toBeNull();
    expect(parseCommandContext({ ...valid, locale: 'fr' })).toBeNull();
    expect(parseCommandContext({ ...valid, x: true })).toBeNull();
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
});
