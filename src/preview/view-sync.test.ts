import { describe, expect, it } from 'vitest';
import { FocusGuard, focusHandoffStep, toViewBounds, type KeyInput } from './view-sync';

describe('toViewBounds (S15.5/S15.6 DPI rounding)', () => {
  it('passes whole pixels through at zoom 1', () => {
    expect(toViewBounds({ x: 600, y: 80, width: 400, height: 300 }, 1)).toEqual({
      x: 600,
      y: 80,
      width: 400,
      height: 300,
    });
  });

  it('rounds edges, so fractional rects never leave a gap or overlap the next pixel', () => {
    // At 150 % a stage can start at 220.6667 and be 413.3333 wide: its right edge is 634.
    const b = toViewBounds({ x: 220.6667, y: 40.3333, width: 413.3333, height: 300.6667 }, 1);
    expect(b).toEqual({ x: 221, y: 40, width: 413, height: 301 });
    expect(b.x + b.width).toBe(634);
    expect(b.y + b.height).toBe(341);
  });

  it('separate rounding of x and width would be off by one where edge rounding is exact', () => {
    const rect = { x: 10.5, y: 0, width: 10.5, height: 1 }; // right edge 21
    const b = toViewBounds(rect, 1);
    expect(b.x + b.width).toBe(21);
    expect(Math.round(rect.x) + Math.round(rect.width)).toBe(22);
  });

  it('applies the workbench zoom factor and ignores unusable factors', () => {
    expect(toViewBounds({ x: 100, y: 50, width: 200, height: 100 }, 1.25)).toEqual({
      x: 125,
      y: 63,
      width: 250,
      height: 125, // edges 62.5 → 63 and 187.5 → 188
    });
    expect(toViewBounds({ x: 1, y: 2, width: 3, height: 4 }, 0)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(toViewBounds({ x: 1, y: 2, width: 3, height: 4 }, Number.NaN)).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
  });

  it('never reports a negative size', () => {
    expect(toViewBounds({ x: 5, y: 5, width: 0, height: 0 }, 1)).toEqual({ x: 5, y: 5, width: 0, height: 0 });
  });
});

describe('focusHandoffStep (S15.5/S15.6 focus out of the page)', () => {
  const key = (over: Partial<KeyInput>): KeyInput => ({
    type: 'keyDown',
    key: 'F6',
    shift: false,
    control: false,
    alt: false,
    meta: false,
    ...over,
  });
  it('F6 goes to the next region, Shift+F6 to the previous one', () => {
    expect(focusHandoffStep(key({}))).toBe(1);
    expect(focusHandoffStep(key({ shift: true }))).toBe(-1);
  });
  it('ignores key-up, other keys and modified F6', () => {
    expect(focusHandoffStep(key({ type: 'keyUp' }))).toBeNull();
    expect(focusHandoffStep(key({ key: 'Tab' }))).toBeNull();
    expect(focusHandoffStep(key({ control: true }))).toBeNull();
    expect(focusHandoffStep(key({ alt: true }))).toBeNull();
    expect(focusHandoffStep(key({ meta: true }))).toBeNull();
    expect(focusHandoffStep(key({ isAutoRepeat: true }))).toBeNull(); // holding F6 does not cycle every region
  });
});

describe('FocusGuard (S15.5/S15.6: loading a page does not steal the keyboard focus)', () => {
  it('returns focus taken during a load that began while the workbench had it', () => {
    const guard = new FocusGuard(500);
    guard.loadStarted(true, 0);
    expect(guard.shouldReturnFocus(0)).toBe(true);
    guard.loadFinished(1_000);
    expect(guard.shouldReturnFocus(1_400)).toBe(true); // late focus change within the grace period
    expect(guard.shouldReturnFocus(1_600)).toBe(false); // afterwards the page may be focused (a click into it)
    expect(guard.shouldReturnFocus(1_700)).toBe(false);
  });

  it('leaves the focus alone when the page already had it, or the user asked for it', () => {
    const guard = new FocusGuard();
    guard.loadStarted(false, 0); // e.g. refreshing while the user works inside the page
    expect(guard.shouldReturnFocus(0)).toBe(false);
    guard.loadStarted(true, 0);
    guard.userFocused(); // Enter on the preview stage
    expect(guard.shouldReturnFocus(0)).toBe(false);
  });

  it('a new load restarts the guard', () => {
    const guard = new FocusGuard(10);
    guard.loadStarted(true, 0);
    guard.loadFinished(0);
    expect(guard.shouldReturnFocus(100)).toBe(false);
    guard.loadStarted(true, 150);
    expect(guard.shouldReturnFocus(200)).toBe(true);
  });

  it('a page that never stops loading is guarded for at most maxMs', () => {
    const guard = new FocusGuard(500, 3_000);
    guard.loadStarted(true, 1_000);
    expect(guard.shouldReturnFocus(3_900)).toBe(true);
    expect(guard.shouldReturnFocus(4_100)).toBe(false);
  });
});
