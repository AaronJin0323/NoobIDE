import { useEffect, useRef, type RefObject } from 'react';

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
