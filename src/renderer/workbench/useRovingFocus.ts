import { useCallback, useEffect, useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent } from 'react';
import {
  DEFAULT_ROVING_ORIENTATION,
  ROVING_ITEMS,
  rovingStop,
  rovingTarget,
  type RovingOptions,
  type RovingOrientation,
} from './roving-focus';

export interface RovingFocusOptions extends RovingOptions {
  /** Selector (relative to the container) of the items; defaults to the container's own enabled buttons. */
  readonly items?: string;
  /**
   * Skip items that are not rendered (a container query or a parent's display: none). On by default; a long list
   * whose items are never hidden (the console's copy buttons) turns it off, so a sync never forces a layout.
   */
  readonly skipHidden?: boolean;
}

export interface RovingGroupProps<T extends HTMLElement> {
  readonly ref: (element: T | null) => void;
  readonly onKeyDown: (event: KeyboardEvent<T>) => void;
  readonly onFocus: (event: FocusEvent<T>) => void;
  readonly 'data-roving': RovingOrientation;
}

/**
 * S49.2: roving focus for a toolbar or group (rules in roving-focus.ts). Spread the result on the container:
 * `<div role="toolbar" {...useRovingFocus({ orientation: 'horizontal' })}>`. The items keep their own markup; the hook
 * only sets their `tabIndex` (0 on the tab stop, -1 on the rest) after every render and whenever an item is added,
 * removed, enabled or disabled, and moves the focus with `preventScroll` so a long panel never jumps.
 */
export function useRovingFocus<T extends HTMLElement = HTMLElement>(
  options: RovingFocusOptions = {},
): RovingGroupProps<T> {
  const container = useRef<T | null>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const settings = useRef(options);
  settings.current = options;

  const items = useCallback((): HTMLElement[] => {
    const el = container.current;
    if (!el) return [];
    const all = [...el.querySelectorAll<HTMLElement>(settings.current.items ?? ROVING_ITEMS)];
    if (settings.current.skipHidden === false) return all;
    // Items a container query or a parent hides (display: none) are not part of the group.
    return all.filter((item) => typeof item.getClientRects !== 'function' || item.getClientRects().length > 0);
  }, []);

  const sync = useCallback(() => {
    const list = items();
    const last = lastFocused.current ? list.indexOf(lastFocused.current) : -1;
    const stop = rovingStop(
      list.map((item) => ({
        pressed: item.getAttribute('aria-pressed') === 'true' || item.getAttribute('aria-checked') === 'true',
      })),
      last,
    );
    list.forEach((item, index) => {
      const tabIndex = index === stop ? 0 : -1;
      if (item.tabIndex !== tabIndex) item.tabIndex = tabIndex;
    });
  }, [items]);

  // After every render of the owner: items may have appeared, gone or changed state.
  useLayoutEffect(sync);

  const observer = useRef<MutationObserver | null>(null);
  const ref = useCallback(
    (element: T | null) => {
      observer.current?.disconnect();
      observer.current = null;
      container.current = element;
      if (!element) return;
      sync();
      if (typeof MutationObserver === 'undefined') return;
      // Children rendered by another component (or a disabled flip without a render here) re-sync too.
      observer.current = new MutationObserver(sync);
      observer.current.observe(element, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'hidden', 'aria-pressed', 'aria-checked'],
      });
    },
    [sync],
  );
  useEffect(() => () => observer.current?.disconnect(), []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<T>) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const list = items();
      const index = list.indexOf(event.target as HTMLElement);
      if (index === -1) return;
      const el = container.current;
      const rtl = settings.current.rtl ?? (el ? getComputedStyle(el).direction === 'rtl' : false);
      const next = rovingTarget(event.key, index, list.length, { ...settings.current, rtl });
      if (next === null) return;
      event.preventDefault();
      const target = list[next];
      if (!target) return;
      lastFocused.current = target;
      sync();
      target.focus({ preventScroll: true });
    },
    [items, sync],
  );

  const onFocus = useCallback(
    (event: FocusEvent<T>) => {
      const target = event.target as HTMLElement;
      if (!items().includes(target)) return;
      lastFocused.current = target;
      sync();
    },
    [items, sync],
  );

  return { ref, onKeyDown, onFocus, 'data-roving': options.orientation ?? DEFAULT_ROVING_ORIENTATION };
}
