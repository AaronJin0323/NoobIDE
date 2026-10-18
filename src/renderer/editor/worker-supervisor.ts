/**
 * Language-worker recovery (S18.4). Monaco's language services run in web workers; if one crashes, is killed or hangs,
 * Monaco keeps waiting for it and completion, hover and diagnostics silently stop. The supervisor watches every
 * worker NoobIDE creates:
 *
 * - Monaco talks to its workers by request/reply. A request that gets no message back for `stallMs` means the worker
 *   is dead or stuck (a killed worker never answers; a hung one never finishes).
 * - An `error` event on the worker means it crashed.
 *
 * Either way the supervisor terminates it and asks the language to restart (`restart(kind)`, which makes Monaco drop
 * its client and create a fresh worker on the next request — see monaco-setup.ts). Editing never waits for this: the
 * buffer lives in the main thread, so the editor stays usable while a worker is replaced.
 *
 * DOM-free (structural Worker type, injected clock and timers) so it is unit-tested.
 */
export type WorkerKind = 'css' | 'html' | 'json' | 'ts' | 'editor';

export interface WorkerLike {
  postMessage(message: unknown, transfer?: unknown): void;
  addEventListener(type: 'message' | 'error', listener: () => void): void;
  terminate(): void;
}

export interface SupervisorOptions {
  /** Restarts the language service of this kind (Monaco creates a new worker on the next request). */
  readonly restart: (kind: WorkerKind) => void;
  /** No reply for this long while a request is outstanding = dead or stuck. */
  readonly stallMs?: number;
  readonly checkEveryMs?: number;
  readonly now?: () => number;
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  /** Told about each restart (metadata only: kind and reason). */
  readonly onRestart?: (event: { kind: WorkerKind; reason: 'stalled' | 'error' }) => void;
}

/** A worker that keeps dying is not restarted in a loop: at most this many restarts per kind per minute. */
export const MAX_RESTARTS_PER_MINUTE = 5;

interface Watched {
  readonly kind: WorkerKind;
  readonly worker: WorkerLike;
  /** Time of the oldest request sent since the last message from the worker; null when nothing is outstanding. */
  waitingSince: number | null;
  dead: boolean;
}

export const DEFAULT_STALL_MS = 15_000;

export class WorkerSupervisor {
  private readonly watched = new Set<Watched>();
  private timer: unknown = null;
  private readonly stallMs: number;
  private readonly checkEveryMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private restarts = 0;
  private readonly recent = new Map<WorkerKind, number[]>();

  constructor(private readonly options: SupervisorOptions) {
    this.stallMs = options.stallMs ?? DEFAULT_STALL_MS;
    this.checkEveryMs = options.checkEveryMs ?? 1_000;
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    this.clearTimer = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  get restartCount(): number {
    return this.restarts;
  }

  /** Starts watching a newly created worker; returns it (so `getWorker` can `return supervisor.watch(...)`). */
  watch<W extends WorkerLike>(kind: WorkerKind, worker: W): W {
    const entry: Watched = { kind, worker, waitingSince: null, dead: false };
    this.watched.add(entry);
    const send = worker.postMessage.bind(worker);
    worker.postMessage = (message: unknown, transfer?: unknown) => {
      if (!entry.dead && entry.waitingSince === null) entry.waitingSince = this.now();
      if (transfer === undefined) send(message);
      else send(message, transfer);
    };
    worker.addEventListener('message', () => {
      entry.waitingSince = null;
    });
    worker.addEventListener('error', () => this.replace(entry, 'error'));
    this.ensureTimer();
    return worker;
  }

  /** Workers of a kind that are being watched and not replaced (e2e: to kill one on purpose). */
  live(kind: WorkerKind): WorkerLike[] {
    return [...this.watched].filter((w) => w.kind === kind && !w.dead).map((w) => w.worker);
  }

  /** Whether a request to a live worker of this kind is still waiting for its reply (S59.5: never stop it then). */
  busy(kind: WorkerKind): boolean {
    return [...this.watched].some((w) => w.kind === kind && !w.dead && w.waitingSince !== null);
  }

  /**
   * Stops watching the live workers of a kind and terminates them, without a restart (S59.5: the TypeScript worker's
   * idle stop; Monaco creates a fresh one on the next request, and `watch` sees it). Returns how many there were.
   */
  retire(kind: WorkerKind): number {
    const entries = [...this.watched].filter((w) => w.kind === kind && !w.dead);
    for (const entry of entries) {
      entry.dead = true;
      this.watched.delete(entry);
      try {
        entry.worker.terminate();
      } catch {
        // Already gone.
      }
    }
    return entries.length;
  }

  /** One check (the timer calls this; tests call it directly). */
  check(): void {
    const now = this.now();
    for (const entry of [...this.watched]) {
      if (entry.waitingSince !== null && now - entry.waitingSince >= this.stallMs) this.replace(entry, 'stalled');
    }
  }

  dispose(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.watched.clear();
  }

  private replace(entry: Watched, reason: 'stalled' | 'error'): void {
    if (entry.dead) return;
    entry.dead = true;
    this.watched.delete(entry);
    try {
      entry.worker.terminate();
    } catch {
      // Already gone.
    }
    const now = this.now();
    const recent = (this.recent.get(entry.kind) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= MAX_RESTARTS_PER_MINUTE) return;
    this.recent.set(entry.kind, [...recent, now]);
    this.restarts += 1;
    this.options.onRestart?.({ kind: entry.kind, reason });
    this.options.restart(entry.kind);
  }

  private ensureTimer(): void {
    if (this.timer === null) this.timer = this.setTimer(() => this.check(), this.checkEveryMs);
  }
}
