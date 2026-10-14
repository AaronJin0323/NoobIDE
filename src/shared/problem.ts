/**
 * ProblemRecord: the one shape every problem takes, whatever produced it (S16.1, PLAN §9).
 *
 * "Use a common record containing the source, severity, project and preview session, file, line and column, error
 * code, original message, explanation, and actionable checks. … Deduplicate repeated errors without losing their
 * original details."
 *
 * Producers: Monaco markers (static, S19), the preview capture adapter (runtime / console, S16.2), resource failures
 * (S16.4). Consumers: the problem store (S16.5), the explanation rules (S22) and the Problems panel (S17).
 *
 * Pure TypeScript: no Electron, Node or DOM imports, so records can cross IPC and run in tests.
 *
 * Privacy (AGENTS.md "Logs never contain source code"): a record holds the browser's/language service's message and
 * stack and small structured facts (names, paths, tag names) — never file contents. Messages and stacks are kept
 * verbatim up to a size cap; anything longer is cut and flagged `truncated`.
 */

/** Static diagnostics, runtime exceptions, resource-loading errors and console errors are listed separately (§9). */
export const PROBLEM_SOURCES = ['static', 'runtime', 'resource', 'console'] as const;
export type ProblemSource = (typeof PROBLEM_SOURCES)[number];

export const PROBLEM_SEVERITIES = ['error', 'warning', 'info'] as const;
export type ProblemSeverity = (typeof PROBLEM_SEVERITIES)[number];

/** Upper bounds for retained text. Big enough for any real browser message; small enough that a page cannot flood memory. */
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_STACK_CHARS = 8000;
export const MAX_FACT_CHARS = 500;

/**
 * Which preview produced a runtime/console/resource problem. `generation` increments on every refresh (S16.3), so a
 * problem can be attributed to "session #4, after the 10:42:07 refresh" and older generations can be marked stale.
 */
export interface PreviewAttribution {
  readonly sessionId: string;
  readonly generation: number;
}

export type ResourceType = 'script' | 'stylesheet' | 'image' | 'font' | 'media' | 'fetch' | 'document' | 'other';

/** Facts about a failed resource load (S16.4): what was requested, by which file, and how it failed. */
export interface ResourceFacts {
  /** The URL exactly as the page requested it. */
  readonly requestedUrl: string;
  /** Project-relative path ('/'-separated, decoded) when the URL points into the project. */
  readonly requestedPath?: string;
  /** Project-relative path of the file that asked for it (the HTML with the <img>, the JS that called fetch…). */
  readonly initiatorFile?: string;
  readonly status?: number;
  readonly resourceType?: ResourceType;
  /** Chromium network error name, e.g. 'net::ERR_CONNECTION_REFUSED'. */
  readonly netError?: string;
}

