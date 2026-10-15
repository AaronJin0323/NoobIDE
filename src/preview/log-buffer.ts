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

  /**
   * An IDE notice about the page (`entry.notice`: a denied permission, a stopped flood). Never dropped for a full
   * batch — it explains what happened to the page — and bounded by its producers (once per kind and page load).
   */
  pushNotice(entry: PreviewLogEntry): void {
    this.entries.push(entry);
  }

  /** Messages the page's console rate limit suppressed (docs/decisions/0016): counted, never seen by main. */
  addDropped(count: number): void {
    if (Number.isSafeInteger(count) && count > 0)
      this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + count);
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

export const MAX_LOG_URL_LENGTH = 500;

/**
 * The form of a page-supplied URL kept in records (S05.5, AGENTS.md "Logs never contain source code"): credentials
 * removed; `data:` and `javascript:` URLs (which carry content, possibly code) reduced to their scheme and media
 * type; anything longer than MAX_LOG_URL_LENGTH truncated with "…". Ordinary http(s) URLs of project files are
 * unchanged, so file and line attribution keeps working.
 */
export function sanitizeLogUrl(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme === 'data') {
    const type = /^data:([\w.+-]{1,60}\/[\w.+-]{1,60})?/i.exec(url)?.[1] ?? '';
    return `data:${type},… (${url.length})`;
  }
  if (scheme === 'javascript') return `javascript:… (${url.length})`;
  let out = url;
  if (scheme === 'http' || scheme === 'https' || scheme === 'ws' || scheme === 'wss') {
    try {
      const u = new URL(url);
      if (u.username !== '' || u.password !== '') {
        u.username = '';
        u.password = '';
        out = u.href;
      }
    } catch {
      // not parseable: only truncated below
    }
  }
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u001f\u007f]/g, '');
  return out.length > MAX_LOG_URL_LENGTH ? `${out.slice(0, MAX_LOG_URL_LENGTH)}…` : out;
}
