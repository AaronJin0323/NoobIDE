import type { IpcResult } from '../../shared/ipc/contract';
import type { JournalRecordRequest, JournalSavedRequest } from '../../shared/ipc/recovery-contract';

/**
 * Decides when the renderer sends an unsaved buffer to the crash-recovery journal (S12.1). Independent of undo,
 * autosave and history: it never saves the file, it only keeps a copy in app data until the file is saved.
 *
 * Edits are coalesced: a copy is sent `DEBOUNCE_MS` after typing pauses, and at the latest `MAX_WAIT_MS` after the
 * first unsent edit, so a dirty buffer reaches the journal within 2 s even while the user keeps typing.
 */
export const JOURNAL_DEBOUNCE_MS = 400;
export const JOURNAL_MAX_WAIT_MS = 1200;
/** A failed copy is sent again after this delay, doubling up to `JOURNAL_RETRY_MAX_MS`, until it succeeds. */
export const JOURNAL_RETRY_MS = 2000;
export const JOURNAL_RETRY_MAX_MS = 16_000;
/** Failures that a retry of the same text cannot fix; the next edit tries again. */
const NOT_RETRIED = new Set(['too-large', 'unknown-project', 'invalid-request', 'forbidden-sender']);

export interface JournalSink {
  record(request: JournalRecordRequest): Promise<IpcResult<{ written: boolean }, string>>;
  discardSaved(request: JournalSavedRequest): Promise<IpcResult<{ removed: boolean }, string>>;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface JournalBuffer {
  readonly projectId: string;
  readonly relPath: string;
  readonly bufferId: string;
  readonly bom: boolean;
  /**
   * Revision of the journal record this buffer continues (a restored crash copy), else 0. Editor revisions start at
   * 0 for every loaded buffer; the journal sees `baseRevision + revision`, so it stays monotonic.
   */
  readonly baseRevision: number;
}

/** Last journal failure, for the UI ("recovery copy could not be written"); `null` while writes succeed. */
export type JournalHealth = string | null;

export class JournalScheduler {
  private buffer: JournalBuffer | null = null;
  /** The BOM copies are sent with: the buffer's at `begin`, then the disk's after a reload (`setBom`). */
  private bom = false;
  private pending: { revision: number; getText: () => string } | null = null;
  private firstUnsentAt: number | null = null;
  private timer: unknown = null;
  private retryDelay = JOURNAL_RETRY_MS;

  constructor(
    private readonly sink: JournalSink,
    private readonly timers: Timers,
    private readonly onHealth: (health: JournalHealth) => void = () => undefined,
  ) {}

  /** A file was loaded into the editor (or restored). Forgets any unsent edit of the previous buffer. */
  begin(buffer: JournalBuffer | null): void {
    this.cancel();
    this.buffer = buffer;
    this.bom = buffer?.bom ?? false;
    this.retryDelay = JOURNAL_RETRY_MS;
    this.onHealth(null);
  }

  /**
   * The file's BOM changed on disk (a reload of a version written outside NoobIDE): copies sent from now on carry
   * it, so a restored crash copy is saved with the file's current BOM.
   */
  setBom(bom: boolean): void {
    if (this.buffer) this.bom = bom;
  }

  /** The buffer changed; `getText` is read when the copy is actually sent, so the newest text goes out. */
  edited(revision: number, getText: () => string): void {
    if (!this.buffer) return;
    this.pending = { revision, getText };
    const now = this.timers.now();
    this.firstUnsentAt ??= now;
    const due = Math.min(now + JOURNAL_DEBOUNCE_MS, this.firstUnsentAt + JOURNAL_MAX_WAIT_MS);
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => void this.flush(), Math.max(0, due - now));
  }

  /** `revision` is on disk now: drop an unsent copy that is not newer and remove the journal record. */
  saved(revision: number): void {
    const buffer = this.buffer;
    if (!buffer) return;
    if (this.pending && this.pending.revision <= revision) this.cancel();
    void this.sink
      .discardSaved({
        projectId: buffer.projectId,
        relPath: buffer.relPath,
        bufferId: buffer.bufferId,
        revision: buffer.baseRevision + revision,
      })
      .then((result) => {
        // Everything is on disk: a past journal failure no longer puts edits at risk.
        if (result.ok && this.buffer === buffer && !this.pending) this.onHealth(null);
      })
      .catch(() => undefined);
  }

  /** Sends the unsent copy now (also used when the window is about to close). */
  async flush(): Promise<void> {
    const buffer = this.buffer;
    const pending = this.pending;
    this.cancel();
    if (!buffer || !pending) return;
    let failure: string | null;
    try {
      const result = await this.sink.record({
        projectId: buffer.projectId,
        relPath: buffer.relPath,
        bufferId: buffer.bufferId,
        revision: buffer.baseRevision + pending.revision,
        text: pending.getText(),
        bom: this.bom,
      });
      failure = result.ok ? null : result.code;
    } catch {
      failure = 'write-failed';
    }
    if (this.buffer !== buffer) return; // another file was loaded meanwhile
    this.onHealth(failure);
    if (failure === null) {
      this.retryDelay = JOURNAL_RETRY_MS;
    } else if (!NOT_RETRIED.has(failure) && this.pending === null) {
      // Transient failures (a virus scanner holding the file, a full journal the user may clear): try again, so the
      // copy on disk does not silently stay older than the editor.
      this.pending = pending;
      this.timer = this.timers.setTimeout(() => void this.flush(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, JOURNAL_RETRY_MAX_MS);
    }
  }

  /** Sends the current text again (e.g. after the journal was cleared while this buffer has unsaved edits). */
  resend(revision: number, getText: () => string): void {
    this.edited(revision, getText);
  }

  private cancel(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.firstUnsentAt = null;
  }
}

export const browserTimers: Timers = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
  now: () => Date.now(),
};

/** Random id for a newly loaded buffer (crypto.randomUUID is available in the sandboxed renderer). */
export function newBufferId(): string {
  return crypto.randomUUID();
}
