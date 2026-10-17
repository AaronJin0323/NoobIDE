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
  // S24.3
  'focus-next-region',
  'focus-previous-region',
  // S28.1 About dialog
  'about',
  // S23 onboarding help
  'help-walkthrough',
  'help-glossary',
  // S15.4 preview toolbar
  'preview-refresh',
  'preview-stop',
  'preview-open-external',
  'preview-devtools',
  'preview-clear-data',
  // S31.4 Settings → AI
  'ai-settings',
  // S33 AI chat and explain (handlers exist only while AI is offered: no bridge or AI off → no command)
  'ai-toggle-chat',
  'ai-explain-code',
  // S32.1 AI ghost-text suggestions
  'toggle-inline-ai',
  // S35.1 AI inline edit (Ctrl/Cmd+I)
  'ai-inline-edit',
  // S40.5 command palette (search every command that applies now)
  'command-palette',
  // S51.1 find and replace in the current file (Monaco's find widget)
  'find',
  'replace',
  // S51.3 find in files (bottom panel)
  'find-in-files',
  // S51.4 replace in files (the same panel with its replace row)
  'replace-in-files',
  // S51.5 quick open (the command palette's files mode)
  'quick-open',
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
  // S24.3: F6 moves between the regions (Tab stays in the code editor, where it indents).
  { id: 'focus-next-region', label: 'command.focusNextRegion', keys: { all: { key: 'F6' } }, when: noModal },
  {
    id: 'focus-previous-region',
    label: 'command.focusPreviousRegion',
    keys: { all: { key: 'F6', shift: true } },
    when: noModal,
  },
  // S28.1: the About dialog (macOS application menu, Windows Help menu).
  { id: 'about', label: 'menu.about', when: noModal },
  // S23: the onboarding walkthrough and the glossary (Help menu).
  { id: 'help-walkthrough', label: 'command.walkthrough', when: noModal },
  { id: 'help-glossary', label: 'command.glossary', when: noModal },
  // S15.4: the preview toolbar's actions. They apply with a project open; the preview pane's handlers do nothing
  // when the preview is not in a state that allows the action (e.g. Refresh while stopped).
  {
    id: 'preview-refresh',
    label: 'command.preview.refresh',
    keys: { all: { key: 'r', primary: true } },
    when: (c) => c.hasProject && !c.modalOpen,
  },
  { id: 'preview-stop', label: 'command.preview.stop', when: (c) => c.hasProject && !c.modalOpen },
  { id: 'preview-open-external', label: 'command.preview.openExternal', when: (c) => c.hasProject && !c.modalOpen },
  { id: 'preview-devtools', label: 'command.preview.devTools', when: (c) => c.hasProject && !c.modalOpen },
  { id: 'preview-clear-data', label: 'command.preview.clearData', when: (c) => c.hasProject && !c.modalOpen },
  // S31.4: Settings → AI (provider, key, models, on/off). Also in the Help menu.
  { id: 'ai-settings', label: 'command.aiSettings', when: noModal },
  // S33: the AI chat panel and "Explain this code" on the selection. Not in the native menus: the renderer offers them
  // only while AI is available (decision 0025: AI off removes every AI surface).
  {
    id: 'ai-toggle-chat',
    label: 'command.ai.toggleChat',
    keys: { all: { key: 'a', primary: true, shift: true } },
    when: noModal,
  },
  { id: 'ai-explain-code', label: 'command.ai.explainCode', when: (c) => c.hasActiveTab && !c.modalOpen },
  // S32.1: switches AI ghost-text suggestions on or off (AiConfig.inlineCompletions); only offered with an AI bridge.
  { id: 'toggle-inline-ai', label: 'command.toggleInlineAi', when: noModal },
  // S35.1: AI inline edit of the selected lines (or the whole file) — renderer-only like the other AI commands.
  {
    id: 'ai-inline-edit',
    label: 'command.ai.inlineEdit',
    keys: { all: { key: 'i', primary: true } },
    when: (c) => c.hasActiveTab && !c.modalOpen,
  },
  // S40.5: the command palette — ⌘⇧P / Ctrl+Shift+P, as in other editors beginners meet in tutorials.
  {
    id: 'command-palette',
    label: 'command.palette',
    keys: { all: { key: 'p', primary: true, shift: true } },
    when: noModal,
  },
  // S51.1: the code editor's find and replace — Ctrl/Cmd+F, and Ctrl+H on Windows / ⌥⌘F on macOS like other editors.
  {
    id: 'find',
    label: 'command.find',
    keys: { all: { key: 'f', primary: true } },
    when: (c) => c.hasActiveTab && !c.modalOpen,
  },
  {
    id: 'replace',
    label: 'command.replace',
    keys: { windows: { key: 'h', primary: true }, mac: { key: 'f', primary: true, alt: true } },
    when: (c) => c.hasActiveTab && !c.modalOpen,
  },
  // S51.3: the find-in-files panel in the bottom region (Ctrl/Cmd+Shift+F, as in other editors).
  {
    id: 'find-in-files',
    label: 'command.findInFiles',
    keys: { all: { key: 'f', primary: true, shift: true } },
    when: noModal,
  },
  // S51.4: the same panel with its replace row open (Ctrl/Cmd+Shift+H, as in other editors).
  {
    id: 'replace-in-files',
    label: 'command.replaceInFiles',
    keys: { all: { key: 'h', primary: true, shift: true } },
    when: noModal,
  },
  // S51.5: quick open — Ctrl/Cmd+P opens the palette on the project's files; ">" switches to the commands.
  {
    id: 'quick-open',
    label: 'command.quickOpen',
    keys: { all: { key: 'p', primary: true } },
    when: (c) => c.hasProject && !c.modalOpen,
  },
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

/**
 * S47.4: the workbench has two in-window menus. The project menu sits next to the project name and holds what is
 * about this project (close, reveal — added by the workbench, it is a platform label — history, lessons); the
 * trailing help/more menu holds theme, language (added by the workbench), the AI entries, glossary, logs and
 * settings. `-` separates groups; the workbench drops the items whose command does not apply.
 */
export const PROJECT_MENU_COMMANDS: readonly (CommandId | '-')[] = [
  'close-project',
  'show-history',
  'help-walkthrough',
];

export const HELP_MENU_COMMANDS: readonly (CommandId | '-')[] = [
  'theme-system',
  'theme-light',
  'theme-dark',
  '-',
  'ai-toggle-chat', // S33
  'ai-explain-code',
  'ai-inline-edit', // S35.1
  'toggle-inline-ai', // S32.1
  '-',
  'help-glossary',
  'open-logs',
  '-',
  'ai-settings', // S31.4
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
