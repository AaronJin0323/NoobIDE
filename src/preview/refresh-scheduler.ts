/**
 * S14.2 automatic refresh timing (PLAN §3 "automatically refresh the preview after a successful save"). The preview
 * reloads only after a confirmed write *and* a pause in typing: a save that lands while the user is still typing
 * (autosave, or ⌘S mid-sentence) waits until no key was pressed in the editor for `quietMs`, so the page does not
 * reload under the user's fingers on every autosave. A save after a pause refreshes at once.
 *
 * Pure apart from the injected clock and timer, so the rules are unit-tested with fake time.
 */
export interface RefreshSchedulerOptions {
  /** Typing pause before a pending refresh may run. */
  readonly quietMs: number;
  readonly refresh: () => void;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export const DEFAULT_TYPING_PAUSE_MS = 400;

export class RefreshScheduler {
  private pending = false;
  private lastTyping = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: RefreshSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Whether a refresh is waiting for the typing pause. */
  get waiting(): boolean {
    return this.pending;
  }

  /** A file was saved successfully (confirmed write). */
  saved(): void {
    this.pending = true;
    this.arm();
  }

  /** A key was typed in the editor. Only delays a pending refresh; typing alone never refreshes. */
  typing(): void {
    this.lastTyping = this.now();
    if (this.pending) this.arm();
  }

  /** The preview stopped or switched: nothing pending any more. */
  cancel(): void {
    this.pending = false;
    this.disarm();
  }

  private arm(): void {
    this.disarm();
    const wait = this.lastTyping + this.options.quietMs - this.now();
    if (wait <= 0) {
      this.fire();
      return;
    }
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.arm(); // typing may have moved the pause; re-check
    }, wait);
  }

  private fire(): void {
    this.pending = false;
    this.options.refresh();
  }

  private disarm(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}
