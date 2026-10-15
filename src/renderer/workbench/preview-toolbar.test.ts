import { describe, expect, it, vi } from 'vitest';
import type { PreviewStatus } from '../../shared/ipc/preview-contract';
import { COMMANDS, INITIAL_COMMAND_CONTEXT, commandShortcutLabel, isCommandEnabled } from '../../shared/commands';
import { buildMenuTemplate } from '../../platform/menu-template';
import { en } from '../i18n/en';
import { zhCN } from '../i18n/zh-CN';
import { PREVIEW_COMMAND_HANDLERS, setPreviewCommandTarget } from './preview-commands';
import { entryChoice, entryToStore, isTypingKey, pillFor, toolbarFor } from './preview-model';

/** S14.2–S14.4 and S15.4: the preview toolbar's pure model and its commands in the S24 registry. */

const ID = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';
const status = (state: PreviewStatus['state'], extra: Partial<PreviewStatus> = {}): PreviewStatus => ({
  state,
  projectId: state === 'stopped' ? null : ID,
  ...extra,
});

describe('preview toolbar actions (S15.4)', () => {
  it('offers Refresh, Stop, Open in browser and DevTools only when they can work', () => {
    expect(toolbarFor(status('running'), true)).toEqual({
      start: false,
      stop: true,
      reload: true,
      openExternal: true,
      devTools: true,
      clearData: true,
    });
    expect(toolbarFor(status('stopped'), true)).toEqual({
      start: true,
      stop: false,
      reload: false,
      openExternal: false,
      devTools: false,
      clearData: true,
    });
    // A hung page: Stop (and DevTools to see why), but no refresh and nothing to open elsewhere.
    expect(toolbarFor(status('unresponsive'), true)).toMatchObject({
      stop: true,
      reload: false,
      openExternal: false,
      devTools: true,
    });
    expect(toolbarFor(status('failed', { failure: 'crashed' }), true)).toMatchObject({
      openExternal: false,
      devTools: false,
    });
    expect(toolbarFor(status('stopped'), false)).toMatchObject({ start: false, clearData: false });
  });
});

describe('state pill (S14.1, S14.2, S10.5)', () => {
  it('says "saved changes not shown" in manual mode after a save, as text with a warning icon', () => {
    expect(pillFor(status('running', { outdated: true }), false)).toEqual({
      label: 'preview.outdated',
      detail: 'preview.outdatedDetail',
      warning: true,
    });
    expect(pillFor(status('running'), false)).toEqual({
      label: 'preview.state.running',
      detail: null,
      warning: false,
    });
  });

  it('a failed save wins over the manual-mode note', () => {
    expect(pillFor(status('running', { outdated: true }), true).label).toBe('preview.notUpdated');
  });
});

describe('entry page picker (S14.3)', () => {
  const pages = ['index.html', 'about.html', '子 页面/联系.html'];

  it('shows the configured entry, else index.html as the default', () => {
    expect(entryChoice(pages, 'about.html')).toBe('about.html');
    expect(entryChoice(pages, null)).toBe('index.html');
    expect(entryChoice(pages, 'gone.html')).toBe('index.html');
    expect(entryChoice(['a.html'], null)).toBe('a.html'); // no index.html: the page the preview opens
    expect(entryChoice([], null)).toBe('');
  });

  it('stores index.html as "no entry" (the default) and other pages as their relative path', () => {
    expect(entryToStore('index.html')).toBeNull();
    expect(entryToStore('子 页面/联系.html')).toBe('子 页面/联系.html');
    expect(entryToStore('docs/index.html')).toBe('docs/index.html');
  });
});

describe('typing signal (S14.2)', () => {
  const key = (k: string, mods: { ctrl?: boolean; meta?: boolean } = {}) => ({
    key: k,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
  });

  it('counts characters, Enter and Backspace; not shortcuts or bare modifiers', () => {
    for (const k of ['a', '中', 'Enter', 'Backspace', ' ', 'Tab']) expect(isTypingKey(key(k))).toBe(true);
    for (const k of ['Shift', 'Meta', 'Control', 'Alt', 'Escape']) expect(isTypingKey(key(k))).toBe(false);
    expect(isTypingKey(key('s', { meta: true }))).toBe(false);
    expect(isTypingKey(key('s', { ctrl: true }))).toBe(false);
  });
});

describe('preview commands in the registry (S15.4)', () => {
  const ids = ['preview-refresh', 'preview-stop', 'preview-open-external', 'preview-devtools', 'preview-clear-data'];

  it('are registered with translated labels and apply only with a project and no dialog', () => {
    for (const id of ids) {
      const command = COMMANDS.find((c) => c.id === id);
      expect(command).toBeDefined();
      if (!command) continue;
      expect(zhCN[command.label]).toBeTruthy();
      expect(en[command.label]).toBeTruthy();
      expect(isCommandEnabled(command.id, INITIAL_COMMAND_CONTEXT)).toBe(false);
      const open = { ...INITIAL_COMMAND_CONTEXT, hasProject: true };
      expect(isCommandEnabled(command.id, open)).toBe(true);
      expect(isCommandEnabled(command.id, { ...open, modalOpen: true })).toBe(false);
    }
  });

  it('refresh has the platform shortcut ⌘R / Ctrl+R', () => {
    expect(commandShortcutLabel('preview-refresh', 'mac')).toBe('⌘R');
    expect(commandShortcutLabel('preview-refresh', 'windows')).toBe('Ctrl+R');
  });

  it('refresh, stop and open in browser are in the native View menu; DevTools stays under Advanced', () => {
    for (const platform of ['mac', 'windows'] as const) {
      const menus = buildMenuTemplate({
        platform,
        t: (k) => en[k],
        context: { ...INITIAL_COMMAND_CONTEXT, hasProject: true },
      });
      const view = menus.find((m) => m.kind === 'submenu' && m.label === 'View');
      const items = view && view.kind === 'submenu' ? view.items : [];
      const commandIds = items.flatMap((i) => (i.kind === 'command' ? [i.id] : []));
      expect(commandIds).toEqual(expect.arrayContaining(['preview-refresh', 'preview-stop', 'preview-open-external']));
      expect(commandIds).not.toContain('preview-devtools');
    }
  });

  it('the workbench handlers forward to the mounted preview pane, and do nothing without one', () => {
    const refresh = vi.fn();
    const unregister = setPreviewCommandTarget({ 'preview-refresh': refresh });
    PREVIEW_COMMAND_HANDLERS['preview-refresh']?.();
    expect(refresh).toHaveBeenCalledTimes(1);
    unregister();
    PREVIEW_COMMAND_HANDLERS['preview-refresh']?.();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(Object.keys(PREVIEW_COMMAND_HANDLERS).sort()).toEqual([...ids].sort());
  });
});
