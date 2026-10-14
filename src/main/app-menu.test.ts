import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { AppMenuController, toElectronTemplate, type MenuTarget } from './app-menu';
import { buildMenuTemplate } from '../platform/menu-template';
import { translate } from '../renderer/i18n/index';
import { COMMAND_EVENTS } from '../shared/ipc/commands-contract';

const EDITING = { hasProject: true, hasActiveTab: true, modalOpen: false };

function find(items: MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const inner = Array.isArray(item.submenu) ? find(item.submenu, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

function setup(focused = true, hasTarget = true) {
  const applied: MenuItemConstructorOptions[][] = [];
  const send = vi.fn<MenuTarget['send']>();
  const target = {
    id: 7,
    isFocused: () => focused,
    send,
  };
  const createWindow = vi.fn();
  const controller = new AppMenuController({
    platform: 'mac',
    apply: (template) => applied.push(template),
    targetOf: () => (hasTarget ? target : null),
    createWindow,
  });
  return { controller, applied, target, createWindow };
}

describe('Electron menu template (S24.2)', () => {
  it('command items show their accelerator without registering it, roles stay roles', () => {
    const entries = buildMenuTemplate({ platform: 'windows', t: (k) => translate('en', k), context: EDITING });
    const onCommand = vi.fn();
    const template = toElectronTemplate(entries, 'windows', onCommand);
    const save = find(template, 'save');
    expect(save).toMatchObject({ label: 'Save', accelerator: 'Ctrl+S', registerAccelerator: false, enabled: true });
    save?.click?.({} as never, undefined, { triggeredByAccelerator: false } as never);
    expect(onCommand).toHaveBeenCalledWith('save', undefined, false);
    const edit = template.find((item) => item.label === 'Edit');
    expect(Array.isArray(edit?.submenu) && edit.submenu[0]).toMatchObject({ role: 'undo', label: 'Undo' });
    // Submenu roles are a macOS concept only.
    expect(template.some((item) => item.role !== undefined)).toBe(false);
  });

  it('keeps the macOS application and window menu roles', () => {
    const entries = buildMenuTemplate({ platform: 'mac', t: (k) => translate('en', k), context: EDITING });
    const template = toElectronTemplate(entries, 'mac', vi.fn());
    expect(template[0]).toMatchObject({ role: 'appMenu', label: 'NoobIDE' });
    expect(template.find((item) => item.label === 'Window')?.role).toBe('windowMenu');
  });
});

describe('menu controller (S24.2)', () => {
  it('forwards a menu choice to the workbench', () => {
    const { controller, target } = setup();
    controller.run('toggle-files', undefined, false);
    expect(target.send).toHaveBeenCalledWith(COMMAND_EVENTS.run, 'toggle-files');
  });

  it('ignores an accelerator the focused workbench already handled, forwards it from elsewhere (preview)', () => {
    const focused = setup(true);
    focused.controller.run('save', undefined, true);
    expect(focused.target.send).not.toHaveBeenCalled();
    const elsewhere = setup(false);
    elsewhere.controller.run('save', undefined, true);
    expect(elsewhere.target.send).toHaveBeenCalledWith(COMMAND_EVENTS.run, 'save');
  });

  it('opens a window when none is open (macOS keeps running without one)', () => {
    const { controller, createWindow } = setup(true, false);
    controller.run('open-folder', undefined, false);
    expect(createWindow).toHaveBeenCalledOnce();
  });

  it('rebuilds on language and context changes only', () => {
    const { controller, applied } = setup();
    controller.rebuild();
    expect(applied).toHaveLength(1);
    expect(find(applied[0] ?? [], 'save')).toMatchObject({ label: '保存', enabled: false });
    controller.setContext(7, EDITING);
    expect(applied).toHaveLength(2);
    expect(find(applied[1] ?? [], 'save')?.enabled).toBe(true);
    controller.setContext(7, EDITING);
    expect(applied).toHaveLength(2);
    controller.setLocale('en');
    expect(find(applied[2] ?? [], 'save')?.label).toBe('Save');
    // Another window's context does not change the menu until that window is focused.
    controller.setContext(9, { hasProject: false, hasActiveTab: false, modalOpen: true });
    expect(applied).toHaveLength(3);
    controller.windowFocused(9);
    expect(find(applied[3] ?? [], 'zoom-in')?.enabled).toBe(false);
    controller.windowClosed(9);
    expect(controller.context).toEqual({ hasProject: false, hasActiveTab: false, modalOpen: false });
  });
});
