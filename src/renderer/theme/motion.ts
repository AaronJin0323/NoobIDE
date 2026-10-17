import { useMediaQuery } from './useMediaQuery';

/**
 * S47.1: the reduced-motion gate for motion that CSS cannot reach (scripted scrolling, Monaco). The stylesheet side of
 * the same gate is the prefers-reduced-motion block in glass.css, which sets every --dur-* token to 0ms.
 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Live: does the system ask for reduced motion? */
export function useReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION_QUERY);
}

/** The behavior for scrollBy / scrollTo / scrollIntoView: animated unless motion is reduced. */
export function scrollBehavior(reduced: boolean): ScrollBehavior {
  return reduced ? 'auto' : 'smooth';
}

/** Monaco options that animate; all off under reduced motion. */
export function editorMotionOptions(reduced: boolean): { smoothScrolling: boolean } {
  return { smoothScrolling: !reduced };
}
