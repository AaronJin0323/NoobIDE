/**
 * S45.2: how much of the editor header's secondary content fits next to the tabs (HIG Tab bars / Toolbars: the tabs
 * get priority). Levels from roomiest to tightest:
 *   full  — the role tag and the labelled History / Format actions
 *   icons — the role tag and icon-only actions (label kept for screen readers, tooltip for the mouse)
 *   tight — icon-only actions, no role tag (the file tree still names each file's role)
 * The first level at which the tab strip does not overflow wins; when even `tight` overflows, the strip scrolls and
 * the active tab is scrolled fully into view.
 */
export const HEADER_FITS = ['full', 'icons', 'tight'] as const;
export type HeaderFit = (typeof HEADER_FITS)[number];

/** Applies each level in turn (via `apply`) and returns the first one at which `fits()` holds, else the tightest. */
export function pickHeaderFit(apply: (fit: HeaderFit) => void, fits: () => boolean): HeaderFit {
  for (const fit of HEADER_FITS) {
    apply(fit);
    if (fits()) return fit;
  }
  return 'tight';
}

/** The tab strip overflows when its content is wider than its box (1 px of sub-pixel rounding allowed). */
export function stripFits(strip: { scrollWidth: number; clientWidth: number }): boolean {
  return strip.scrollWidth <= strip.clientWidth + 1;
}
