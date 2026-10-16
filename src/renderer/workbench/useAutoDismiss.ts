import { useEffect, useRef, useState } from 'react';

/** How long an informational notice stays before it leaves by itself (S47.5). */
export const INFO_NOTICE_MS = 12_000;

/**
 * S47.5: informational notices (role="status") dismiss themselves after INFO_NOTICE_MS, so they never pile up above
 * the status strip. The timer pauses while the pointer is over the notice or the focus is inside it (WCAG 2.2.1:
 * the user is reading or about to use its button), and starts again when both leave. Warnings and errors
 * (role="alert") never use this: they wait for the user.
 *
 * Returns the props to spread on the notice element.
 */
export function useAutoDismiss(onDismiss: () => void, ms: number = INFO_NOTICE_MS) {
  const [held, setHeld] = useState({ hover: false, focus: false });
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const paused = held.hover || held.focus;
  useEffect(() => {
    if (paused) return undefined;
    const timer = setTimeout(() => dismiss.current(), ms);
    return () => clearTimeout(timer);
  }, [paused, ms]);
  return {
    onMouseEnter: () => setHeld((h) => ({ ...h, hover: true })),
    onMouseLeave: () => setHeld((h) => ({ ...h, hover: false })),
    onFocus: () => setHeld((h) => ({ ...h, focus: true })),
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld((h) => ({ ...h, focus: false }));
    },
  };
}
