/**
 * S49.1 splitter physics, pure so every rule is unit-tested; Splitter.tsx and Workbench.tsx only wire it up.
 *
 * - A press becomes a drag only after {@link DRAG_DEAD_ZONE} CSS pixels of movement, so a click (or the two clicks of
 *   a double-click) on the grip never nudges the divider.
 * - Escape during a drag goes back to the value the drag started from.
 * - A double-click resets the divider to its default (files 220 px, editor share 0.5).
 * - Dragging the files divider under {@link FILES_COLLAPSE_BELOW} px collapses the panel into the same state as the
 *   toggle-files command; dragging back out reopens it at the dragged width.
 */
import { EDITOR_SHARE, FILES_WIDTH } from '../../shared/session';

/** Pointer movement, in CSS pixels, before a press on a divider becomes a drag. */
export const DRAG_DEAD_ZONE = 4;
/** A files panel dragged narrower than this collapses (FILES_WIDTH.min is the narrowest open width). */
export const FILES_COLLAPSE_BELOW = 120;
/** Double-click targets. */
export const SPLITTER_DEFAULTS = { filesWidth: FILES_WIDTH.default, editorShare: EDITOR_SHARE.default } as const;

/** A pressed divider: `active` once the pointer has left the dead zone. */
export interface DragState {
  readonly startX: number;
  readonly startValue: number;
  readonly active: boolean;
}

export function beginDrag(startX: number, startValue: number): DragState {
  return { startX, startValue, active: false };
}

/** What a pointer move at `x` does: still a click (`value: null`) or a drag to the value for `dx`. */
export function moveDrag(
  state: DragState,
  x: number,
  dragValue: (start: number, dx: number) => number,
): { readonly state: DragState; readonly value: number | null; readonly started: boolean } {
  const dx = x - state.startX;
  if (!state.active && Math.abs(dx) < DRAG_DEAD_ZONE) return { state, value: null, started: false };
  return { state: { ...state, active: true }, value: dragValue(state.startValue, dx), started: !state.active };
}

/** The value a release at `x` applies: none for a click that never left the dead zone. */
export function endDrag(state: DragState, x: number, dragValue: (start: number, dx: number) => number): number | null {
  return moveDrag(state, x, dragValue).value;
}

/** Escape: the value to go back to, only if the press had become a drag (a click changed nothing). */
export function cancelDrag(state: DragState): number | null {
  return state.active ? state.startValue : null;
}

/**
 * The files panel for a dragged (unclamped) width: under the collapse threshold it is closed and keeps the width the
 * drag started from (so the toggle reopens it at that size); otherwise open at the width clamped to its limits.
 */
export function filesDragOutcome(
  width: number,
  startWidth: number,
): { readonly open: boolean; readonly width: number } {
  const clamp = (value: number) => Math.round(Math.min(FILES_WIDTH.max, Math.max(FILES_WIDTH.min, value)));
  return width < FILES_COLLAPSE_BELOW ? { open: false, width: clamp(startWidth) } : { open: true, width: clamp(width) };
}

/** aria-valuetext of the files divider, in words. */
export function filesValueText(
  width: number,
  open: boolean,
  messages: { readonly width: string; readonly collapsed: string },
): string {
  return open ? messages.width.replace('{px}', String(Math.round(width))) : messages.collapsed;
}

/** aria-valuetext of the editor / preview divider, in words (both shares, which add up to 100). */
export function editorShareValueText(share: number, message: string): string {
  const code = Math.round(share * 100);
  return message.replace('{code}', String(code)).replace('{preview}', String(100 - code));
}
