/**
 * S57: the navigation command (go to definition, find references, rename) that is waiting for the project's scripts
 * to be indexed, published for the global status strip the same way the caret is (editor-status-state.ts). The strip
 * shows "reading the project's scripts, then <command>…" as text (never colour alone) while the wait lasts; nothing
 * while no command waits. Pure.
 */
import type { MessageKey } from '../i18n/index';

let waiting: MessageKey | null = null;
const listeners = new Set<() => void>();

/** The command's label key while it waits for the index, or null when done. */
export function publishNavigationWait(command: MessageKey | null): void {
  if (command === waiting) return;
  waiting = command;
  for (const listener of listeners) listener();
}

export function navigationWait(): MessageKey | null {
  return waiting;
}

export function subscribeNavigationWait(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
