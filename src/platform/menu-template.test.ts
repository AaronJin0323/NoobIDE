import { describe, expect, it } from 'vitest';
import { buildMenuTemplate, type MenuEntry } from './menu-template';
import { translate, type Locale } from '../renderer/i18n/index';
import { INITIAL_COMMAND_CONTEXT, type CommandContext } from '../shared/commands';

const EDITING: CommandContext = { hasProject: true, hasActiveTab: true, modalOpen: false };

const build = (platform: 'mac' | 'windows', context = EDITING, locale: Locale = 'en') =>
  buildMenuTemplate({ platform, t: (key) => translate(locale, key), context });

type Submenu = Extract<MenuEntry, { kind: 'submenu' }>;
const submenu = (entries: MenuEntry[], label: string): Submenu => {
  const found = entries.find((e): e is Submenu => e.kind === 'submenu' && e.label === label);
  if (!found) throw new Error(`no menu ${label}`);
  return found;
};
const flat = (entries: readonly MenuEntry[]): MenuEntry[] =>
  entries.flatMap((e) => (e.kind === 'submenu' ? [e, ...flat(e.items)] : [e]));
const commandItem = (entries: MenuEntry[], id: string) => {
  const found = flat(entries).find((e) => e.kind === 'command' && e.id === id);
  if (!found || found.kind !== 'command') throw new Error(`no command ${id}`);
  return found;
};
const roles = (menu: Submenu) => menu.items.flatMap((e) => (e.kind === 'role' ? [e.role] : []));

describe('native menus (S24.2)', () => {
  it('macOS starts with the application menu and has a Window menu', () => {
    const menus = build('mac');
    expect(menus.map((m) => (m.kind === 'submenu' ? m.label : m.kind))).toEqual([
      'NoobIDE',
      'File',
      'Edit',
      'View',
      'Window',
      'Help',
    ]);
    const appMenu = submenu(menus, 'NoobIDE');
    expect(appMenu.role).toBe('appMenu');
    expect(roles(appMenu)).toEqual(['about', 'hide', 'hideOthers', 'unhide', 'quit']);
    expect(roles(submenu(menus, 'File'))).toEqual(['close']); // Close Window ⇧⌘W; ⌘W closes the tab
    expect(roles(submenu(menus, 'Window'))).toEqual(['minimize', 'zoom', 'front']);
  });

  it('Windows has no application or Window menu and ends File with Exit', () => {
    const menus = build('windows');
    expect(menus.map((m) => (m.kind === 'submenu' ? m.label : m.kind))).toEqual(['File', 'Edit', 'View', 'Help']);
    const file = submenu(menus, 'File');
    expect(file.items.at(-1)).toEqual({ kind: 'role', role: 'quit', label: 'Exit' });
  });

  it('shows each platform’s accelerators for the same command', () => {
    expect(commandItem(build('mac'), 'save').accelerator).toBe('Cmd+S');
    expect(commandItem(build('windows'), 'save').accelerator).toBe('Ctrl+S');
    expect(commandItem(build('mac'), 'toggle-problems').accelerator).toBe('Shift+Cmd+M');
    expect(commandItem(build('windows'), 'next-tab').accelerator).toBe('Ctrl+Tab');
    expect(commandItem(build('mac'), 'close-project').accelerator).toBeNull();
  });

  it('enables items from the command context', () => {
    expect(commandItem(build('mac', INITIAL_COMMAND_CONTEXT), 'save').enabled).toBe(false);
    expect(commandItem(build('mac', INITIAL_COMMAND_CONTEXT), 'open-folder').enabled).toBe(true);
    expect(commandItem(build('windows', EDITING), 'save').enabled).toBe(true);
    expect(commandItem(build('windows', { ...EDITING, modalOpen: true }), 'new-project').enabled).toBe(false);
  });

  it('translates every label with the interface language', () => {
    const zh = build('mac', EDITING, 'zh-CN');
    expect(zh.map((m) => (m.kind === 'submenu' ? m.label : ''))).toEqual([
      'NoobIDE',
      '文件',
      '编辑',
      '视图',
      '窗口',
      '帮助',
    ]);
    expect(commandItem(zh, 'save').label).toBe('保存');
    for (const entry of flat(zh)) {
      if (entry.kind === 'separator') continue;
      expect(entry.label).not.toBe('');
    }
    expect(submenu(zh, 'NoobIDE').items[0]).toMatchObject({ role: 'about', label: '关于 NoobIDE' });
  });

  it('adds the developer tools only on request', () => {
    expect(flat(build('mac')).some((e) => e.kind === 'role' && e.role === 'toggleDevTools')).toBe(false);
    const dev = buildMenuTemplate({ platform: 'mac', t: (k) => translate('en', k), context: EDITING, devTools: true });
    expect(flat(dev).some((e) => e.kind === 'role' && e.role === 'toggleDevTools')).toBe(true);
  });
});
