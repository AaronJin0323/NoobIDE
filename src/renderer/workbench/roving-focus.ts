/**
 * S49.2: the roving-tabindex rules shared by every toolbar and group (rail, Code/Preview switch, viewport switch,
 * preview toolbar, chat add-context group, proposal action rows). Pure: the hook in useRovingFocus.ts passes the
 * key and the enabled items, so the rules are unit-tested.
 *
 * - Only the active item is a tab stop (tabIndex 0); Tab and Shift+Tab therefore always leave the group.
 * - The arrows of the group's orientation move within it ('both' takes all four); in a right-to-left layout the
 *   horizontal arrows swap.
 * - Home / PageUp jump to the first item, End / PageDown to the last.
 * - With `loop` (the default) moving past either end wraps; without it the focus stays on the end item.
 */

export type RovingOrientation = 'horizontal' | 'vertical' | 'both';

export interface RovingOptions {
  readonly orientation?: RovingOrientation;
  readonly loop?: boolean;
  /** Right-to-left layout; when omitted the hook reads the container's computed `direction`. */
  readonly rtl?: boolean;
}

export const DEFAULT_ROVING_ORIENTATION: RovingOrientation = 'horizontal';

/** The items of a group: its own buttons, in DOM order. Disabled and hidden ones are skipped. */
export const ROVING_ITEMS = ':scope > button:not(:disabled):not([hidden])';

/**
 * The index the focus moves to when `key` is pressed on item `index` of `count` enabled items, or null when the key
 * is not one of the group's (the event is then left alone, so it reaches the page as usual).
 */
export function rovingTarget(key: string, index: number, count: number, options: RovingOptions = {}): number | null {
  if (count <= 0) return null;
  const orientation = options.orientation ?? DEFAULT_ROVING_ORIENTATION;
  const loop = options.loop ?? true;
  const horizontal = orientation !== 'vertical';
  const vertical = orientation !== 'horizontal';
  let step = 0;
  switch (key) {
    case 'Home':
    case 'PageUp':
      return 0;
    case 'End':
    case 'PageDown':
      return count - 1;
    case 'ArrowRight':
      if (horizontal) step = options.rtl ? -1 : 1;
      break;
    case 'ArrowLeft':
      if (horizontal) step = options.rtl ? 1 : -1;
      break;
    case 'ArrowDown':
      if (vertical) step = 1;
      break;
    case 'ArrowUp':
      if (vertical) step = -1;
      break;
    default:
      break;
  }
  if (step === 0) return null;
  const from = Math.min(Math.max(index, 0), count - 1);
  const next = from + step;
  if (next < 0) return loop ? count - 1 : 0;
  if (next >= count) return loop ? 0 : count - 1;
  return next;
}

/**
 * Which item is the tab stop: the last one the user focused while it is still an enabled item, else the pressed
 * (or checked) one, else the first. Returns -1 for an empty group.
 */
export function rovingStop(items: readonly { readonly pressed: boolean }[], lastFocused: number): number {
  if (items.length === 0) return -1;
  if (lastFocused >= 0 && lastFocused < items.length) return lastFocused;
  const pressed = items.findIndex((item) => item.pressed);
  return pressed === -1 ? 0 : pressed;
}
