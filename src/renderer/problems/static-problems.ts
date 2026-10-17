/**
 * Static diagnostics → ProblemRecords (S19.1, PLAN §9). The language services report problems as Monaco markers on
 * each open file; this turns them into `source: 'static'` records for the Problems panel and the explanation rules.
 *
 * - Debounced: marker updates arrive per keystroke burst; the list is re-published at most once per `debounceMs`.
 * - Cleared correctly: a file's records are replaced by its latest markers (an empty set removes them), a closed file
 *   loses its records, and switching projects clears everything at once.
 * - Only files of the open project count (the sample, probe and other in-memory models are ignored), and hints
 *   (dotted "could be improved" underlines) are not problems.
 *
 * Monaco-free: markers come in as plain objects, timers are injected, so the rules are unit-tested.
 */
import { createProblemRecord, type ProblemRecord, type ProblemSeverity } from '../../shared/problem';
import { HTML_UNCLOSED_CODE } from '../../diagnostics/html-check';
import { beginnerFacts } from '../../diagnostics/beginner-checks';

/** The fields of a Monaco IMarker this needs (MarkerSeverity: Hint 1, Info 2, Warning 4, Error 8). */
export interface MarkerLike {
  readonly owner: string;
  readonly severity: number;
  readonly code?: string | { readonly value: string } | undefined;
  readonly message: string;
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const STATIC_DEBOUNCE_MS = 300;

export function severityOf(markerSeverity: number): ProblemSeverity | null {
  if (markerSeverity >= 8) return 'error';
  if (markerSeverity >= 4) return 'warning';
  if (markerSeverity >= 2) return 'info';
  return null; // hint
}

export function codeOf(marker: MarkerLike): string {
  const code = typeof marker.code === 'string' ? marker.code : marker.code?.value;
  return code && code.trim() ? code : marker.owner;
}

/** FNV-1a, for short stable ids. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** One marker as a static ProblemRecord of `relPath`. The message is the language service's, verbatim. */
export function markerToProblem(
  marker: MarkerLike,
  context: { readonly projectId: string; readonly relPath: string; readonly at: number },
): ProblemRecord | null {
  const severity = severityOf(marker.severity);
  if (!severity) return null;
  const line = Math.max(1, Math.floor(marker.startLineNumber));
  const code = codeOf(marker);
  // The explanation rule for an unclosed element needs the tag name (src/diagnostics/README.md).
  const tagName = code === HTML_UNCLOSED_CODE ? /`([A-Za-z][\w-]*)`/.exec(marker.message)?.[1] : undefined;
  // S55.2: the beginner checks quote their facts in the message; rules 16–20 and 23–25 read them from `data`.
  const facts = beginnerFacts(code, marker.message);
  const column = Math.max(1, Math.floor(marker.startColumn));
  const input = {
    source: 'static' as const,
    severity,
    projectId: context.projectId,
    file: context.relPath,
    line,
    column,
    code,
    message: marker.message,
    data: {
      endLine: marker.endLineNumber,
      endColumn: marker.endColumn,
      owner: marker.owner,
      ...(tagName ? { tagName } : {}),
      ...facts,
    },
    at: context.at,
  };
  const record = createProblemRecord(input, 'pending');
  return { ...record, id: `s-${hash(record.dedupeKey)}` };
}

export interface StaticProblemsOptions {
  readonly projectId: string;
  readonly onChange: (records: readonly ProblemRecord[]) => void;
  readonly debounceMs?: number;
  readonly timers?: Timers;
  readonly now?: () => number;
}

const realTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class StaticProblems {
  /** relPath → its current records (from the latest markers). */
  private readonly byFile = new Map<string, readonly ProblemRecord[]>();
  private timer: unknown = null;
  private disposed = false;
  private readonly timers: Timers;
  private readonly debounceMs: number;
  private readonly now: () => number;
  /** First time each problem was seen, so a problem that stays keeps its "first seen" across marker refreshes. */
  private readonly firstSeen = new Map<string, number>();

  constructor(private readonly options: StaticProblemsOptions) {
    this.timers = options.timers ?? realTimers;
    this.debounceMs = options.debounceMs ?? STATIC_DEBOUNCE_MS;
    this.now = options.now ?? Date.now;
  }

  /** The file's markers changed: they replace its previous records (an empty list removes them). */
  update(relPath: string, markers: readonly MarkerLike[]): void {
    if (this.disposed) return;
    const at = this.now();
    const records: ProblemRecord[] = [];
    const seen = new Set<string>();
    for (const marker of markers) {
      const record = markerToProblem(marker, { projectId: this.options.projectId, relPath, at });
      if (!record || seen.has(record.id)) continue;
      seen.add(record.id);
      const first = this.firstSeen.get(record.id) ?? at;
      this.firstSeen.set(record.id, first);
      records.push({ ...record, firstSeen: first });
    }
    if (records.length === 0) this.byFile.delete(relPath);
    else this.byFile.set(relPath, records);
    this.schedule();
  }

  /** A file is no longer open (tab closed, renamed, deleted): its records go. */
  remove(relPath: string): void {
    if (this.byFile.delete(relPath)) this.schedule();
  }

  /** Keeps only the records of these files. */
  retain(relPaths: Iterable<string>): void {
    const keep = new Set(relPaths);
    let changed = false;
    for (const relPath of [...this.byFile.keys()]) {
      if (!keep.has(relPath)) changed = this.byFile.delete(relPath) || changed;
    }
    if (changed) this.schedule();
  }

  /** Current records, files in path order, then by position. */
  records(): ProblemRecord[] {
    return [...this.byFile.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([, records]) =>
        [...records].sort((x, y) => (x.line ?? 0) - (y.line ?? 0) || (x.column ?? 0) - (y.column ?? 0)),
      );
  }

  /** Publishes now (skipping the debounce), e.g. right before a re-check is evaluated. */
  flush(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    if (!this.disposed) this.options.onChange(this.records());
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.byFile.clear();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (this.disposed) return;
      const records = this.records();
      // Forget "first seen" of problems that are gone, so a problem that comes back later counts as new.
      const live = new Set(records.map((r) => r.id));
      for (const id of [...this.firstSeen.keys()]) if (!live.has(id)) this.firstSeen.delete(id);
      this.options.onChange(records);
    }, this.debounceMs);
  }
}
