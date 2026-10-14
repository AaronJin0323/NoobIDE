import { INITIAL_SAVE, canSave, isUnsaved, saveReducer, type SaveEvent, type SaveSnapshot } from './save-machine';

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

/** S11.1: main refused the write because the file on disk is not the version the editor knows. */
export const CHANGED_ON_DISK = 'changed-on-disk';

/** Options of one write (S11.3: `create` re-creates a file deleted outside NoobIDE, never over an existing one). */
export interface WriteOptions {
  readonly create: boolean;
}

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
  readonly write: (text: string, options: WriteOptions) => Promise<WriteOutcome>;
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
  /** Restored crash copy not yet touched by the user: never written on the user's behalf (S12.2). */
  private hold = false;
  private disposed = false;
  /** S11.3: the next write re-creates the deleted file. */
  private createNext = false;
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

  /** True while the buffer holds a restored crash copy that the user has neither edited nor saved. */
  get held(): boolean {
    return this.hold && this.isUnsaved();
  }

  /**
   * Puts a recovered crash copy into the buffer as unsaved edits (S12.2). Autosave, blur and "save every file" leave
   * it alone — the recovery journal keeps it safe — until the user edits it or saves it explicitly.
   */
  restore(text: string): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.latestText = text;
    this.hold = true;
    this.apply({ type: 'edited' });
  }

  /** Records an edit synchronously and (re)starts the autosave pause. */
  edit(text: string): void {
    if (this.disposed) return;
    this.latestText = text;
    this.hold = false;
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
      // S11.3: a file deleted on disk is never "saved" by doing nothing; the user re-saves or closes it explicitly.
      if (!canSave(this.snapshot)) return !this.isUnsaved() && !this.snapshot.deleted;
      if (!(await this.writeOnce())) return false;
    }
  }

  /** One write of the current text. Only one runs at a time; only its owner clears the gate. */
  private writeOnce(): Promise<boolean> {
    const revision = this.snapshot.revision;
    const text = this.latestText;
    const create = this.createNext;
    this.apply({ type: 'saveStarted' });
    const pending = this.options.write(text, { create }).then(
      (outcome) => this.finish(outcome, revision, create),
      (error: unknown) =>
        this.finish(
          { ok: false, code: 'write-failed', message: error instanceof Error ? error.name : 'unknown' },
          revision,
          create,
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
    if (this.autosave && !this.composing && !this.hold && canSave(this.snapshot)) void this.save();
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

  // ── S11: external changes ──
  /** Resolves once no write is in flight (a disk check must not mistake our own write for someone else's). */
  async whenIdle(): Promise<void> {
    while (this.inflight) await this.inflight;
  }

  /**
   * The buffer now holds `text`, the version on disk: a clean buffer reloaded after an external change (S11.1), or
   * the user chose "use the disk version" in a conflict (S11.2). Nothing is left to write.
   */
  reload(text: string): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.latestText = text;
    this.hold = false;
    this.createNext = false;
    this.apply({ type: 'reloaded' });
  }

  /** S11.2 "keep my version": the conflict ends and the buffer is written over the disk version just compared. */
  keepMine(): Promise<boolean> {
    this.apply({ type: 'conflictResolved' });
    return this.save();
  }

  /** S11.3: the file is gone from disk. The text stays; autosave stops until the user re-saves or closes. */
  markDeleted(): void {
    if (this.snapshot.deleted) return;
    this.cancelTimer();
    this.apply({ type: 'deletedOnDisk' });
  }

  /** S11.3: the deleted file exists again (restored from the trash, undone in another program). */
  markReappeared(): void {
    if (this.snapshot.deleted) this.apply({ type: 'reappeared' });
  }

  /** S11.3 "save it again": re-creates the deleted file with the buffer's text (never over an existing file). */
  recreate(): Promise<boolean> {
    if (!this.snapshot.deleted) return this.save();
    this.createNext = true;
    this.apply({ type: 'reappeared' });
    if (!this.isUnsaved()) this.apply({ type: 'edited' }); // a clean buffer still has to be written
    return this.save();
  }
  // ── end S11 ──

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

  private finish(outcome: WriteOutcome, revision: number, created: boolean): boolean {
    if (created) this.createNext = false;
    if (outcome.ok) {
      this.apply({ type: 'saveSucceeded', revision });
      for (const listener of [...this.savedListeners]) listener({ revision });
    } else {
      this.apply({ type: 'saveFailed', error: { code: outcome.code, message: outcome.message } });
      if (outcome.code === CHANGED_ON_DISK) {
        // S11.1: the check before write found someone else's version: never overwrite it, ask the user (S11.2).
        this.apply({ type: 'externalChange' });
        this.cancelTimer();
      } else if (created && outcome.code === 'not-found') {
        this.apply({ type: 'deletedOnDisk' }); // its folder is gone too: still deleted, the text stays here
      }
    }
    return outcome.ok;
  }

  private schedule(): void {
    if (!this.autosave || this.composing || this.disposed || this.hold) return;
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

export type SaveEveryResult<K> = { readonly ok: true } | { readonly ok: false; readonly failed: K };

/**
 * Saves every open file until one full pass finds nothing unsaved (before a project switch or a window close).
 * A single pass is not enough: while file B is being written, the user can still type in file A, which was already
 * saved in this pass. `entries` is read again on every pass so tabs opened meanwhile are included.
 */
export async function saveEvery<K>(entries: () => Iterable<readonly [K, DocumentSaver]>): Promise<SaveEveryResult<K>> {
  for (;;) {
    for (const [key, saver] of [...entries()]) {
      if (saver.held) continue; // a restored crash copy stays in the journal until the user decides
      if (!(await saver.save())) return { ok: false, failed: key };
    }
    if (![...entries()].some(([, saver]) => !saver.held && isUnsaved(saver.state))) return { ok: true };
  }
}
