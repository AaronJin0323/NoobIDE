/**
 * The caret stops blinking after a pause in editing (docs/perf/memory.md, decision 0024).
 *
 * A blinking caret makes Chromium produce a new frame every 0.5 s for as long as the editor has focus, which keeps the
 * GPU process's swap-chain and raster buffers alive: measured on macOS arm64 the GPU process holds ~170 MB with a
 * blinking caret and ~45 MB once frames stop. So the caret blinks while the user is active (where it helps find the
 * insertion point) and turns solid — still fully visible — after `restAfterMs` without input, like GNOME's
 * cursor-blink-timeout (10 s). Any key, click, cursor move or focus makes it blink again.
 *
 * DOM-free (injected timers) so it is unit-tested.
 */
export const CARET_REST_AFTER_MS = 10_000;

export interface CaretRestOptions {
  /** Called only on a change: true = blink, false = solid. */
  readonly setBlinking: (blinking: boolean) => void;
  readonly restAfterMs?: number;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

export class CaretRest {
  private blinking = true;
  private timer: unknown = null;
  private disposed = false;
  private readonly restAfterMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: CaretRestOptions) {
    this.restAfterMs = options.restAfterMs ?? CARET_REST_AFTER_MS;
    this.setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.schedule();
  }

  /** The user did something in the editor: blink (if resting) and restart the pause. */
  activity(): void {
    if (this.disposed) return;
    if (!this.blinking) {
      this.blinking = true;
      this.options.setBlinking(true);
    }
    this.schedule();
  }

  get isBlinking(): boolean {
    return this.blinking;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.disposed || !this.blinking) return;
      this.blinking = false;
      this.options.setBlinking(false);
    }, this.restAfterMs);
  }
}
