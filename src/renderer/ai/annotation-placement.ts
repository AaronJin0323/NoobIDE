/**
 * S41.6: whether an agent's proposed change lies in the part of the code the user annotated in the preview (decision
 * 0030), so the proposal card can say "in the annotated part" — or warn that it is elsewhere. Pure; no React.
 */
import type { AiFileChange } from '../../shared/ipc/ai-contract';

export interface AnnotatedRange {
  readonly relPath: string;
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
}

export type Placement = 'inside' | 'outside';

/**
 * The lines of `before` an edit changes (1-based, inclusive): everything between the unchanged lines at the start and
 * at the end. A pure insertion gives the line it is inserted before (or after, at the end). Null when nothing changed.
 */
export function changedLines(before: string, after: string): { start: number; end: number } | null {
  if (before === after) return null;
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const start = Math.min(prefix + 1, a.length);
  const end = Math.max(start, a.length - suffix);
  return { start, end };
}

/**
 * 'inside' when an edit of an annotated file changes lines that overlap an annotated range; 'outside' for any other
 * change while annotations were sent; null when there were none (nothing to say).
 */
export function placementOf(change: AiFileChange, ranges: readonly AnnotatedRange[]): Placement | null {
  if (ranges.length === 0) return null;
  if (change.kind !== 'edit') return 'outside';
  const lines = changedLines(change.before, change.after);
  if (!lines) return null;
  const inside = ranges.some(
    (r) => r.relPath === change.relPath && lines.start <= r.endLine && lines.end >= r.startLine,
  );
  return inside ? 'inside' : 'outside';
}
