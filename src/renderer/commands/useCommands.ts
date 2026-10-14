import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { PlatformId } from '../../platform/labels';
import {
  APP_MENU_COMMANDS,
  commandById,
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
      if (event.isComposing) return; // an input method owns the keys while composing
      const id = commandForKeyStroke(platform, event);
      if (id === null || !canRun(id)) return;
      event.preventDefault();
      event.stopPropagation();
      run(id);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [platform, canRun, run]);

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
  return useMemo(() => {
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
        onSelect: () => void run(id),
      });
      separate = false;
    }
    return items;
  }, [visible, platform, run]);
}

/** A tooltip with the command's shortcut hint from the registry, e.g. `Save (⌘S)` / `Save (Ctrl+S)`. */
export function withShortcut(label: string, id: CommandId, platform: PlatformId): string {
  const hint = commandShortcutLabel(id, platform);
  return hint ? `${label} (${hint})` : label;
}
