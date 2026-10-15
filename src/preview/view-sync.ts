/**
 * Pure helpers that keep the preview WebContentsView in step with the workbench (S15.1, S15.5, S15.6). Main only
 * applies the results; the rules are unit-tested here.
 */

export interface CssRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ViewRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Workbench CSS pixels → window DIPs (the view's coordinate space). At fractional scale factors (Windows 125/150 %,
 * a zoomed workbench) element rects are fractional; rounding the four edges — not x and width separately — keeps the
 * view's right and bottom edges on the stage's edges, so it never drifts a pixel past a splitter or leaves a gap.
 */
export function toViewBounds(rect: CssRect, zoom: number): ViewRect {
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const left = Math.round(rect.x * factor);
  const top = Math.round(rect.y * factor);
  const right = Math.round((rect.x + rect.width) * factor);
  const bottom = Math.round((rect.y + rect.height) * factor);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export interface KeyInput {
  readonly type: string;
  readonly key: string;
  readonly shift: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

/**
 * Keyboard focus handoff out of the page (S15.5/S15.6): F6 / Shift+F6 pressed while the preview page has the focus
 * move it back to the workbench's next / previous region, as F6 does everywhere else (S24.3). Without this a
 * keyboard user who entered the page could not leave it: Tab cycles inside the page.
 */
export function focusHandoffStep(input: KeyInput): 1 | -1 | null {
  if (input.type !== 'keyDown' || input.key !== 'F6') return null;
  if (input.control || input.alt || input.meta) return null;
  return input.shift ? -1 : 1;
}

/**
 * Loading a page into a WebContentsView gives it the keyboard focus (observed on macOS: Start and Refresh both
 * moved the focus into the page). After a save refreshes the preview, the user's next key presses would then go to
 * the page instead of the editor. The guard remembers whether the workbench had the focus when a load began and,
 * while that load runs (plus a short grace period for late focus changes), says to hand the focus back. An
 * explicit request (Enter on the stage) always wins.
 */
export class FocusGuard {
  private active = false;
  private until = Number.POSITIVE_INFINITY;

  constructor(private readonly graceMs = 500) {}

  /** A start or refresh begins; `workbenchFocused` is whether the workbench page had the keyboard focus. */
  loadStarted(workbenchFocused: boolean): void {
    this.active = workbenchFocused;
    this.until = Number.POSITIVE_INFINITY;
  }

  /** The page stopped loading at `now`; late focus changes within the grace period are still returned. */
  loadFinished(now: number): void {
    if (this.active) this.until = now + this.graceMs;
  }

  /** The user asked for the page to have the focus. */
  userFocused(): void {
    this.active = false;
  }

  /** The page received the focus at `now`: true when it should go back to the workbench. */
  shouldReturnFocus(now: number): boolean {
    if (!this.active) return false;
    if (now > this.until) {
      this.active = false;
      return false;
    }
    return true;
  }
}
