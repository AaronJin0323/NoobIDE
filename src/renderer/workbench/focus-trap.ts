import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Keeps Tab and Shift+Tab inside a modal dialog (accessibility invariant: dialogs trap focus). Only visible, enabled
 * controls take part. {@link useModalKeys} installs it window-wide, so focus that fell to the page (a button that
 * became disabled while working) is brought back too.
 */
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function focusableIn(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest('[hidden]') && el.getClientRects().length > 0,
  );
}

/** The parts of a DOM or React keyboard event the trap needs. */
export interface KeyLike {
  readonly key: string;
  readonly shiftKey: boolean;
  preventDefault(): void;
}

/**
 * Pure rule of the trap: where a Tab press from `active` goes among the dialog's focusable `items` (in DOM order),
 * or null when the browser's own order already stays inside. Tab on the last item (or from outside the dialog) wraps
 * to the first; Shift+Tab on the first (or from outside) wraps to the last.
 */
export function tabWrapTarget<T>(items: readonly T[], active: T | null, shiftKey: boolean, inside: boolean): T | null {
  if (items.length === 0) return null;
  const first = items[0] as T;
  const last = items[items.length - 1] as T;
  if (shiftKey && (active === first || !inside)) return last;
  if (!shiftKey && (active === last || !inside)) return first;
  return null;
}

export function trapTab(event: KeyLike, container: HTMLElement | null): void {
  if (event.key !== 'Tab' || !container) return;
  const items = focusableIn(container);
  if (items.length === 0) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement as HTMLElement | null;
  const target = tabWrapTarget(items, active, event.shiftKey, container.contains(active));
  if (target) {
    event.preventDefault();
    target.focus();
  }
}

/**
 * Window-wide keys of a modal dialog: Tab / Shift+Tab stay inside `ref`, Escape calls `onEscape`. Captured before
 * the workbench's own shortcuts while the dialog is open.
 */
export function useModalKeys(ref: RefObject<HTMLElement | null>, onEscape: () => void): void {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        escape.current();
      } else if (event.key === 'Tab') trapTab(event, ref.current);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [ref]);
}

/** The parts of a DOM element focus restoring needs (pure, so it is testable without a DOM). */
export interface FocusableLike {
  readonly isConnected: boolean;
  focus(): void;
}

/**
 * Whether a closing dialog gives the focus back to `opener`: only when the opener is still on screen and the focus
 * was lost with the dialog (it is on <body> or nowhere), never taking it from a control the user moved to.
 */
export function shouldReturnFocus(
  opener: unknown,
  active: Element | null,
  body: Element | null,
): opener is FocusableLike {
  if (opener === null || typeof opener !== 'object' || opener === body) return false;
  const candidate = opener as Partial<FocusableLike>;
  if (typeof candidate.focus !== 'function' || candidate.isConnected !== true) return false;
  return active === null || active === body || !active.isConnected;
}

/**
 * A modal dialog returns the focus to where it was when it opened (the menu entry, the button, the editor) once it
 * closes, like Settings → AI and About. Remembers the focused element when the dialog first renders.
 */
export function useReturnFocus(): void {
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement));
  useEffect(
    () => () => {
      if (shouldReturnFocus(opener, document.activeElement, document.body)) opener.focus();
    },
    [opener],
  );
}
