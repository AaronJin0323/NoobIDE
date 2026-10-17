/**
 * Typed contract of the project search (S51.2): the find-in-files panel asks main to search the open project's text
 * files; open editor buffers travel with the request and win over the disk copy. One search runs per window: a new
 * request cancels the one before, which then answers `cancelled` (never stale results). Payloads are validated with
 * the parsers below; main also checks the sender frame like every other channel.
 */
import { MAX_TEXT_FILE_BYTES, isPortableRelPath, isProjectId, type IpcResult } from './contract';
import { MAX_QUERY_LENGTH, type SearchQuery } from '../search';

export const SEARCH_CHANNELS = {
  run: 'search:run',
  cancel: 'search:cancel',
} as const;

/** At most this many open buffers travel with one request. */
export const MAX_SEARCH_BUFFERS = 100;
/** Files larger than this are not searched (bytes); the editor itself opens up to MAX_TEXT_FILE_BYTES. */
export const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
/** The search stops collecting after this many matches and reports `truncated`. */
export const MAX_SEARCH_MATCHES = 2000;
/** Files looked at in one search (a guard against a huge folder opened by mistake); beyond it: `truncated`. */
export const MAX_SEARCH_FILES = 20_000;
/** Characters of context shown around a match. */
export const SEARCH_PREVIEW_CHARS = 160;

export interface OpenBuffer {
  readonly relPath: string;
  readonly text: string;
}

export interface SearchRequest {
  /** Chosen by the renderer, increasing; answers carry it back. */
  readonly searchId: number;
  readonly projectId: string;
  readonly query: SearchQuery;
  /** Unsaved or open editor buffers: searched instead of the file on disk. */
  readonly openBuffers: readonly OpenBuffer[];
}

export interface SearchMatch {
  /** 1-based. */
  readonly line: number;
  /** 1-based UTF-16 column of the match start. */
  readonly column: number;
  readonly length: number;
  /** The line around the match (at most SEARCH_PREVIEW_CHARS plus the match), for context. */
  readonly preview: string;
  /** Where the match starts in `preview`. */
  readonly previewStart: number;
}

export interface SearchFileResult {
  /** Portable, relative to the project root. */
  readonly relPath: string;
  /** Searched from an open editor buffer or from the file on disk. */
  readonly source: 'buffer' | 'disk';
  /** textFingerprint (src/shared/search.ts) of the searched text: replace in files refuses a file that changed. */
  readonly fingerprint: string;
  readonly matches: readonly SearchMatch[];
}

export interface SearchResults {
  readonly searchId: number;
  readonly files: readonly SearchFileResult[];
  readonly totalMatches: number;
  /** The match or file limit was reached: more matches may exist than are listed. */
  readonly truncated: boolean;
  readonly filesSearched: number;
  /** Files skipped because they are not UTF-8 text (images, fonts, other encodings) or over the size cap. */
  readonly skippedBinary: number;
  readonly skippedLarge: number;
  readonly durationMs: number;
}

export type SearchError =
  | 'unknown-project'
  /** The regular expression does not compile; `message` is the engine's explanation. */
  | 'invalid-regex'
  /** A newer search (or a cancel) replaced this one. */
  | 'cancelled'
  | 'search-failed';

export interface SearchApi {
  run(request: SearchRequest): Promise<IpcResult<SearchResults, SearchError>>;
  /** Stops the window's running search (it answers `cancelled`). */
  cancel(request: { readonly searchId: number }): Promise<IpcResult<null, never>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));

const isSearchId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function parseSearchQuery(payload: unknown): SearchQuery | null {
  if (!isRecord(payload) || !exactKeys(payload, ['text', 'regex', 'caseSensitive', 'wholeWord'])) return null;
  const { text, regex, caseSensitive, wholeWord } = payload;
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_QUERY_LENGTH || text.includes('\0')) {
    return null;
  }
  if (typeof regex !== 'boolean' || typeof caseSensitive !== 'boolean' || typeof wholeWord !== 'boolean') return null;
  return { text, regex, caseSensitive, wholeWord };
}

export function parseSearchRequest(payload: unknown): SearchRequest | null {
  if (!isRecord(payload) || !exactKeys(payload, ['searchId', 'projectId', 'query', 'openBuffers'])) return null;
  const { searchId, projectId, openBuffers } = payload;
  if (!isSearchId(searchId) || !isProjectId(projectId)) return null;
  const query = parseSearchQuery(payload.query);
  if (query === null || !Array.isArray(openBuffers) || openBuffers.length > MAX_SEARCH_BUFFERS) return null;
  const buffers: OpenBuffer[] = [];
  const seen = new Set<string>();
  for (const buffer of openBuffers as unknown[]) {
    if (!isRecord(buffer) || !exactKeys(buffer, ['relPath', 'text'])) return null;
    const { relPath, text } = buffer;
    if (!isPortableRelPath(relPath) || seen.has(relPath)) return null;
    if (typeof text !== 'string' || text.length > MAX_TEXT_FILE_BYTES) return null;
    seen.add(relPath);
    buffers.push({ relPath, text });
  }
  return { searchId, projectId, query, openBuffers: buffers };
}

export function parseSearchCancel(payload: unknown): { searchId: number } | null {
  if (!isRecord(payload) || !exactKeys(payload, ['searchId'])) return null;
  return isSearchId(payload.searchId) ? { searchId: payload.searchId } : null;
}
