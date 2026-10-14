import type { BaseWindow, KeyboardEvent, MenuItemConstructorOptions } from 'electron';
import { buildMenuTemplate, type MenuEntry } from '../platform/menu-template';
import { isMac, type PlatformId } from '../platform/labels';
import { INITIAL_COMMAND_CONTEXT, type CommandContext, type CommandId } from '../shared/commands';
import { COMMAND_EVENTS } from '../shared/ipc/commands-contract';
import { translate, type Locale } from '../renderer/i18n/index';

/** The workbench page a menu command is sent to. */
export interface MenuTarget {
  readonly id: number;
  /** Whether the workbench page itself has the keyboard focus (not the preview, not another app). */
  isFocused(): boolean;
  send(channel: string, id: CommandId): void;
}

export type MenuCommandHandler = (id: CommandId, window: BaseWindow | undefined, byAccelerator: boolean) => void;

/** Turns the platform template into Electron's menu template. Command items only notify `onCommand`. */
export function toElectronTemplate(
  entries: readonly MenuEntry[],
  platform: PlatformId,
  onCommand: MenuCommandHandler,
): MenuItemConstructorOptions[] {
  return entries.map((entry): MenuItemConstructorOptions => {
    switch (entry.kind) {
      case 'separator':
        return { type: 'separator' };
      case 'role':
        return entry.accelerator === undefined
          ? { role: entry.role, label: entry.label }
          : { role: entry.role, label: entry.label, accelerator: entry.accelerator };
      case 'submenu': {
        const item: MenuItemConstructorOptions = { label: entry.label };
        if (entry.role && isMac(platform)) item.role = entry.role;
        if (entry.items.length > 0) item.submenu = toElectronTemplate(entry.items, platform, onCommand);
        return item;
      }
      case 'command': {
        const item: MenuItemConstructorOptions = {
          id: entry.id,
          label: entry.label,
          enabled: entry.enabled,
          click: (_menuItem, window, event: KeyboardEvent | undefined) =>
            onCommand(entry.id, window, event?.triggeredByAccelerator === true),
        };
        if (entry.checked !== undefined) {
          item.type = 'radio';
          item.checked = entry.checked;
        }
        if (entry.accelerator !== null) {
          item.accelerator = entry.accelerator;
          // Windows/Linux: shown only. The page resolves its keys through the command registry (S24.1).
          item.registerAccelerator = false;
        }
        return item;
      }
    }
  });
}

export interface AppMenuDeps {
  readonly platform: PlatformId;
  readonly devTools?: boolean;
  /** Menu.setApplicationMenu(Menu.buildFromTemplate(template)). */
  apply(template: MenuItemConstructorOptions[]): void;
  /** The workbench of the window a menu item was chosen in (or the focused / first one); null when none is open. */
  targetOf(window: BaseWindow | undefined): MenuTarget | null;
  /** macOS keeps running without windows: a menu command then opens a new workbench window. */
  createWindow(): void;
}

/**
 * The native menu bar (S24.2). Rebuilt when the interface language changes and when the focused workbench reports
 * a different command context, so items are translated and enabled exactly like the registry says.
 *
 * Keys: the page sees every key press first and runs the bound command itself (S24.1). On macOS an unhandled key
 * equivalent then reaches the menu; that second, accelerator-triggered call is ignored while the workbench page
 * has the focus (it already decided), and forwarded otherwise — e.g. ⌘S pressed while the preview has the focus.
 */
export class AppMenuController {
  private locale: Locale = 'zh-CN';
  private readonly contexts = new Map<number, CommandContext>();
  private active: number | null = null;
  private lastKey = '';

  constructor(private readonly deps: AppMenuDeps) {}

  setLocale(locale: Locale): void {
    this.locale = locale;
    this.rebuild();
  }

  setContext(targetId: number, context: CommandContext): void {
    this.contexts.set(targetId, context);
    if (this.active === null) this.active = targetId;
    if (targetId === this.active) this.rebuild();
  }

  windowFocused(targetId: number): void {
    this.active = targetId;
    this.rebuild();
  }

  windowClosed(targetId: number): void {
    this.contexts.delete(targetId);
    if (this.active === targetId) this.active = null;
    this.rebuild();
  }

  /** The context the menu currently reflects (for tests). */
  get context(): CommandContext {
    return (this.active !== null ? this.contexts.get(this.active) : undefined) ?? INITIAL_COMMAND_CONTEXT;
  }

  rebuild(): void {
    const context = this.context;
    const key = `${this.locale}|${JSON.stringify(context)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const entries = buildMenuTemplate({
      platform: this.deps.platform,
      t: (message) => translate(this.locale, message),
      context,
      devTools: this.deps.devTools ?? false,
    });
    this.deps.apply(
      toElectronTemplate(entries, this.deps.platform, (id, window, byAccelerator) =>
        this.run(id, window, byAccelerator),
      ),
    );
  }

  run(id: CommandId, window: BaseWindow | undefined, byAccelerator: boolean): void {
    const target = this.deps.targetOf(window);
    if (!target) {
      this.deps.createWindow();
      return;
    }
    if (byAccelerator && target.isFocused()) return;
    target.send(COMMAND_EVENTS.run, id);
  }
}
