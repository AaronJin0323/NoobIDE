/**
 * The native menu bar of each platform (S24.2, PLAN §3: "Adapt to the macOS system menu …"), derived from the
 * command registry. Pure: returns a plain description that main turns into an Electron Menu, so both platforms'
 * menus are unit-tested on any machine.
 *
 * - macOS: the application menu (About, Services, Hide, Quit ⌘Q) comes first, then File, Edit, View, Window, Help.
 *   Closing the window is ⇧⌘W, since ⌘W closes the active tab like in other editors.
 * - Windows (and Linux dev runs): File (ending with Exit), Edit, View, Help — no application or Window menu.
 *
 * Every label is translated with the interface language; nothing here is English-only.
 */
import { keybindingAccelerator } from './keybindings';
import { isMac, type PlatformId } from './labels';
import {
  commandById,
  commandChecked,
  commandKeybinding,
  isCommandEnabled,
  type CommandContext,
  type CommandId,
} from '../shared/commands';
import type { MessageKey } from '../renderer/i18n/zh-CN';

/** Electron menu roles the template uses (the OS or Electron implements them). */
export type MenuRole =
  | 'about'
  | 'services'
  | 'hide'
  | 'hideOthers'
  | 'unhide'
  | 'quit'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'minimize'
  | 'zoom'
  | 'front'
  | 'close'
  | 'toggleDevTools'
  | 'appMenu'
  | 'windowMenu'
  | 'help';

export type MenuEntry =
  | {
      readonly kind: 'command';
      readonly id: CommandId;
      readonly label: string;
      /** Shown in the menu; the renderer handles the key itself (see main/app-menu.ts). */
      readonly accelerator: string | null;
      readonly enabled: boolean;
      /** S24.4: a choice (radio item) and whether it is the current one. */
      readonly checked?: boolean;
    }
  | { readonly kind: 'role'; readonly role: MenuRole; readonly label: string; readonly accelerator?: string }
  | { readonly kind: 'separator' }
  | {
      readonly kind: 'submenu';
      readonly label: string;
      readonly role?: MenuRole;
      readonly items: readonly MenuEntry[];
    };

export interface MenuTemplateOptions {
  readonly platform: PlatformId;
  readonly t: (key: MessageKey) => string;
  readonly context: CommandContext;
  /** Adds the developer tools toggle (development builds only). */
  readonly devTools?: boolean;
}

const SEPARATOR: MenuEntry = { kind: 'separator' };

export function buildMenuTemplate(options: MenuTemplateOptions): MenuEntry[] {
  const { platform, t, context } = options;
  const mac = isMac(platform);
  const command = (id: CommandId): MenuEntry => {
    const binding = commandKeybinding(id, platform);
    const checked = commandChecked(id, context);
    return {
      kind: 'command',
      id,
      label: t(commandById(id).label),
      accelerator: binding ? keybindingAccelerator(binding, platform) : null,
      enabled: isCommandEnabled(id, context),
      ...(checked === null ? {} : { checked }),
    };
  };
  const role = (r: MenuRole, label: MessageKey, accelerator?: string): MenuEntry =>
    accelerator === undefined
      ? { kind: 'role', role: r, label: t(label) }
      : { kind: 'role', role: r, label: t(label), accelerator };

  const appMenu: MenuEntry = {
    kind: 'submenu',
    label: t('app.name'),
    role: 'appMenu',
    items: [
      command('about'), // S28.1: NoobIDE's own About dialog, not the OS panel
      SEPARATOR,
      { kind: 'submenu', label: t('menu.services'), role: 'services', items: [] },
      SEPARATOR,
      role('hide', 'menu.hide'),
      role('hideOthers', 'menu.hideOthers'),
      role('unhide', 'menu.unhide'),
      SEPARATOR,
      role('quit', 'menu.quit'),
    ],
  };

  const file: MenuEntry = {
    kind: 'submenu',
    label: t('menu.file'),
    items: [
      command('new-project'),
      command('open-folder'),
      SEPARATOR,
      command('save'),
      SEPARATOR,
      command('show-history'),
      SEPARATOR,
      command('close-tab'),
      command('close-project'),
      ...(mac ? [role('close', 'menu.closeWindow', 'Shift+Cmd+W')] : [SEPARATOR, role('quit', 'menu.exit')]),
    ],
  };

  const edit: MenuEntry = {
    kind: 'submenu',
    label: t('menu.edit'),
    items: [
      role('undo', 'menu.undo'),
      role('redo', 'menu.redo'),
      SEPARATOR,
      role('cut', 'menu.cut'),
      role('copy', 'menu.copy'),
      role('paste', 'menu.paste'),
      role('selectAll', 'menu.selectAll'),
      SEPARATOR,
      command('toggle-inline-ai'), // S32.1
    ],
  };

  const view: MenuEntry = {
    kind: 'submenu',
    label: t('menu.view'),
    items: [
      command('toggle-files'),
      command('toggle-problems'),
      SEPARATOR,
      // S15.4: preview actions (developer tools and clearing data stay in the preview pane's Advanced menu)
      command('preview-refresh'),
      command('preview-stop'),
      command('preview-open-external'),
      SEPARATOR,
      command('zoom-in'),
      command('zoom-out'),
      command('zoom-reset'),
      SEPARATOR,
      command('theme-system'),
      command('theme-light'),
      command('theme-dark'),
      SEPARATOR,
      command('next-tab'),
      command('previous-tab'),
      command('focus-next-region'),
      command('focus-previous-region'),
      ...(options.devTools ? [SEPARATOR, role('toggleDevTools', 'menu.devTools')] : []),
    ],
  };

  const windowMenu: MenuEntry = {
    kind: 'submenu',
    label: t('menu.window'),
    role: 'windowMenu',
    items: [role('minimize', 'menu.minimize'), role('zoom', 'menu.windowZoom'), SEPARATOR, role('front', 'menu.front')],
  };

  const help: MenuEntry = {
    kind: 'submenu',
    label: t('menu.help'),
    role: 'help',
    items: [
      command('help-walkthrough'),
      command('help-glossary'),
      SEPARATOR,
      command('ai-settings'), // S31.4 Settings → AI
      command('open-logs'),
      ...(mac ? [] : [SEPARATOR, command('about')]),
    ],
  };

  return mac ? [appMenu, file, edit, view, windowMenu, help] : [file, edit, view, help];
}