/** A localisable message: a dictionary key plus parameters (identifiers, paths, numbers — never source code). */
export interface MessageRef {
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

/** A 1-based range on one line, in UTF-16 columns (what both Chromium and Monaco report). End is exclusive. */
export interface LineSpan {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly endColumn: number;
}

/**
 * How sure the explanation is. Only `certain` may be phrased as fact; every other level must be worded as a
 * possibility ("可能…" / "may…") and come with checks (PLAN §9, §13 "provide checks when the cause is uncertain").
 */
export type Certainty = 'certain' | 'likely' | 'possible' | 'unknown';

export type ProblemAction =
  | {
      readonly kind: 'go-to-code';
      readonly label: MessageRef;
      readonly file: string;
      readonly line: number;
      readonly column?: number;
    }
  | { readonly kind: 'show-original'; readonly label: MessageRef }
  | { readonly kind: 'reveal-in-files'; readonly label: MessageRef; readonly path: string }
  /** Deterministic one-click fix (S22.5): replace exactly `span` (which currently reads `from`) with `to`. */
  | {
      readonly kind: 'replace-text';
      readonly label: MessageRef;
      readonly span: LineSpan;
      readonly from: string;
      readonly to: string;
    };

/** Output of the explanation rules (S22). Kept beside — never instead of — the original message. */
export interface ProblemExplanation {
  /** Which rule produced it ('fallback' when none matched). */
  readonly ruleId: string;
  readonly certainty: Certainty;
  /** One-line statement of what the browser/language service reported, e.g. "找不到变量 userNmae。" */
  readonly title: MessageRef;
  /** Plain-language explanation. Worded as a possibility unless certainty is 'certain'. */
  readonly explanation: MessageRef;
  /** "Possible causes:" list, each worded as a possibility. Empty when there is nothing to list. */
  readonly causes: readonly MessageRef[];
  /** Concrete things to check or do. */
  readonly checks: readonly MessageRef[];
  /** Ordered; the first is the primary action. Always includes 'show-original'. */
  readonly actions: readonly ProblemAction[];
  /** Did-you-mean candidates (misspelled-name rules), closest first. A fix is offered only when there is exactly one. */
  readonly candidates?: readonly string[];
  /** The exact span of the misspelled text, when it could be located precisely. */
  readonly span?: LineSpan;
}

/** One occurrence of a problem, retained verbatim (the most recent repeat is kept beside the first). */
export interface ProblemOccurrence {
  readonly at: number;
  readonly message: string;
  readonly stack?: string;
  readonly preview?: PreviewAttribution;
}

export interface ProblemRecord {
  readonly id: string;
  /** Identical problems share a key and collapse into one record with a count (S16.5). */
  readonly dedupeKey: string;
  readonly source: ProblemSource;
  readonly severity: ProblemSeverity;
  readonly projectId: string;
  /** Runtime, console and resource problems only. Attribution of the first occurrence. */
  readonly preview?: PreviewAttribution;
  /** Set when the preview has refreshed since this problem last occurred (S16.3). */
  readonly stale?: boolean;
  /** Project-relative, '/'-separated path. Absent when the location is unknown (e.g. cross-origin "Script error."). */
  readonly file?: string;
  /** 1-based. */
  readonly line?: number;
  /** 1-based, UTF-16 code units. */
  readonly column?: number;
  /**
   * Machine-readable code: the error name ('ReferenceError'), a language-service code ('2304', 'unknownProperties'),
   * or a NoobIDE code ('resource-failed', 'cross-origin-script-error', 'unhandledrejection', …).
   */
  readonly code: string;
  /** The message exactly as reported (up to MAX_MESSAGE_CHARS). Never rewritten. */
  readonly originalMessage: string;
  /** The stack exactly as reported (up to MAX_STACK_CHARS). */
  readonly originalStack?: string;
  /** True when the message or stack was longer than the cap and was cut. */
  readonly truncated?: boolean;
  readonly resource?: ResourceFacts;
  /** Small structured facts from the producer, e.g. { tagName: 'div' } or { selector: '#hero' }. */
  readonly data?: Readonly<Record<string, string | number>>;
  readonly explanation?: ProblemExplanation;
  readonly firstSeen: number;
  readonly lastSeen: number;
  /** How many times it occurred (≥ 1). */
  readonly count: number;
  /** The most recent repeat, verbatim, when count > 1. The first occurrence is the record itself. */
  readonly last?: ProblemOccurrence;
}

/** What a producer hands in; the record fields that are derived (id, key, timestamps, count) are filled in. */
export interface ProblemInput {
  readonly source: ProblemSource;
  readonly severity: ProblemSeverity;
  readonly projectId: string;
  readonly preview?: PreviewAttribution;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly code: string;
  readonly message: string;
  readonly stack?: string;
  readonly resource?: ResourceFacts;
  readonly data?: Readonly<Record<string, string | number>>;
  /** Milliseconds since the epoch. */
  readonly at: number;
}

export type ProblemInputError = 'invalid-source' | 'invalid-severity' | 'invalid-location' | 'invalid-field';

export type ValidationResult =
  { readonly ok: true } | { readonly ok: false; readonly code: ProblemInputError; readonly field: string };

const isPositiveInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1;
const isNonNegativeInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** Checks a ProblemInput that crossed a trust boundary (IPC from the preview side). */
export function validateProblemInput(input: unknown): ValidationResult {
  const bad = (code: ProblemInputError, field: string): ValidationResult => ({ ok: false, code, field });
  if (typeof input !== 'object' || input === null) return bad('invalid-field', 'input');
  const i = input as Record<string, unknown>;
  if (!(PROBLEM_SOURCES as readonly unknown[]).includes(i.source)) return bad('invalid-source', 'source');
  if (!(PROBLEM_SEVERITIES as readonly unknown[]).includes(i.severity)) return bad('invalid-severity', 'severity');
  for (const f of ['projectId', 'code', 'message'] as const) {
    if (typeof i[f] !== 'string') return bad('invalid-field', f);
  }
  if (typeof i.at !== 'number' || !Number.isFinite(i.at)) return bad('invalid-field', 'at');
  if (i.stack !== undefined && typeof i.stack !== 'string') return bad('invalid-field', 'stack');
  if (i.file !== undefined && (typeof i.file !== 'string' || i.file === '')) return bad('invalid-location', 'file');
  if (i.line !== undefined && !isPositiveInt(i.line)) return bad('invalid-location', 'line');
  if (i.column !== undefined && !isPositiveInt(i.column)) return bad('invalid-location', 'column');
  if (i.line !== undefined && i.file === undefined) return bad('invalid-location', 'file');
  if (i.column !== undefined && i.line === undefined) return bad('invalid-location', 'line');
  if (i.preview !== undefined) {
    const p = i.preview as Record<string, unknown> | null;
    if (typeof p !== 'object' || p === null || typeof p.sessionId !== 'string' || !isNonNegativeInt(p.generation)) {
      return bad('invalid-field', 'preview');
    }
  }
  if (i.resource !== undefined) {
    const r = i.resource as Record<string, unknown> | null;
    if (typeof r !== 'object' || r === null || typeof r.requestedUrl !== 'string')
      return bad('invalid-field', 'resource');
  }
  if (i.data !== undefined) {
    const d = i.data as Record<string, unknown> | null;
    if (typeof d !== 'object' || d === null) return bad('invalid-field', 'data');
    for (const v of Object.values(d))
      if (typeof v !== 'string' && typeof v !== 'number') return bad('invalid-field', 'data');
  }
  return { ok: true };
}

/**
 * Identical problems produce identical keys. The preview session/generation and timestamps are deliberately not part
 * of the key: the same error after a refresh is the same problem occurring again (its count goes up).
 */
export function problemDedupeKey(input: Omit<ProblemInput, 'at'>): string {
  return JSON.stringify([
    input.projectId,
    input.source,
    input.severity,
    input.code,
    input.file ?? null,
    input.line ?? null,
    input.column ?? null,
    input.message,
    input.resource?.requestedUrl ?? null,
  ]);
}

function cap(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: text.slice(0, max), cut: true } : { text, cut: false };
}

