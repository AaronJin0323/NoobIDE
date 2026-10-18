/**
 * Idle stop for Monaco's TypeScript/JavaScript language worker (S59.5, docs/perf/memory.md). Monaco stops its idle
 * HTML/CSS/JSON workers after 2 minutes and the editor worker after 5, but never the TypeScript worker, which holds
 * ~83 MB (ES + DOM type libraries) for as long as the app runs once a `.js` file has been opened.
 *
 * How it stops without losing anything:
 *
 * - Monaco's (private) TypeScript `WorkerManager` creates its worker lazily in `getLanguageServiceWorker` and drops it
 *   in `_stopWorker`. Every language feature (diagnostics, completion, hover, F12, the AI fix check) asks for the
 *   worker through `getLanguageServiceWorker` on every request, so wrapping that method sees all use.
 * - After `idleMs` without a request — and only while no request is waiting for its reply (the supervisor's view) —
 *   `_stopWorker()` is called directly. Unlike re-applying the compiler options (the S18.4 crash restart), this does
 *   NOT fire `onDidChange`, so the diagnostics adapter does not re-validate every model and immediately start a new
 *   worker. Existing markers stay where they are: they live in the main thread's marker service.
 * - The next request creates a fresh worker. NoobIDE turns on eager model sync (language-config.ts), so the new
 *   worker receives every open JavaScript model, and the project-script extra libs are part of its creation data.
 *   The cost is the worker's start (~1 s) on the first request after a long pause.
 *
 * If a Monaco upgrade renames the private members, `installTsIdleStop` returns false and nothing is stopped (the
 * test beside this file pins the members against the installed Monaco source so that the upgrade notices).
 *
 * DOM-free (injected clock and timers) so it is unit-tested.
 */

/** The part of Monaco's TypeScript `WorkerManager` this module relies on (private members; see the pin test). */
export interface TsWorkerManagerLike {
  getLanguageServiceWorker(...resources: unknown[]): Promise<unknown>;
  _stopWorker(): void;
  /** The running worker client, or null when none is running. */
  _worker: unknown;
}

/** No TypeScript request for this long = stop the worker (Monaco's editor worker uses the same period). */
export const TS_WORKER_IDLE_MS = 5 * 60_000;
export const TS_IDLE_CHECK_MS = 30_000;

export interface TsIdleStopOptions {
  /** Whether a request to a live TypeScript worker is still waiting for its reply (WorkerSupervisor.busy('ts')). */
  readonly busy: () => boolean;
  /** Told when every tracked worker is stopped, so the supervisor stops watching it (WorkerSupervisor.retire('ts')). */
  readonly retire: () => void;
  readonly idleMs?: number;
  readonly checkEveryMs?: number;
  readonly now?: () => number;
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  /** Told about each stop (metadata only). */
  readonly onStop?: () => void;
}

export class TsWorkerIdleStop {
  private readonly lastUse = new Map<TsWorkerManagerLike, number>();
  private timer: unknown = null;
  private stops = 0;
  private readonly idleMs: number;
  private readonly checkEveryMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: TsIdleStopOptions) {
    this.idleMs = options.idleMs ?? TS_WORKER_IDLE_MS;
    this.checkEveryMs = options.checkEveryMs ?? TS_IDLE_CHECK_MS;
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    this.clearTimer = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  /** How many times a worker was stopped for being idle (e2e / diagnostics). */
  get stopCount(): number {
    return this.stops;
  }

  /** A request is about to go to this manager's worker (starting one if none runs). */
  touch(manager: TsWorkerManagerLike): void {
    this.lastUse.set(manager, this.now());
    if (this.timer === null) this.timer = this.setTimer(() => this.check(), this.checkEveryMs);
  }

  /** One check (the timer calls this; tests call it directly). */
  check(): void {
    if (this.options.busy()) return;
    const now = this.now();
    let stopped = false;
    for (const [manager, last] of this.lastUse) {
      if (!manager._worker || now - last < this.idleMs) continue;
      try {
        manager._stopWorker();
      } catch {
        continue;
      }
      stopped = true;
      this.stops += 1;
      this.options.onStop?.();
    }
    if (stopped && [...this.lastUse.keys()].every((manager) => !manager._worker)) this.options.retire();
  }

  dispose(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.lastUse.clear();
  }
}

/**
 * Wraps `getLanguageServiceWorker` on Monaco's TypeScript WorkerManager prototype so every request touches the idle
 * stop. Returns false (and changes nothing) when the private members it needs are missing.
 */
export function installTsIdleStop(
  prototype: Partial<TsWorkerManagerLike> | undefined,
  idle: TsWorkerIdleStop,
): boolean {
  if (!prototype) return false;
  const original = prototype.getLanguageServiceWorker;
  if (typeof original !== 'function' || typeof prototype._stopWorker !== 'function') return false;
  prototype.getLanguageServiceWorker = function (this: TsWorkerManagerLike, ...resources: unknown[]) {
    idle.touch(this);
    return original.apply(this, resources);
  };
  return true;
}
