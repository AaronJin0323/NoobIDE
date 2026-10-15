/**
 * Command palette search (S40.5). Pure: the palette component hands it the commands that apply right now, each with
 * its label in the interface language and in the other language, and gets back the ones that match what was typed,
 * best first. Searching in the other language matters for beginners: tutorials name commands in English while the
 * interface is Chinese (and the other way round), so "save" finds 保存 and 保存 finds Save.
 */
import type { CommandId } from '../../shared/commands';
import type { MessageKey } from '../i18n/index';

export interface PaletteEntry {
  readonly id: CommandId;
  /** In the interface language. */
  readonly label: string;
  /** The same command in the other interface language. */
  readonly otherLabel: string;
  /** `⌘S` / `Ctrl+S`, or null. */
  readonly shortcut: string | null;
  /** Other words people use for the command, in both languages ("create" for New project). */
  readonly keywords?: readonly string[];
}

/**
 * Commands that beginners look for with other words than their label: the welcome screen says "Create my first
 * webpage", so "create" (创建) must find New project. A space-separated list per language, in the i18n tables.
 */
export const PALETTE_KEYWORDS: Partial<Record<CommandId, MessageKey>> = {
  'new-project': 'palette.keywords.newProject',
};

/** The words of a keyword list (separated by spaces or commas). */
export function keywordList(text: string): string[] {
  return text.split(/[\s,，、]+/).filter(Boolean);
}

/** A keyword matches from its start or inside it (no fuzzy matching: keywords are many and short). */
function keywordScore(query: string, keywords: readonly string[] | undefined): number | null {
  let best: number | null = null;
  for (const word of keywords ?? []) {
    const text = normalize(word);
    const value = text.startsWith(query) ? 0 : text.includes(query) ? 1 : null;
    if (value !== null && (best === null || value < best)) best = value;
  }
  return best;
}

export interface PaletteMatch {
  readonly entry: PaletteEntry;
  /** Matched only through the other language's label: the palette shows that label as a hint. */
  readonly viaOther: boolean;
}

/** Lower case, without spaces, ellipses and punctuation that people do not type. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s.…·,，、:：()（）'"“”‘’/\\-]+/g, '');
}

/** Characters of `query` appear in `text` in order (not necessarily next to each other). */
function isSubsequence(query: string, text: string): boolean {
  let i = 0;
  for (const char of text) {
    if (char === query[i]) i += 1;
    if (i === query.length) return true;
  }
  return query.length === 0;
}

/** Lower is better; null = no match. */
function score(query: string, label: string): number | null {
  const text = normalize(label);
  if (text.startsWith(query)) return 0;
  const at = text.indexOf(query);
  if (at >= 0) return 1 + at / 100;
  // Word starts in a Latin label ("tp" → "Toggle Problems")
  const initials = label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join('');
  if (initials.startsWith(query)) return 2;
  if (query.length >= 2 && isSubsequence(query, text)) return 3 + text.length / 1000;
  return null;
}

/** The entries matching `query`, best first; the registry order breaks ties. Empty query: every entry. */
export function searchPalette(entries: readonly PaletteEntry[], query: string): PaletteMatch[] {
  const q = normalize(query);
  if (q === '') return entries.map((entry) => ({ entry, viaOther: false }));
  const ranked: { match: PaletteMatch; rank: number; order: number }[] = [];
  entries.forEach((entry, order) => {
    const own = score(q, entry.label);
    const other = score(q, entry.otherLabel);
    if (own === null && other === null) {
      // Found through a keyword only: ranked after equally good label matches, without the other-language hint.
      const keyword = keywordScore(q, entry.keywords);
      if (keyword !== null) ranked.push({ match: { entry, viaOther: false }, rank: keyword + 0.75, order });
      return;
    }
    const viaOther = own === null;
    // A match in the interface language wins over an equally good one in the other language.
    const rank = viaOther ? (other as number) + 0.5 : Math.min(own, other === null ? Infinity : other + 0.5);
    ranked.push({ match: { entry, viaOther }, rank, order });
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.order - b.order).map((r) => r.match);
}

/** Arrow-key movement through the results, wrapping at both ends. */
export function moveSelection(index: number, count: number, key: string): number {
  if (count === 0) return -1;
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return index;
}
