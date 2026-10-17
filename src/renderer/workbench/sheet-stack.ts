import { useLayoutEffect, useState, useSyncExternalStore } from 'react';

/**
 * S50.1: which sheets are open, in the order they opened. A sheet that another sheet (or the palette) opened over is
 * "covered": it is drawn with a 2px blur and a dim (styles.css `[data-covered]`), so the dialog in front reads as the
 * one that asks. Every sheet is a sibling under the workbench, never a descendant of another, so the filter on the
 * parent never touches the child.
 */
export interface SheetStack {
  open(id: number): void;
  close(id: number): void;
  /** True while a sheet opened after `id` is still open. */
  covered(id: number): boolean;
  subscribe(listener: () => void): () => void;
  /** Changes whenever the stack does (for useSyncExternalStore). */
  version(): number;
}

/** Pure rule: a sheet is covered when it is open and not the last one opened. */
export function isCovered(stack: readonly number[], id: number): boolean {
  const at = stack.indexOf(id);
  return at >= 0 && at < stack.length - 1;
}

export function createSheetStack(): SheetStack {
  let stack: number[] = [];
  let version = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    version += 1;
    for (const listener of listeners) listener();
  };
  return {
    open(id) {
      stack = [...stack.filter((other) => other !== id), id];
      emit();
    },
    close(id) {
      if (!stack.includes(id)) return;
      stack = stack.filter((other) => other !== id);
      emit();
    },
    covered: (id) => isCovered(stack, id),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
}

const appStack = createSheetStack();
let nextId = 1;

export interface SheetLayer {
  /** A later sheet is open over this one (drawn blurred and dimmed). */
  readonly covered: boolean;
  /** Read at event time: only the front sheet answers Escape and Tab. */
  isFront(): boolean;
}

/** Registers the calling sheet while it is mounted. */
export function useSheetLayer(stack: SheetStack = appStack): SheetLayer {
  const [id] = useState(() => nextId++);
  useLayoutEffect(() => {
    stack.open(id);
    return () => stack.close(id);
  }, [stack, id]);
  useSyncExternalStore(stack.subscribe, stack.version, () => 0);
  return { covered: stack.covered(id), isFront: () => !stack.covered(id) };
}
