/**
 * S37.1: Monaco cancels its own work by rejecting promises with a `CancellationError` (name and message "Canceled").
 * Most of those rejections are awaited inside Monaco, but a few are not: the inline-completions fetch awaits
 * `wait(debounce, token)` and nothing handles the promise when the user types during that wait, so the window reports
 * "Uncaught (in promise) Canceled". On Windows, where a 0 ms timer takes a clock tick (~1–16 ms), typing right after a
 * suggestion request hits that window often (ai-inline.spec.ts "typing cancels the in-flight request"); on macOS it
 * rarely does.
 *
 * Cancellation is not an error, so — as VS Code does in its workbench — the renderer swallows exactly those
 * rejections. Any other rejection is left alone and still reported.
 */

/** The same test as Monaco's internal `isCancellationError` (vs/base/common/errors). */
export function isMonacoCancellation(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'Canceled' && reason.message === 'Canceled';
}

interface RejectionEventLike {
  readonly reason: unknown;
  preventDefault(): void;
}

interface RejectionTarget {
  addEventListener(type: 'unhandledrejection', listener: (event: RejectionEventLike) => void): void;
}

export function ignoreMonacoCancellations(target: RejectionTarget): void {
  target.addEventListener('unhandledrejection', (event) => {
    if (isMonacoCancellation(event.reason)) event.preventDefault();
  });
}
