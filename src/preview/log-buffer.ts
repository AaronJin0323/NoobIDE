import type { PreviewLogEntry } from '../shared/ipc/preview-contract';

/**
 * Bounded buffer between a preview page and the workbench (S05.3, PLAN §9 "limit log volume and display frequency").
 *
 * A page that logs in a tight loop must not slow down the IDE. Main pushes every record here (O(1), no allocation
 * beyond the entry) and flushes at most once per interval: a batch holds at most `maxBatch` entries plus the count
 * of entries dropped since the previous flush. Messages are truncated to `maxMessageLength`.
 */
export interface LogBufferOptions {
  readonly maxBatch: number;
  readonly maxMessageLength: number;
}

export const DEFAULT_LOG_BUFFER: LogBufferOptions = { maxBatch: 200, maxMessageLength: 2_000 };

export interface LogBatch {
  readonly entries: PreviewLogEntry[];
  readonly dropped: number;
  /** Capture was paused during this interval, so more messages were skipped than `dropped` counts. */
  readonly throttled: boolean;
}

export class LogBuffer {
  private entries: PreviewLogEntry[] = [];
  private dropped = 0;
  private throttled = false;

  constructor(private readonly options: LogBufferOptions = DEFAULT_LOG_BUFFER) {}

  push(entry: PreviewLogEntry): void {
    if (this.entries.length >= this.options.maxBatch) {
      // Keep the first records of a burst: the first error is usually the cause, later ones are consequences.
      this.dropped += 1;
      return;
    }
    const max = this.options.maxMessageLength;
    this.entries.push(entry.message.length > max ? { ...entry, message: `${entry.message.slice(0, max)}…` } : entry);
  }

  /** The producer skipped messages without counting them (see the console flood guard). */
  markThrottled(): void {
    this.throttled = true;
  }

  get pending(): number {
    return this.entries.length + this.dropped;
  }

  /** Returns the pending batch and starts a new one; null when there is nothing to send. */
  take(): LogBatch | null {
    if (this.entries.length === 0 && this.dropped === 0 && !this.throttled) return null;
    const batch = { entries: this.entries, dropped: this.dropped, throttled: this.throttled };
    this.entries = [];
    this.dropped = 0;
    this.throttled = false;
    return batch;
  }

  clear(): void {
    this.entries = [];
    this.dropped = 0;
    this.throttled = false;
  }
}
