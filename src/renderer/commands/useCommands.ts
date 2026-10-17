import { isImeKey } from '../workbench/ime';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { PlatformId } from '../../platform/labels';
import {
  APP_MENU_COMMANDS,
  INITIAL_COMMAND_CONTEXT,
  commandById,
  commandChecked,
  commandForKeyStroke,
  commandShortcutLabel,
  isCommandEnabled,
  type CommandContext,
  type CommandId,
} from '../../shared/commands';
import type { AppMenuItem } from '../workbench/AppMenu';

/** The renderer's half of the command registry: what each command does in this window. */
export type CommandHandlers = Partial<Record<CommandId, (() => void) | undefined>>;

/** A modal dialog is open even if the workbench did not report it (recovery, confirmations): commands wait. */
function domModalOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('[aria-modal="true"]') !== null;
}

/**
 * Runs registered commands (S24.1). Shortcuts are resolved through the registry in the capture phase — before
 * Monaco and before the native menu, which only sees keys the page left unhandled — so a key bound to a command
 * that applies runs exactly that command. A bound key whose command does not apply right now is left alone.
 * Main's native menu (S24.2) asks for a command by id through `bridge.commands`; the same checks apply.
 */
export function useCommands(platform: PlatformId, context: CommandContext, handlers: CommandHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const contextRef = useRef(context);
  contextRef.current = context;

  const canRun = useCallback((id: CommandId): boolean => {
    const effective = { ...contextRef.current, modalOpen: contextRef.current.modalOpen || domModalOpen() };
    return handlersRef.current[id] !== undefined && isCommandEnabled(id, effective);
  }, []);

  const run = useCallback(
    (id: CommandId): boolean => {
      if (!canRun(id)) return false;
      handlersRef.current[id]?.();
      return true;
    },
    [canRun],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeKey(event)) return; // an input method owns the keys while composing
      const id = commandForKeyStroke(platform, event);
      if (id === null || !canRun(id)) return;
      event.preventDefault();
      event.stopPropagation();
      run(id);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [platform, canRun, run]);

  // S24.2: main enables the native menu items from this context and sends their choices back by id.
  const contextKey =
    `${context.hasProject}|${context.hasActiveTab}|${context.modalOpen}|${context.theme}` +
    `|${context.emmet}|${context.formatOnSave}`;
  useEffect(() => {
    void window.noobide?.commands?.setContext({ ...contextRef.current });
  }, [contextKey]);
  useEffect(() => window.noobide?.commands?.onRun((id) => void run(id)), [run]);

  return { run, canRun };
}

/** The in-window "more actions" menu, derived from the registry: commands that apply now, with shortcut hints. */
export function useAppMenuItems(
  platform: PlatformId,
  context: CommandContext,
  handlers: CommandHandlers,
  run: (id: CommandId) => boolean,
): AppMenuItem[] {
  // A separator is kept only between two visible groups.
  const visible = APP_MENU_COMMANDS.filter(
    (id) => id === '-' || (handlers[id] !== undefined && isCommandEnabled(id, context)),
  ).join(',');
  const theme = context.theme; // the checked theme item (S24.4)
  const emmet = context.emmet === true; // S53 switches
  const formatOnSave = context.formatOnSave === true;
  return useMemo(() => {
    const checkedIn = { ...INITIAL_COMMAND_CONTEXT, theme, emmet, formatOnSave };
    const items: AppMenuItem[] = [];
    let separate = false;
    for (const raw of visible === '' ? [] : visible.split(',')) {
      if (raw === '-') {
        separate = items.length > 0;
        continue;
      }
      const id = raw as CommandId;
      items.push({
        id,
        label: commandById(id).label,
        shortcut: commandShortcutLabel(id, platform),
        separatorBefore: separate,
        checked: commandChecked(id, checkedIn),
        onSelect: () => void run(id),
      });
      separate = false;
    }
    return items;
  }, [visible, theme, emmet, formatOnSave, platform, run]);
}

/** A tooltip with the command's shortcut hint from the registry, e.g. `Save (⌘S)` / `Save (Ctrl+S)`. */
export function withShortcut(label: string, id: CommandId, platform: PlatformId): string {
  const hint = commandShortcutLabel(id, platform);
  return hint ? `${label} (${hint})` : label;
}
