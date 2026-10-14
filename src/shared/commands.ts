/**
 * The command registry (S24.1, PLAN §3): one list of the workbench's commands — id, i18n label, when it applies and
 * its per-platform keybinding. Everything else is derived from it: the renderer's key handling and its in-window
 * menu, the shortcut hints, and main's native menus (src/platform/menu-template.ts). Handlers live in the renderer
 * (src/renderer/commands); main only ever asks the renderer to run a command by id.
 *
 * Pure TypeScript, used by main, preload and the renderer.
 */
import {
  keybindingLabel,
  matchesKeybinding,
  resolveKeybinding,
  type KeyStroke,
  type Keybinding,
  type PlatformKeybindings,
} from '../platform/keybindings';
import type { PlatformId } from '../platform/labels';
import type { MessageKey } from '../renderer/i18n/zh-CN';
import { isThemeChoice, type ThemeChoice } from './settings';

export const COMMAND_IDS = [
  'new-project',
  'open-folder',
  'save',
  'close-tab',
  'close-project',
  'show-history',
  'toggle-files',
  'toggle-problems',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'next-tab',
  'previous-tab',
  'open-logs',
  // S24.4
  'theme-system',
  'theme-light',
  'theme-dark',
] as const;
export type CommandId = (typeof COMMAND_IDS)[number];

/** What `when` clauses read. The renderer computes it; main gets a validated copy to enable native menu items. */
export interface CommandContext {
  readonly hasProject: boolean;
  /** A file tab is open and active. */
  readonly hasActiveTab: boolean;
  /** A modal dialog (wizard, history, confirmation) has the focus: commands behind it wait. */
  readonly modalOpen: boolean;
  /** S24.4: the theme choice, shown as the checked theme command. */
  readonly theme: ThemeChoice;
}

export const INITIAL_COMMAND_CONTEXT: CommandContext = {
  hasProject: false,
  hasActiveTab: false,
  modalOpen: false,
  theme: 'system',
};

export interface CommandDefinition {
  readonly id: CommandId;
  readonly label: MessageKey;
  readonly keys?: PlatformKeybindings;
  /** When the command applies; always when absent. */
  readonly when?: (context: CommandContext) => boolean;
  /** A choice among several (radio item in menus): whether it is the current one. */
  readonly checked?: (context: CommandContext) => boolean;
}

const noModal = (c: CommandContext) => !c.modalOpen;

export const COMMANDS: readonly CommandDefinition[] = [
  { id: 'new-project', label: 'command.newProject', keys: { all: { key: 'n', primary: true } }, when: noModal },
  { id: 'open-folder', label: 'command.openFolder', keys: { all: { key: 'o', primary: true } }, when: noModal },
  // Saving also works from inside a dialog, as it did before the registry (it never discards anything).
  { id: 'save', label: 'command.save', keys: { all: { key: 's', primary: true } }, when: (c) => c.hasActiveTab },
  {
    id: 'close-tab',
    label: 'command.closeTab',
    keys: { all: { key: 'w', primary: true } },
    when: (c) => c.hasActiveTab && !c.modalOpen,
  },
  { id: 'close-project', label: 'appMenu.closeProject', when: (c) => c.hasProject && !c.modalOpen },
  { id: 'show-history', label: 'command.showHistory', when: (c) => c.hasProject && !c.modalOpen },
  { id: 'toggle-files', label: 'command.toggleFiles', keys: { all: { key: 'b', primary: true } }, when: noModal },
  {
    id: 'toggle-problems',
    label: 'command.toggleProblems',
    keys: { all: { key: 'm', primary: true, shift: true } },
    when: noModal,
  },
  { id: 'zoom-in', label: 'zoom.in', keys: { all: { key: '=', primary: true } }, when: noModal },
  { id: 'zoom-out', label: 'zoom.out', keys: { all: { key: '-', primary: true } }, when: noModal },
  { id: 'zoom-reset', label: 'zoom.reset', keys: { all: { key: '0', primary: true } }, when: noModal },
  // Ctrl+Tab on every platform (also on macOS, like other editors).
  {
    id: 'next-tab',
    label: 'command.nextTab',
    keys: { all: { key: 'Tab', ctrl: true } },
    when: (c) => c.hasActiveTab && !c.modalOpen,
  },
  {
    id: 'previous-tab',
    label: 'command.previousTab',
    keys: { all: { key: 'Tab', ctrl: true, shift: true } },
    when: (c) => c.hasActiveTab && !c.modalOpen,
  },
  { id: 'open-logs', label: 'appMenu.openLogs' },
  // S24.4: theme choice, persisted in the app settings.
  { id: 'theme-system', label: 'command.theme.system', checked: (c) => c.theme === 'system' },
  { id: 'theme-light', label: 'command.theme.light', checked: (c) => c.theme === 'light' },
  { id: 'theme-dark', label: 'command.theme.dark', checked: (c) => c.theme === 'dark' },
];

const BY_ID = new Map(COMMANDS.map((command) => [command.id, command]));

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === 'string' && (COMMAND_IDS as readonly string[]).includes(value);
}

export function commandById(id: CommandId): CommandDefinition {
  const command = BY_ID.get(id);
  if (!command) throw new Error(`unknown command ${id}`);
  return command;
}

export function isCommandEnabled(id: CommandId, context: CommandContext): boolean {
  return commandById(id).when?.(context) ?? true;
}

export function commandKeybinding(id: CommandId, platform: PlatformId): Keybinding | null {
  return resolveKeybinding(commandById(id).keys, platform);
}

/** The hint shown next to a command (`⌘S` on macOS, `Ctrl+S` on Windows), or null when it has no shortcut. */
export function commandShortcutLabel(id: CommandId, platform: PlatformId): string | null {
  const binding = commandKeybinding(id, platform);
  return binding ? keybindingLabel(binding, platform) : null;
}

/** The command a key press is bound to on this platform, whether or not it applies right now. */
export function commandForKeyStroke(platform: PlatformId, stroke: KeyStroke): CommandId | null {
  for (const command of COMMANDS) {
    const binding = resolveKeybinding(command.keys, platform);
    if (binding && matchesKeybinding(binding, platform, stroke)) return command.id;
  }
  return null;
}

/** Commands of the workbench's in-window "more actions" menu, in order; `-` separates groups. */
export const APP_MENU_COMMANDS: readonly (CommandId | '-')[] = [
  'close-project',
  'show-history',
  '-',
  'theme-system',
  'theme-light',
  'theme-dark',
  '-',
  'open-logs',
];

/** Whether the command is a choice (radio item), and if so whether it is the current one; null otherwise. */
export function commandChecked(id: CommandId, context: CommandContext): boolean | null {
  const checked = commandById(id).checked;
  return checked ? checked(context) : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** IPC payload check for the context the renderer reports to main: exactly the known keys, each valid. */
export function parseCommandContext(payload: unknown): CommandContext | null {
  if (!isRecord(payload)) return null;
  const keys = Object.keys(payload).sort();
  const expected = Object.keys(INITIAL_COMMAND_CONTEXT).sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) return null;
  const { hasProject, hasActiveTab, modalOpen, theme } = payload;
  if (typeof hasProject !== 'boolean' || typeof hasActiveTab !== 'boolean' || typeof modalOpen !== 'boolean') {
    return null;
  }
  if (!isThemeChoice(theme)) return null;
  return { hasProject, hasActiveTab, modalOpen, theme };
}
