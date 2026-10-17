/**
 * Find in files (S51.3): what the panel shows for each state of a search, and the flat order of its results for the
 * keyboard. Pure: the panel and the hook (useProjectSearch.ts) render and run it; this file is unit-tested.
 */
import type { RequestError } from '../../shared/ipc/contract';
import type { SearchError, SearchFileResult, SearchMatch, SearchResults } from '../../shared/ipc/search-contract';
import type { SearchQuery } from '../../shared/search';
import type { MessageKey, Translate } from '../i18n/index';

export type SearchState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'searching'; readonly searchId: number }
  | { readonly kind: 'done'; readonly results: SearchResults }
  | { readonly kind: 'failed'; readonly code: SearchError | RequestError | 'unavailable'; readonly message: string };

export const DEFAULT_QUERY: SearchQuery = { text: '', regex: false, caseSensitive: false, wholeWord: false };

/** The option toggles, in the order the panel shows them, with their accessible names. */
export const SEARCH_TOGGLES = [
  { option: 'caseSensitive', label: 'search.option.case' },
  { option: 'wholeWord', label: 'search.option.word' },
  { option: 'regex', label: 'search.option.regex' },
] as const satisfies readonly { option: keyof SearchQuery; label: MessageKey }[];

export type SearchOption = (typeof SEARCH_TOGGLES)[number]['option'];

export interface PanelMessage {
  /** What the status line says (polite live region). */
  readonly text: string;
  /** Why nothing is listed, when nothing is: shown in the panel body as well. */
  readonly kind: 'none' | 'no-project' | 'idle' | 'searching' | 'empty' | 'invalid-regex' | 'failed' | 'results';
  /** Shown under the results when the list is not complete. */
  readonly truncated?: string;
}

const fill = (text: string, values: Readonly<Record<string, string | number>>) =>
  text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));

/** The status line and body text for a state, in the interface language. */
export function panelMessage(t: Translate, state: SearchState, query: SearchQuery, projectOpen: boolean): PanelMessage {
  if (!projectOpen) return { kind: 'no-project', text: t('search.noProject') };
  if (query.text === '' || state.kind === 'idle') return { kind: 'idle', text: t('search.idle') };
  if (state.kind === 'searching') return { kind: 'searching', text: t('search.searching') };
  if (state.kind === 'failed') {
    if (state.code === 'invalid-regex') {
      return { kind: 'invalid-regex', text: fill(t('search.invalidRegex'), { message: state.message }) };
    }
    if (state.code === 'unknown-project') return { kind: 'no-project', text: t('search.noProject') };
    return { kind: 'failed', text: fill(t('search.failed'), { message: state.message }) };
  }
  const { results } = state;
  if (results.files.length === 0) {
    return { kind: 'empty', text: fill(t('search.empty'), { query: query.text }) };
  }
  const matches = fill(t('search.count.matches', results.totalMatches), { n: results.totalMatches });
  const files = fill(t('search.count.files', results.files.length), { n: results.files.length });
  const text = fill(t('search.summary'), { matches, files });
  return results.truncated
    ? { kind: 'results', text, truncated: fill(t('search.truncated'), { n: results.totalMatches }) }
    : { kind: 'results', text };
}

export interface FlatHit {
  /** Stable DOM id part and React key: `relPath:line:column`. */
  readonly key: string;
  readonly file: SearchFileResult;
  readonly match: SearchMatch;
}

/** Every result in display order (file by file), for arrow-key movement. */
export function flattenHits(results: SearchResults | null): FlatHit[] {
  if (!results) return [];
  return results.files.flatMap((file) =>
    file.matches.map((match) => ({ key: `${file.relPath}:${match.line}:${match.column}`, file, match })),
  );
}

/** The next focused result for a key press in the list; null when the key does not move. */
export function moveHit(index: number, count: number, key: string): number | null {
  if (count === 0) return null;
  if (key === 'ArrowDown') return Math.min(index + 1, count - 1);
  if (key === 'ArrowUp') return Math.max(index - 1, 0);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/** Folder and name of a project path, for a file's heading ("子 文件夹/" + "页面 二.html"). */
export function splitPath(relPath: string): { folder: string; name: string } {
  const slash = relPath.lastIndexOf('/');
  return slash < 0
    ? { folder: '', name: relPath }
    : { folder: relPath.slice(0, slash + 1), name: relPath.slice(slash + 1) };
}

/** The preview line in three parts around the match, for highlighting. */
export function previewParts(match: SearchMatch): { before: string; hit: string; after: string } {
  const { preview, previewStart, length } = match;
  return {
    before: preview.slice(0, previewStart),
    hit: preview.slice(previewStart, previewStart + length),
    after: preview.slice(previewStart + length),
  };
}
