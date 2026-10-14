/**
 * Small text helpers for the explanation rules: edit distance (did-you-mean), identifier spans, path comparisons.
 * Pure functions, Unicode-aware (identifiers and file names may be Chinese).
 */

/**
 * Optimal string alignment distance (Levenshtein + adjacent transposition), so `userNmae` → `userName` is 1.
 * Works on UTF-16 code units, which is what editors and browsers use for columns.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[] = new Array<number>(rows * cols).fill(0);
  const at = (i: number, j: number) => d[i * cols + j] as number;
  for (let i = 0; i < rows; i++) d[i * cols] = i;
  for (let j = 0; j < cols; j++) d[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, at(i - 2, j - 2) + 1);
      d[i * cols + j] = v;
    }
  }
  return at(rows - 1, cols - 1);
}

/** Largest edit distance accepted as "probably a typo" for a name of this length. */
export function typoThreshold(length: number): number {
  if (length < 3) return 0; // a, b, x1: too short to guess
  if (length <= 4) return 1;
  if (length <= 8) return 2;
  return 3;
}

/**
 * Names from `pool` that `target` is plausibly a misspelling of, closest first. A name that differs only in case
 * always qualifies. Exact matches and duplicates are excluded.
 */
export function similarNames(target: string, pool: Iterable<string>): string[] {
  const max = typoThreshold(target.length);
  const lower = target.toLowerCase();
  const scored = new Map<string, number>();
  for (const name of pool) {
    if (name === target || scored.has(name)) continue;
    const score = name.toLowerCase() === lower ? 0.5 : editDistance(target, name);
    if (score <= Math.max(max, 0.5) && (score === 0.5 || max > 0)) scored.set(name, score);
  }
  return [...scored].sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0])).map(([n]) => n);
}

const ID_CHAR = /[\p{ID_Continue}$‌‍]/u;
export const IDENTIFIER = '[\\p{ID_Start}$_][\\p{ID_Continue}$\\u200c\\u200d]*';

/**
 * 1-based start columns of `name` as a whole, free-standing identifier in `lineText` (not a property after `.`).
 */
export function identifierColumns(lineText: string, name: string): number[] {
  const out: number[] = [];
  if (!name) return out;
  for (let i = lineText.indexOf(name); i !== -1; i = lineText.indexOf(name, i + 1)) {
    const before = lineText[i - 1];
    const after = lineText[i + name.length];
    if (before !== undefined && (ID_CHAR.test(before) || before === '.')) continue;
    if (after !== undefined && ID_CHAR.test(after)) continue;
    out.push(i + 1);
  }
  return out;
}

/**
 * Locates `name` on the reported line: at the reported column if it starts there, else the occurrence covering the
 * column, else the only occurrence. Undefined when it cannot be located unambiguously.
 */
export function locateIdentifier(lineText: string, name: string, column?: number): number | undefined {
  const cols = identifierColumns(lineText, name);
  if (column !== undefined) {
    if (cols.includes(column)) return column;
    const covering = cols.find((c) => column >= c && column < c + name.length);
    if (covering !== undefined) return covering;
  }
  return cols.length === 1 ? cols[0] : undefined;
}

/** Unicode-normalised (NFC, so macOS NFD names compare equal) and case-insensitive, without lower-casing paths. */
export function samePathIgnoringCase(a: string, b: string): boolean {
  return a.normalize('NFC').localeCompare(b.normalize('NFC'), 'en', { sensitivity: 'accent' }) === 0;
}

export function samePath(a: string, b: string): boolean {
  return a.normalize('NFC') === b.normalize('NFC');
}

export function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function extension(p: string): string {
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
}

/** Joins a list of names for a message parameter (locale-neutral separator). */
export function joinNames(names: readonly string[]): string {
  return names.join(' / ');
}
