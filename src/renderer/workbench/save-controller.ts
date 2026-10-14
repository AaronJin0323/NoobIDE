import { INITIAL_SAVE, canSave, saveReducer, type SaveEvent, type SaveSnapshot } from './save-machine';

/**
 * Save pipeline of one open file (S10.2, PLAN §7): edit → coalesce writes over a short pause → write (temp file +
 * replace, in main) → confirm → update status → notify "saved" (the preview refreshes on that, S10.5).
 *
 * - Edits are counted synchronously: the text a write carries and the revision it records always match.
 * - Writes are serialized; a save requested during a write waits for it and then writes the newer text.
 * - Autosave runs after a typing pause and when the editor loses focus, never during IME composition.
 * - On failure the text stays here and in the editor; the status says why. Nothing is retried in a loop: the next
 *   edit, focus change or the user's retry tries again.
 * - The "saved" listeners run strictly after the write was confirmed and the status was updated; never on failure.
 */
export type WriteOutcome =
  { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string };

export interface SavedNotice {
  readonly revision: number;
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const AUTOSAVE_DELAY_MS = 1000;

export interface DocumentSaverOptions {
  readonly initialText: string;
  /** Writes the text to the file; resolves once main confirmed (or refused) the write. Must not throw. */
  readonly write: (text: string) => Promise<WriteOutcome>;
  /** Called with every new snapshot, after it is applied. */
  readonly onState?: (snapshot: SaveSnapshot) => void;
  readonly autosave?: boolean;
  readonly autosaveDelayMs?: number;
  readonly timers?: Timers;
}

const realTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class DocumentSaver {
  private snapshot: SaveSnapshot = INITIAL_SAVE;
  private latestText: string;
  private inflight: Promise<boolean> | null = null;
  private timer: unknown = null;
  private composing = false;
  private disposed = false;
  private readonly savedListeners = new Set<(notice: SavedNotice) => void>();
  private readonly autosave: boolean;
  private readonly delay: number;
  private readonly timers: Timers;

  constructor(private readonly options: DocumentSaverOptions) {
    this.latestText = options.initialText;
    this.autosave = options.autosave ?? true;
    this.delay = options.autosaveDelayMs ?? AUTOSAVE_DELAY_MS;
    this.timers = options.timers ?? realTimers;
  }

  get state(): SaveSnapshot {
    return this.snapshot;
  }

  /** The newest text, including edits not on disk yet. */
  get text(): string {
    return this.latestText;
  }

  get busy(): boolean {
    return this.inflight !== null;
  }

  /** Records an edit synchronously and (re)starts the autosave pause. */
  edit(text: string): void {
    if (this.disposed) return;
    this.latestText = text;
    this.apply({ type: 'edited' });
    this.schedule();
  }

  /**
   * Manual save (Ctrl/Cmd+S, retry) and the flush before closing a tab, switching projects or closing the window.
   * Waits for a write in flight, then writes until nothing is unsaved: edits typed during a write are written too.
   * Resolves true only when the newest text is confirmed on disk; false when a write failed (or over a conflict).
   */
  async save(): Promise<boolean> {
    this.cancelTimer();
    for (;;) {
      while (this.inflight) await this.inflight;
      if (!canSave(this.snapshot)) return !this.isUnsaved();
      if (!(await this.writeOnce())) return false;
    }
  }

  /** One write of the current text. Only one runs at a time; only its owner clears the gate. */
  private writeOnce(): Promise<boolean> {
    const revision = this.snapshot.revision;
    const text = this.latestText;
    this.apply({ type: 'saveStarted' });
    const pending = this.options.write(text).then(
      (outcome) => this.finish(outcome, revision),
      (error: unknown) =>
        this.finish(
          { ok: false, code: 'write-failed', message: error instanceof Error ? error.name : 'unknown' },
          revision,
        ),
    );
    const gate: Promise<boolean> = pending.finally(() => {
      if (this.inflight === gate) this.inflight = null;
    });
    this.inflight = gate;
    return gate;
  }

  /** The editor lost focus: write now instead of waiting for the pause (unless an IME composition is open). */
  blur(): void {
    if (this.autosave && !this.composing && canSave(this.snapshot)) void this.save();
  }

  /** IME composition (e.g. Pinyin) started: autosave waits, so half-composed text is never written. */
  compositionStart(): void {
    this.composing = true;
    this.cancelTimer();
  }

  compositionEnd(): void {
    this.composing = false;
    this.schedule();
  }

  /** The file changed on disk (S11.1 watcher). Unsaved edits turn into a conflict; autosave stops. */
  externalChange(): void {
    this.apply({ type: 'externalChange' });
    if (this.snapshot.conflict) this.cancelTimer();
  }

  /** Subscribes to confirmed writes. Returns the unsubscribe function. */
  onSaved(listener: (notice: SavedNotice) => void): () => void {
    this.savedListeners.add(listener);
    return () => this.savedListeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.savedListeners.clear();
  }

  private isUnsaved(): boolean {
    return this.snapshot.revision !== this.snapshot.savedRevision;
  }

  private finish(outcome: WriteOutcome, revision: number): boolean {
    if (outcome.ok) {
      this.apply({ type: 'saveSucceeded', revision });
      for (const listener of [...this.savedListeners]) listener({ revision });
    } else {
      this.apply({ type: 'saveFailed', error: { code: outcome.code, message: outcome.message } });
    }
    return outcome.ok;
  }

  private schedule(): void {
    if (!this.autosave || this.composing || this.disposed) return;
    this.cancelTimer();
    if (!canSave(this.snapshot)) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (!this.composing && !this.disposed && canSave(this.snapshot)) void this.save();
    }, this.delay);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private apply(event: SaveEvent): void {
    this.snapshot = saveReducer(this.snapshot, event);
    if (!this.disposed) this.options.onState?.(this.snapshot);
  }
}
