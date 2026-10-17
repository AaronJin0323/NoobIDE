/**
 * S49.4: the console's search and copy rules. Pure: ConsoleView passes each line's shown words (level word, text,
 * detail, place), so the rules are unit-tested and the clipboard gets exactly what the user sees.
 */

/** What one console row shows, in words (the level word is spelled out, never a colour). */
export interface ConsoleLineWords {
  readonly level: string;
  /** "Before refresh" for output of an earlier page load, else absent. */
  readonly older?: string | undefined;
  readonly text: string;
  readonly detail?: string | undefined;
  /** `file.js:12`, when known. */
  readonly where?: string | undefined;
}

/** Case- and width-folded form for matching (full-width ＡＢＣ matches abc; Chinese text is unchanged). */
export function foldForSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/** A query of only spaces searches nothing (every line matches). */
export function normalizedQuery(query: string): string {
  return foldForSearch(query.trim());
}

/** Whether a row matches the search: the query appears in its text, detail or place, ignoring case. */
export function lineMatches(words: ConsoleLineWords, query: string): boolean {
  const q = normalizedQuery(query);
  if (q === '') return true;
  return [words.text, words.detail, words.where].some((part) => part !== undefined && foldForSearch(part).includes(q));
}

/** Keeps the rows that match, in order. */
export function searchLines<T>(rows: readonly T[], query: string, wordsOf: (row: T) => ConsoleLineWords): T[] {
  if (normalizedQuery(query) === '') return [...rows];
  return rows.filter((row) => lineMatches(wordsOf(row), query));
}

/** One row as clipboard text: `错误  message detail  (app.js:3)`; the older tag after the level word. */
export function lineToText(words: ConsoleLineWords): string {
  const head = words.older ? `${words.level} ${words.older}` : words.level;
  const body = words.detail ? `${words.text} ${words.detail}` : words.text;
  return words.where ? `${head}  ${body}  (${words.where})` : `${head}  ${body}`;
}

/** "Copy all visible": the shown rows, one per line, oldest first. */
export function linesToText(rows: readonly ConsoleLineWords[]): string {
  return rows.map(lineToText).join('\n');
}
