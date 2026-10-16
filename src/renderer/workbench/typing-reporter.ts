/**
 * S14.2 typing pause: reports editor keystrokes to main at most once per `intervalMs`, and always reports the last
 * keystroke of a burst (a trailing report). Main measures the typing pause from the last report it got, so a
 * throttle that dropped the final keystrokes would start that pause up to `intervalMs` early and refresh the preview
 * under the user's fingers (Windows CI, 2026-10-16: a reload 1.2 s into typing with keys 100 ms apart).
 */
export interface TypingReporter {
  /** A typing key was pressed in the editor. */
  key(): void;
  /** Drops a pending trailing report (the pane unmounts or the preview stops). */
  dispose(): void;
}

export function createTypingReporter(
  report: () => void,
  intervalMs: number,
  clock: {
    now: () => number;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (handle: unknown) => void;
  } = {
    now: Date.now,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): TypingReporter {
  let last = Number.NEGATIVE_INFINITY;
  let trailing: unknown = null;
  const send = () => {
    last = clock.now();
    report();
  };
  return {
    key() {
      const since = clock.now() - last;
      if (since >= intervalMs) {
        send();
        return;
      }
      if (trailing !== null) return; // already covers this keystroke
      trailing = clock.setTimer(() => {
        trailing = null;
        send();
      }, intervalMs - since);
    },
    dispose() {
      if (trailing !== null) clock.clearTimer(trailing);
      trailing = null;
    },
  };
}
