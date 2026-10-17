/**
 * Quick open (S51.5): the files mode of the command palette. Pure: ranks the project's files (the S43.4 index's list)
 * for what was typed, best first, so the palette only renders. Ignored and hidden files (ignore.ts: dotfiles,
 * node_modules, OS litter, NoobIDE temporaries) are never offered.
 *
 * Ranking, best first: the exact file name; the name without its extension; a name that starts with the query; a
 * name that contains it; a path that contains it (folders included: "子 文件夹/页"); then the query's characters in
 * order in the name, then in the whole path (fuzzy: "ymr" finds "yemian-r…", "页二" finds "页面 二.html"). Ties go to
 * the shorter path, then path order. Chinese characters and spaces are ordinary characters throughout.
 */
import { isIgnoredRelPath } from '../../workspace/ignore';

/** Files listed at most (the palette shows the best ones; typing narrows the rest). */
export const MAX_QUICK_OPEN_RESULTS = 100;

export interface QuickOpenMatch {
  readonly relPath: string;
  readonly name: string;
  /** The folder part, with its trailing `/`; `''` at the project root. */
  readonly folder: string;
  /** Opened recently (listed first while the query is empty). */
  readonly recent: boolean;
}

const fold = (text: string) => text.normalize('NFKC').toLowerCase();

/** Characters of `query` appear in `text` in this order (not necessarily next to each other). */
function isSubsequence(query: string, text: string): boolean {
  let i = 0;
  for (let j = 0; j < text.length && i < query.length; j += 1) {
    if (text[j] === query[i]) i += 1;
  }
  return i === query.length;
}

/** Lower is better; null: no match. */
function tier(query: string, path: string, name: string): number | null {
  if (name === query) return 0;
  const dot = name.lastIndexOf('.');
  if (dot > 0 && name.slice(0, dot) === query) return 1;
  if (name.startsWith(query)) return 2;
  if (name.includes(query)) return 3;
  if (path.includes(query)) return 4;
  const compact = query.replace(/\s+/g, '');
  if (compact === '') return null;
  if (isSubsequence(compact, name)) return 5;
  if (isSubsequence(compact, path)) return 6;
  return null;
}

function split(relPath: string): { name: string; folder: string } {
  const slash = relPath.lastIndexOf('/');
  return slash < 0
    ? { name: relPath, folder: '' }
    : { name: relPath.slice(slash + 1), folder: relPath.slice(0, slash + 1) };
}

/**
 * The files to offer for `query`, best first, at most `limit`. With an empty query: the recently opened files (most
 * recent first) that still exist, then the others in path order.
 */
export function rankFiles(
  files: readonly string[],
  query: string,
  recent: readonly string[] = [],
  limit = MAX_QUICK_OPEN_RESULTS,
): QuickOpenMatch[] {
  const visible = files.filter((relPath) => !isIgnoredRelPath(relPath));
  const recentSet = new Set(recent);
  const make = (relPath: string): QuickOpenMatch => ({ relPath, ...split(relPath), recent: recentSet.has(relPath) });
  const q = fold(query.trim());
  if (q === '') {
    const existing = new Set(visible);
    const first = recent.filter((relPath, i) => existing.has(relPath) && recent.indexOf(relPath) === i);
    const firstSet = new Set(first);
    const rest = visible.filter((relPath) => !firstSet.has(relPath)).sort(byPath);
    return [...first, ...rest].slice(0, limit).map(make);
  }
  const ranked: { relPath: string; tier: number }[] = [];
  for (const relPath of visible) {
    const path = fold(relPath);
    const t = tier(q, path, path.slice(path.lastIndexOf('/') + 1));
    if (t !== null) ranked.push({ relPath, tier: t });
  }
  ranked.sort((a, b) => a.tier - b.tier || a.relPath.length - b.relPath.length || byPath(a.relPath, b.relPath));
  return ranked.slice(0, limit).map((r) => make(r.relPath));
}

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Recently opened files, most recent first: `relPath` moves to the front (bounded). */
export function pushRecent(recent: readonly string[], relPath: string, max = 50): string[] {
  return [relPath, ...recent.filter((p) => p !== relPath)].slice(0, max);
}
