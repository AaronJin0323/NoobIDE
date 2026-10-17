import { describe, expect, it } from 'vitest';
import {
  INITIAL_LATCH,
  LATCH_FOLLOW_PX,
  LATCH_JUMP_PX,
  LATCH_QUIET_MS,
  LATCH_SCROLL_BEHAVIOR,
  contentChanged,
  distanceFromEnd,
  jumpView,
  jumped,
  scrolled,
  userInput,
} from './scroll-latch';

/** A 400 px viewport over 2000 px of content, `fromEnd` px above the end. */
const at = (fromEnd: number) => ({ scrollTop: 2000 - 400 - fromEnd, scrollHeight: 2000, clientHeight: 400 });

describe('scroll latch (S48.1)', () => {
  it('uses the planned constants and never smooth-scrolls', () => {
    expect([LATCH_QUIET_MS, LATCH_FOLLOW_PX, LATCH_JUMP_PX]).toEqual([150, 40, 120]);
    expect(LATCH_SCROLL_BEHAVIOR).toBe('auto');
  });

  it('measures the distance from the end, never negative', () => {
    expect(distanceFromEnd(at(0))).toBe(0);
    expect(distanceFromEnd(at(300))).toBe(300);
    expect(distanceFromEnd({ scrollTop: 50, scrollHeight: 100, clientHeight: 400 })).toBe(0);
  });

  it('follows new content while pinned', () => {
    expect(contentChanged(INITIAL_LATCH, at(500), 1000, 't1')).toEqual({ state: INITIAL_LATCH, follow: true });
  });

  it('unpins on user input and does not follow, even at the end, until the input is old enough', () => {
    const s = userInput(INITIAL_LATCH, 1000);
    expect(s.pinned).toBe(false);
    expect(contentChanged(s, at(0), 1000 + LATCH_QUIET_MS, 't1').follow).toBe(false);
    expect(contentChanged(s, at(0), 1000 + LATCH_QUIET_MS + 1, 't1')).toEqual({
      state: { pinned: true, lastInputAt: 1000, pending: [] },
      follow: true,
    });
  });

  it('stays put far from the end however much time passes, and counts the entries that changed', () => {
    let s = userInput(INITIAL_LATCH, 0);
    for (const key of ['t1', 't1', 't2', null]) {
      const r = contentChanged(s, at(LATCH_FOLLOW_PX + 1), 10_000, key);
      expect(r.follow).toBe(false);
      s = r.state;
    }
    expect(s.pending).toEqual(['t1', 't2']);
  });

  it('re-pins on a scroll back near the end only after the quiet period', () => {
    const s = userInput(INITIAL_LATCH, 1000);
    expect(scrolled(s, at(LATCH_FOLLOW_PX), 1100)).toBe(s);
    expect(scrolled(s, at(LATCH_FOLLOW_PX + 1), 5000)).toBe(s);
    expect(scrolled(s, at(LATCH_FOLLOW_PX), 1151).pinned).toBe(true);
    expect(scrolled(INITIAL_LATCH, at(900), 0)).toBe(INITIAL_LATCH);
  });

  it('shows Jump to latest only when unpinned and more than 120 px from the end', () => {
    let s = userInput(INITIAL_LATCH, 0);
    s = contentChanged(s, at(500), 10, 't1').state;
    expect(jumpView(s, at(LATCH_JUMP_PX))).toEqual({ show: false, pending: 0 });
    expect(jumpView(s, at(LATCH_JUMP_PX + 1))).toEqual({ show: true, pending: 1 });
    expect(jumpView(INITIAL_LATCH, at(900))).toEqual({ show: false, pending: 0 });
  });

  it('jumping pins again and clears the count, even right after an input', () => {
    const s = jumped();
    expect(s).toEqual(INITIAL_LATCH);
    expect(contentChanged(s, at(900), 0, 't1').follow).toBe(true);
  });
});
