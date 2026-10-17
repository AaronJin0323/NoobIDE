import type { CSSProperties } from 'react';

/**
 * S47.2: items of a list enter one after another — each waits one --dur-stagger (30 ms) more than the one before, up
 * to the 8th; later items wait as long as the 8th, so a long list never takes long to appear (motion.css).
 */
export const STAGGER_CAP = 8;

/** The stagger step of the item at `index` (0-based): 0 … STAGGER_CAP - 1. */
export function staggerIndex(index: number): number {
  return Math.max(0, Math.min(Math.floor(index), STAGGER_CAP - 1));
}

/** The inline custom property motion.css multiplies by --dur-stagger. */
export function staggerStyle(index: number): CSSProperties {
  return { '--stagger': staggerIndex(index) } as CSSProperties;
}
