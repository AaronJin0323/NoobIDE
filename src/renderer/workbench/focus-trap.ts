import { isImeKey } from './ime';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

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

export function trapTab(event: KeyLike, container: HTMLElement | null): void {
  if (event.key !== 'Tab' || !container) return;
  const items = focusableIn(container);
  if (items.length === 0) {
    event.preventDefault();
    return;
  }
  const first = items[0] as HTMLElement;
  const last = items[items.length - 1] as HTMLElement;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Window-wide keys of a modal dialog: Tab / Shift+Tab stay inside `ref`, Escape calls `onEscape`. Captured before
 * the workbench's own shortcuts while the dialog is open.
 *
 * A layout effect, so the listener exists from the moment the dialog is in the DOM: a passive effect runs in a later
 * task, and the browser hands a key press (high priority) to the page before that task when the process is slow
 * (hosted CI runner) — the first Escape was then lost while the dialog was already on screen.
 */
export function useModalKeys(ref: RefObject<HTMLElement | null>, onEscape: () => void): void {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeKey(event)) return;
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
