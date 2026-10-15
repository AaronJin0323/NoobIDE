/**
 * Bounded problem store: dedupe, counts, rate limits and capacity caps (S16.5, PLAN §9 "Limit log volume and display
 * frequency so that endless page output cannot slow down the IDE").
 *
 * - Identical problems (same dedupe key) collapse into one record whose count goes up. The first occurrence's
 *   message and stack stay on the record verbatim; the latest repeat is kept verbatim in `last`.
 * - New records are admitted through a token bucket per source (burst + steady rate), so a console flood cannot
 *   starve the runtime error that follows it. Excess new records are dropped and counted per source, so the UI can
 *   say "N messages were not shown". Repeats of existing records are always counted: that costs no memory.
 * - Each source has its own capacity (console output cannot push runtime errors out). When full, the record that was
 *   seen least recently is evicted (an LRU ring buffer) and the eviction is counted.
 * - `revision` increases on every visible change so a UI can redraw at its own frame rate instead of per event.
 *
 * Pure TypeScript; the clock is injected for tests.
 */
import {
  PROBLEM_SOURCES,
  createProblemRecord,
  problemDedupeKey,
  recordRepeat,
  type ProblemInput,
  type ProblemRecord,
  type ProblemSource,
} from '../shared/problem';

export interface ProblemStoreOptions {
  /** Max records kept per source. Default: 200 for static/runtime/resource, 1000 for console. */
  readonly capacity?: Partial<Record<ProblemSource, number>>;
  /** New records admitted per second and source once the burst is used up. Default 50. */
  readonly ratePerSecond?: number;
  /** New records admitted in a burst, per source. Default 200. */
  readonly burst?: number;
  /** Clock in milliseconds. Default Date.now. */
  readonly now?: () => number;
}

export type AddOutcome = 'added' | 'repeat' | 'dropped';

export interface StoreStats {
  /** New problems not stored because the rate limit was exceeded, per source. */
  readonly dropped: Readonly<Record<ProblemSource, number>>;
  /** Records removed to stay within capacity, per source. */
  readonly evicted: Readonly<Record<ProblemSource, number>>;
}

const DEFAULT_CAPACITY: Record<ProblemSource, number> = { static: 200, runtime: 200, resource: 200, console: 1000 };

const zeroCounts = (): Record<ProblemSource, number> => ({ static: 0, runtime: 0, resource: 0, console: 0 });

export class ProblemStore {
  /** Per source, keyed by dedupe key. Map order = least recently seen first (LRU). */
  private readonly bySource = new Map<ProblemSource, Map<string, ProblemRecord>>();
  private readonly capacity: Record<ProblemSource, number>;
  private readonly rate: number;
  private readonly burst: number;
  private readonly now: () => number;
  /** Token bucket per source. */
  private readonly tokens: Record<ProblemSource, number>;
  private readonly refilledAt: Record<ProblemSource, number>;
  private seq = 0;
  private readonly dropped = zeroCounts();
  private readonly evicted = zeroCounts();
  private rev = 0;

  constructor(options: ProblemStoreOptions = {}) {
    this.capacity = { ...DEFAULT_CAPACITY, ...options.capacity };
    this.rate = options.ratePerSecond ?? 50;
    this.burst = options.burst ?? 200;
    this.now = options.now ?? Date.now;
    const start = this.now();
    this.tokens = { static: this.burst, runtime: this.burst, resource: this.burst, console: this.burst };
    this.refilledAt = { static: start, runtime: start, resource: start, console: start };
    for (const s of PROBLEM_SOURCES) this.bySource.set(s, new Map());
  }

  /** Increases whenever records, counts or stats change. */
  get revision(): number {
    return this.rev;
  }

  add(input: ProblemInput): AddOutcome {
    const bucket = this.bucket(input.source);
    const key = problemDedupeKey(input);
    const existing = bucket.get(key);
    if (existing) {
      bucket.delete(key); // move to the most-recently-seen end
      bucket.set(key, recordRepeat(existing, input));
      this.rev++;
      return 'repeat';
    }
    if (!this.takeToken(input.source)) {
      this.dropped[input.source]++;
      this.rev++;
      return 'dropped';
    }
    bucket.set(key, createProblemRecord(input, `p${++this.seq}`));
    const cap = this.capacity[input.source];
    while (bucket.size > cap) {
      const oldest = bucket.keys().next().value as string;
      bucket.delete(oldest);
      this.evicted[input.source]++;
    }
    this.rev++;
    return 'added';
  }

  /** Records of one source (or all), oldest first by first occurrence. */
  list(source?: ProblemSource): ProblemRecord[] {
    const sources = source ? [source] : PROBLEM_SOURCES;
    const all = sources.flatMap((s) => [...this.bucket(s).values()]);
    return all.sort((a, b) => a.firstSeen - b.firstSeen || seqOf(a) - seqOf(b));
  }

  get(id: string): ProblemRecord | undefined {
    for (const bucket of this.bySource.values()) for (const r of bucket.values()) if (r.id === id) return r;
    return undefined;
  }

  /** Replaces a record by id with an updated copy (e.g. with an explanation attached). Returns false if gone. */
  update(id: string, change: (r: ProblemRecord) => ProblemRecord): boolean {
    for (const bucket of this.bySource.values()) {
      for (const [key, r] of bucket) {
        if (r.id !== id) continue;
        const next = change(r);
        bucket.set(key, { ...next, id: r.id, dedupeKey: r.dedupeKey, source: r.source });
        this.rev++;
        return true;
      }
    }
    return false;
  }

  /** Removes records matching the predicate (all when omitted). Returns how many were removed. */
  clear(predicate: (r: ProblemRecord) => boolean = () => true): number {
    let removed = 0;
    for (const bucket of this.bySource.values()) {
      for (const [key, r] of bucket) {
        if (predicate(r)) {
          bucket.delete(key);
          removed++;
        }
      }
    }
    if (removed) this.rev++;
    return removed;
  }

  stats(): StoreStats {
    return { dropped: { ...this.dropped }, evicted: { ...this.evicted } };
  }

  /** Forgets the dropped/evicted counters (e.g. when the user clears the panel). */
  resetStats(): void {
    for (const s of PROBLEM_SOURCES) {
      this.dropped[s] = 0;
      this.evicted[s] = 0;
    }
    this.rev++;
  }

  private bucket(source: ProblemSource): Map<string, ProblemRecord> {
    const b = this.bySource.get(source);
    if (!b) throw new Error(`unknown problem source: ${String(source)}`);
    return b;
  }

  private takeToken(source: ProblemSource): boolean {
    const t = this.now();
    const elapsed = Math.max(0, t - this.refilledAt[source]);
    this.tokens[source] = Math.min(this.burst, this.tokens[source] + (elapsed / 1000) * this.rate);
    this.refilledAt[source] = t;
    if (this.tokens[source] < 1) return false;
    this.tokens[source] -= 1;
    return true;
  }
}

function seqOf(r: ProblemRecord): number {
  return Number(r.id.slice(1)) || 0;
}
