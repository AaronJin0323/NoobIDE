/**
 * Minimal line diff for the recovery prompt (S12.2): what the recovered copy changes compared with the file on disk.
 * Common leading and trailing lines are trimmed, the rest is an LCS diff. Very large changed regions are reported
 * as `tooLarge` instead of blocking the UI. Line endings are ignored (CRLF and LF compare equal).
 */
export type DiffLine = { readonly kind: 'same' | 'added' | 'removed'; readonly text: string };

export type DiffHunkLine = DiffLine | { readonly kind: 'skipped'; readonly count: number };

export interface LineDiff {
  readonly identical: boolean;
  readonly tooLarge: boolean;
  readonly added: number;
  readonly removed: number;
  /** Changed lines with `context` unchanged lines around them; longer unchanged runs become `skipped`. */
  readonly lines: readonly DiffHunkLine[];
}

const MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

export function diffLines(before: string, after: string, context = 2): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0 && midB.length === 0) {
    return { identical: true, tooLarge: false, added: 0, removed: 0, lines: [] };
  }
  if (midA.length * midB.length > MAX_CELLS) {
    return { identical: false, tooLarge: true, added: midB.length, removed: midA.length, lines: [] };
  }

  // LCS table over the changed middle, then walk it to produce the edit script.
  const n = midA.length;
  const m = midB.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * (m + 1) + j] =
        midA[i] === midB[j]
          ? (table[(i + 1) * (m + 1) + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * (m + 1) + j] ?? 0, table[i * (m + 1) + j + 1] ?? 0);
    }
  }
  const full: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      full.push({ kind: 'same', text: midA[i] ?? '' });
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || (table[i * (m + 1) + j + 1] ?? 0) > (table[(i + 1) * (m + 1) + j] ?? 0))) {
      full.push({ kind: 'added', text: midB[j] ?? '' });
      added += 1;
      j += 1;
    } else {
      full.push({ kind: 'removed', text: midA[i] ?? '' });
      removed += 1;
      i += 1;
    }
  }
  for (const text of a.slice(endA)) full.push({ kind: 'same', text });

  return { identical: false, tooLarge: false, added, removed, lines: withContext(full, context) };
}

function withContext(full: readonly DiffLine[], context: number): DiffHunkLine[] {
  const keep = full.map(() => false);
  full.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(full.length - 1, index + context); k += 1) keep[k] = true;
  });
  const out: DiffHunkLine[] = [];
  let skipped = 0;
  full.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) out.push({ kind: 'skipped', count: skipped });
      skipped = 0;
      out.push(line);
    } else skipped += 1;
  });
  if (skipped > 0) out.push({ kind: 'skipped', count: skipped });
  return out;
}
