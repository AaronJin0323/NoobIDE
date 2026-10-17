/**
 * S47.5: the caret position of the code editor, published for the global status strip. The editor pane reports every
 * cursor move here (it owns the Monaco instance); the strip, rendered elsewhere in the frame, reads it through
 * useSyncExternalStore — so the workbench never re-renders on a caret move. Pure, like indent-state.ts.
 */
export interface CursorPosition {
  readonly line: number;
  readonly column: number;
}

let cursor: CursorPosition | null = null;
const listeners = new Set<() => void>();

export function publishCursor(next: CursorPosition | null): void {
  if (
    next === cursor ||
    (next !== null && cursor !== null && next.line === cursor.line && next.column === cursor.column)
  ) {
    return;
  }
  cursor = next;
  for (const listener of listeners) listener();
}

export function cursorPosition(): CursorPosition | null {
  return cursor;
}

export function subscribeCursor(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
