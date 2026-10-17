import { describe, expect, it } from 'vitest';
import { REDUCED_MOTION_QUERY, editorMotionOptions, scrollBehavior } from './motion';

describe('reduced-motion gate (S47.1)', () => {
  it('uses the standard media query', () => {
    expect(REDUCED_MOTION_QUERY).toBe('(prefers-reduced-motion: reduce)');
  });

  it('scrolls instantly when motion is reduced', () => {
    expect(scrollBehavior(true)).toBe('auto');
    expect(scrollBehavior(false)).toBe('smooth');
  });

  it('turns Monaco smooth scrolling off when motion is reduced', () => {
    expect(editorMotionOptions(true)).toEqual({ smoothScrolling: false });
    expect(editorMotionOptions(false)).toEqual({ smoothScrolling: true });
  });
});
