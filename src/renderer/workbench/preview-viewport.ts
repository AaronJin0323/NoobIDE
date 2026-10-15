/**
 * Where the preview's native view goes inside the stage (S15.3) and when something of the workbench is drawn over
 * it (S15.5/S15.6). Pure so the rules are unit-tested; PreviewPane applies them.
 *
 * PLAN §3: the mobile choice changes only the viewport WIDTH. It is not device emulation — no user agent, touch,
 * device pixel ratio or OS chrome changes — and the UI says so.
 */

export type ViewportWidth = 'desktop' | 'mobile';

/** CSS pixel width of the "mobile" choice: a common phone layout width. */
export const MOBILE_WIDTH = 375;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The page's rectangle in workbench CSS pixels. Desktop fills the stage; mobile is MOBILE_WIDTH wide and centred
 * (or the whole stage when the stage is narrower than that).
 */
export function viewRect(stage: Rect, viewport: ViewportWidth): Rect {
  if (viewport === 'desktop' || stage.width <= MOBILE_WIDTH) return stage;
  return {
    x: stage.x + Math.floor((stage.width - MOBILE_WIDTH) / 2),
    y: stage.y,
    width: MOBILE_WIDTH,
    height: stage.height,
  };
}

/** True when two rectangles share any area (touching edges do not count). */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Elements drawn above the workbench: modal backdrops, dialogs and DOM menus. The native view is always on top of
 * the page's DOM, so while one of these overlaps the stage the view must be hidden or it would cover the overlay.
 */
export const OVERLAY_SELECTOR = [
  '.dialog-backdrop',
  '.recovery-backdrop',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[data-covers-preview]',
].join(', ');

/** Whether any shown overlay rectangle overlaps the stage. */
export function coveredBy(stage: Rect, overlays: readonly Rect[]): boolean {
  return overlays.some((rect) => rect.width > 0 && rect.height > 0 && overlaps(stage, rect));
}
