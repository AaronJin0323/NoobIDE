/**
 * Runtime capture adapter (S16.2–S16.6, PLAN §9): turns what the preview reports into ProblemRecords.
 *
 * Fed by the main process (src/main/problems-bridge.ts, from the PreviewManager's capture hook) with the raw records
 * of decision 0010 — Chromium's "Uncaught …" console records (syntax errors, exceptions, unhandled rejections, module
 * errors), console errors and warnings, failed requests — and the page lifecycle. Pure: no Electron, so it is tested
 * with plain objects.
 *
 * - Mapping: src/preview/to-problem.ts (served URL → project-relative path, initiator file, cross-origin URL kept
 *   as data).
 * - Attribution (S16.3): every preview start is a new session; every committed main-frame navigation (first load,
 *   refresh, save-triggered reload) makes its page load current. Generation numbers are the preview's own
 *   (`PreviewStatus.generation`, passed in by the PreviewManager), not a second counter. An event belongs to the generation whose document was current
 *   when it arrived: messages the old page sends while the next load is still in flight stay with the old
 *   generation; only the new document's own request is attributed to the pending one. A record whose latest
 *   occurrence is not in the current generation is listed with `stale: true`.
 * - Volume (S16.5): a bounded ProblemStore — dedupe with counts (first original and latest repeat kept verbatim),
 *   token-bucket rate limit for new records, per-source LRU ring buffer — and change notifications coalesced to at
 *   most one per `publishMs`.
 *
 * Privacy: records hold the browser's messages and URLs only. Nothing here logs.
 */
import type { PreviewLogEntry } from '../shared/ipc/preview-contract';
import type { PreviewAttribution, ProblemRecord } from '../shared/problem';
import { previewEntryToProblem } from '../preview/to-problem';
import { ProblemStore, type ProblemStoreOptions, type StoreStats } from './store';

export interface RuntimeSession {
  readonly projectId: string;
  /** e.g. 'http://127.0.0.1:51734' — the preview server's origin; URLs on it map to project files. */
  readonly origin: string;
}

export interface RuntimeSnapshot {
  readonly projectId: string | null;
  /** The page load events are currently attributed to; null before the first load of a session. */
  readonly current: PreviewAttribution | null;
  /** All records of the project, oldest first, with `stale` set on those not seen in the current generation. */
  readonly records: readonly ProblemRecord[];
  readonly stats: StoreStats;
}

export interface RuntimeCaptureOptions {
  /** Receives the coalesced snapshots. */
  readonly publish?: (snapshot: RuntimeSnapshot) => void;
  /** Minimum time between two published snapshots. Default 150 ms. */
  readonly publishMs?: number;
  readonly store?: ProblemStoreOptions;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** Hook the preview reports into (implemented by the adapter; see PreviewManagerDeps.capture). */
export interface PreviewCaptureSink {
  /** A preview started for the project; its server answers on `origin`. */
  sessionStarted(session: RuntimeSession): void;
  /**
   * A cross-document main-frame navigation began (first load, refresh). `generation` is the preview's own page-load
   * generation (`PreviewStatus.generation`, src/preview/state-machine.ts) of that load — the one counter that stale
   * marking (S16.3), the status bar and the one-click fix's load counting (S22.5) all use.
   */
  navigationStarted(generation: number): void;
  /** That navigation committed: the document of page load `generation` is current. */
  navigationCommitted(generation: number): void;
  /** One raw record from the page, in arrival order. */
  entry(entry: PreviewLogEntry): void;
  /** The preview stopped. Records are kept (and stay attributed to the session that produced them). */
  sessionEnded(): void;
}

let sessionCounter = 0;

export class RuntimeCapture implements PreviewCaptureSink {
  private readonly store: ProblemStore;
  private readonly now: () => number;
  private readonly publishMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private projectId: string | null = null;
  private origin: string | null = null;
  private sessionId: string | null = null;
  /** Preview generation (PreviewStatus.generation) of the current document; 0 until the session's first commit. */
  private generation = 0;
  private pending: number | null = null;
  private timer: unknown = null;
  private publishedRevision = -1;
  private publishedAttribution = '';

  constructor(private readonly options: RuntimeCaptureOptions = {}) {
    this.now = options.now ?? Date.now;
    this.store = new ProblemStore({ now: this.now, ...options.store });
    this.publishMs = options.publishMs ?? 150;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  sessionStarted(session: RuntimeSession): void {
    if (session.projectId !== this.projectId) {
      // Another project: its problems belong to that project only.
      this.store.clear();
      this.store.resetStats();
    }
    this.projectId = session.projectId;
    this.origin = session.origin;
    this.sessionId = `s${++sessionCounter}-${this.now().toString(36)}`;
    this.generation = 0;
    this.pending = null;
    this.schedule();
  }

  navigationStarted(generation: number): void {
    if (this.sessionId === null) return;
    this.pending = generation;
  }

  navigationCommitted(generation: number): void {
    if (this.sessionId === null) return;
    this.generation = generation;
    this.pending = null;
    this.schedule();
  }

  entry(entry: PreviewLogEntry): void {
    const projectId = this.projectId;
    const origin = this.origin;
    const sessionId = this.sessionId;
    if (projectId === null || origin === null || sessionId === null) return;
    // The new document's own request is part of the load in flight; everything else belongs to the current page.
    const generation =
      entry.source === 'network' && entry.resourceType === 'mainFrame' && this.pending !== null
        ? this.pending
        : this.generation;
    const input = previewEntryToProblem(entry, {
      projectId,
      preview: { sessionId, generation },
      previewOrigin: origin,
    });
    if (!input) return;
    this.store.add(input);
    this.schedule();
  }

  sessionEnded(): void {
    this.origin = null;
    this.pending = null;
    this.schedule();
  }

  /** Where new events are attributed right now. */
  current(): PreviewAttribution | null {
    return this.sessionId !== null && this.generation > 0
      ? { sessionId: this.sessionId, generation: this.generation }
      : null;
  }

  isStale(record: ProblemRecord): boolean {
    const seen = record.last?.preview ?? record.preview;
    if (!seen) return false;
    return seen.sessionId !== this.sessionId || seen.generation !== this.generation;
  }

  list(): ProblemRecord[] {
    return this.store.list().map((r) => {
      const stale = this.isStale(r);
      if (stale) return r.stale ? r : { ...r, stale: true };
      if (!r.stale) return r;
      const { stale: _stale, ...rest } = r;
      return rest;
    });
  }

  snapshot(): RuntimeSnapshot {
    return { projectId: this.projectId, current: this.current(), records: this.list(), stats: this.store.stats() };
  }

  stats(): StoreStats {
    return this.store.stats();
  }

  /** Removes the problems that have not occurred again since the page last loaded. Returns how many. */
  clearResolved(): number {
    const removed = this.store.clear((r) => this.isStale(r));
    this.schedule();
    return removed;
  }

  /** Publishes now if anything changed (also cancels a scheduled publish). */
  flush(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const attribution = `${this.projectId}|${this.sessionId}|${this.generation}`;
    if (this.store.revision === this.publishedRevision && attribution === this.publishedAttribution) return;
    this.publishedRevision = this.store.revision;
    this.publishedAttribution = attribution;
    this.options.publish?.(this.snapshot());
  }

  dispose(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer !== null || !this.options.publish) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
    }, this.publishMs);
  }
}
