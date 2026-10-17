import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  INITIAL_LATCH,
  LATCH_SCROLL_BEHAVIOR,
  contentChanged,
  jumpView,
  jumped,
  scrolled,
  userInput,
  type JumpView,
  type LatchState,
} from './scroll-latch';

/** The inputs that mean "the user is moving the log" (scroll-latch.ts unpins on each). */
const INPUT_EVENTS = ['wheel', 'touchstart', 'touchmove', 'keydown', 'pointerdown'] as const;

/**
 * S48.1: binds the scroll latch to a scroll container. `content` changes whenever the log gains content (a cheap
 * signature, not the content itself), `entry` names the entry that changed, and a new `reset` (e.g. another
 * conversation) pins again. Returns the Jump-to-latest view and the action that jumps.
 */
export function useScrollLatch(
  scroller: RefObject<HTMLElement | null>,
  content: string,
  entry: string | null,
  reset: string,
): JumpView & { readonly jump: () => void } {
  const latch = useRef<LatchState>(INITIAL_LATCH);
  const [view, setView] = useState<JumpView>({ show: false, pending: 0 });

  const sync = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const next = jumpView(latch.current, el);
    setView((prev) => (prev.show === next.show && prev.pending === next.pending ? prev : next));
  }, [scroller]);

  const toEnd = useCallback((el: HTMLElement) => {
    el.scrollTo?.({ top: el.scrollHeight, behavior: LATCH_SCROLL_BEHAVIOR });
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onInput = () => {
      latch.current = userInput(latch.current, performance.now());
    };
    const onScroll = () => {
      latch.current = scrolled(latch.current, el, performance.now());
      sync();
    };
    for (const type of INPUT_EVENTS) el.addEventListener(type, onInput, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      for (const type of INPUT_EVENTS) el.removeEventListener(type, onInput);
      el.removeEventListener('scroll', onScroll);
    };
  }, [scroller, sync]);

  useEffect(() => {
    latch.current = INITIAL_LATCH;
  }, [reset]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const r = contentChanged(latch.current, el, performance.now(), entry);
    latch.current = r.state;
    if (r.follow) toEnd(el);
    sync();
    // `entry` is read at the moment content changes; it never triggers a follow by itself.
  }, [content, reset, scroller, sync, toEnd]);

  const jump = useCallback(() => {
    latch.current = jumped();
    const el = scroller.current;
    if (el) toEnd(el);
    sync();
  }, [scroller, sync, toEnd]);

  return { ...view, jump };
}
