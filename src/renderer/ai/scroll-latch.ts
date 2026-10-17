/**
 * S48.1: the scroll latch of a streaming log (chat now, the console in S49.4). Pure: no DOM, the caller passes the
 * time and the scroll metrics, so the rules are unit-tested.
 *
 * - The log follows new content while it is pinned (the user has not moved it).
 * - Any user input on the log (wheel, touch, key, pointer down) unpins it at once.
 * - It re-pins only when the last input is older than LATCH_QUIET_MS and the log is within LATCH_FOLLOW_PX of the
 *   end, so a reader who scrolls back down picks the stream up again, and one who scrolled up is never yanked.
 * - "Jump to latest" shows while unpinned and more than LATCH_JUMP_PX from the end, with the number of entries that
 *   received content since the reader left.
 * Following scrolls with behavior 'auto' (never 'smooth': a smooth scroll per chunk queues behind the stream).
 */

export const LATCH_QUIET_MS = 150;
export const LATCH_FOLLOW_PX = 40;
export const LATCH_JUMP_PX = 120;
export const LATCH_SCROLL_BEHAVIOR: ScrollBehavior = 'auto';

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export interface LatchState {
  readonly pinned: boolean;
  /** Time (same clock as `now`) of the last user input on the log; -Infinity when there was none. */
  readonly lastInputAt: number;
  /** Keys of the entries (messages, lines) that received content while unpinned. */
  readonly pending: readonly string[];
}

export const INITIAL_LATCH: LatchState = { pinned: true, lastInputAt: Number.NEGATIVE_INFINITY, pending: [] };

/** Pixels between the bottom of the viewport and the end of the content (never negative). */
export function distanceFromEnd(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.clientHeight - m.scrollTop);
}

function canRepin(state: LatchState, m: ScrollMetrics, now: number): boolean {
  return now - state.lastInputAt > LATCH_QUIET_MS && distanceFromEnd(m) <= LATCH_FOLLOW_PX;
}

const PINNED = (lastInputAt: number): LatchState => ({ pinned: true, lastInputAt, pending: [] });

/** Wheel, touch, key or pointer down on the log. */
export function userInput(state: LatchState, now: number): LatchState {
  return { ...state, pinned: false, lastInputAt: now };
}

/** A scroll event (the user's or our own): may re-pin a reader who came back to the end. */
export function scrolled(state: LatchState, m: ScrollMetrics, now: number): LatchState {
  if (state.pinned || !canRepin(state, m, now)) return state;
  return PINNED(state.lastInputAt);
}

/**
 * New content arrived in entry `key` (null when the change has no entry, e.g. a cleared log). `metrics` are taken
 * after the content rendered and before any scroll. Returns whether to scroll to the end now.
 */
export function contentChanged(
  state: LatchState,
  m: ScrollMetrics,
  now: number,
  key: string | null,
): { readonly state: LatchState; readonly follow: boolean } {
  if (state.pinned) return { state, follow: true };
  if (canRepin(state, m, now)) return { state: PINNED(state.lastInputAt), follow: true };
  if (key === null || state.pending.includes(key)) return { state, follow: false };
  return { state: { ...state, pending: [...state.pending, key] }, follow: false };
}

/** The Jump-to-latest control was used: pin and follow, whatever the last input. */
export function jumped(): LatchState {
  return INITIAL_LATCH;
}

export interface JumpView {
  readonly show: boolean;
  readonly pending: number;
}

/** Whether to show Jump to latest, and the count it shows. */
export function jumpView(state: LatchState, m: ScrollMetrics): JumpView {
  const show = !state.pinned && distanceFromEnd(m) > LATCH_JUMP_PX;
  return { show, pending: show ? state.pending.length : 0 };
}