function capFacts(data: Readonly<Record<string, string | number>>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(data)) out[k] = typeof v === 'string' ? cap(v, MAX_FACT_CHARS).text : v;
  return out;
}

let nextId = 0;

/**
 * Builds a record from a producer's input. The original message and stack are copied verbatim (capped); nothing is
 * paraphrased here — explanations are added separately by the rules engine.
 */
export function createProblemRecord(input: ProblemInput, id: string = `p${++nextId}`): ProblemRecord {
  const message = cap(input.message, MAX_MESSAGE_CHARS);
  const stack = input.stack === undefined ? undefined : cap(input.stack, MAX_STACK_CHARS);
  return {
    id,
    dedupeKey: problemDedupeKey(input),
    source: input.source,
    severity: input.severity,
    projectId: input.projectId,
    ...(input.preview ? { preview: { sessionId: input.preview.sessionId, generation: input.preview.generation } } : {}),
    ...(input.file !== undefined ? { file: input.file } : {}),
    ...(input.line !== undefined ? { line: input.line } : {}),
    ...(input.column !== undefined ? { column: input.column } : {}),
    code: input.code,
    originalMessage: message.text,
    ...(stack ? { originalStack: stack.text } : {}),
    ...(message.cut || stack?.cut ? { truncated: true } : {}),
    ...(input.resource ? { resource: { ...input.resource } } : {}),
    ...(input.data ? { data: capFacts(input.data) } : {}),
    firstSeen: input.at,
    lastSeen: input.at,
    count: 1,
  };
}

/** Records a repeat of the same problem: count + 1, last-seen updated, the repeat's own text kept as `last`. */
export function recordRepeat(record: ProblemRecord, input: ProblemInput): ProblemRecord {
  const message = cap(input.message, MAX_MESSAGE_CHARS).text;
  const stack = input.stack === undefined ? undefined : cap(input.stack, MAX_STACK_CHARS).text;
  const last: ProblemOccurrence = {
    at: input.at,
    message,
    ...(stack !== undefined ? { stack } : {}),
    ...(input.preview ? { preview: { ...input.preview } } : {}),
  };
  const { stale: _stale, ...rest } = record;
  return { ...rest, count: record.count + 1, lastSeen: Math.max(record.lastSeen, input.at), last };
}
