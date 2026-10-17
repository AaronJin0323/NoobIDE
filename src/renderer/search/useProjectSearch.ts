import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpenBuffer, SearchApi } from '../../shared/ipc/search-contract';
import type { SearchQuery } from '../../shared/search';
import { DEFAULT_QUERY, type SearchOption, type SearchState } from './search-model';

/** Typing pause before a search starts (Enter searches at once). */
export const SEARCH_DEBOUNCE_MS = 250;

export interface ProjectSearch {
  readonly query: SearchQuery;
  readonly state: SearchState;
  setText(text: string): void;
  toggle(option: SearchOption): void;
  /** Searches now (Enter, refresh, after a replace). */
  runNow(): void;
}

/**
 * S51.3: runs the find-in-files search through main (S51.2) while the query or its options change, after a short
 * typing pause. Every request carries an increasing id and the open editor buffers (they win over the disk copy);
 * an answer for an older id is dropped, and main cancels the older search anyway, so stale results never show.
 */
export function useProjectSearch(
  api: SearchApi | undefined,
  projectId: string | null,
  openBuffers: () => readonly OpenBuffer[],
): ProjectSearch {
  const [query, setQuery] = useState<SearchQuery>(DEFAULT_QUERY);
  const [state, setState] = useState<SearchState>({ kind: 'idle' });
  const latest = useRef(0);
  const buffersRef = useRef(openBuffers);
  buffersRef.current = openBuffers;

  const start = useCallback(
    (wanted: SearchQuery) => {
      const searchId = (latest.current += 1);
      if (!api || !projectId || wanted.text === '') {
        setState({ kind: 'idle' });
        return;
      }
      setState({ kind: 'searching', searchId });
      void api
        .run({ searchId, projectId, query: wanted, openBuffers: buffersRef.current() })
        .then((result) => {
          if (searchId !== latest.current) return; // a newer search owns the panel
          if (result.ok) setState({ kind: 'done', results: result.value });
          else if (result.code !== 'cancelled')
            setState({ kind: 'failed', code: result.code, message: result.message });
        })
        .catch((e: unknown) => {
          if (searchId === latest.current) {
            setState({ kind: 'failed', code: 'unavailable', message: e instanceof Error ? e.message : String(e) });
          }
        });
    },
    [api, projectId],
  );

  // A changed query or option searches after a typing pause; another project starts empty.
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    const timer = setTimeout(() => start(query), query.text === '' ? 0 : SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, start]);

  // Nothing keeps scanning for a closed project or panel.
  useEffect(
    () => () => {
      const id = latest.current;
      latest.current += 1;
      if (api && id > 0) void api.cancel({ searchId: id });
    },
    [api, projectId],
  );

  return {
    query,
    state,
    setText: useCallback((text: string) => setQuery((q) => (q.text === text ? q : { ...q, text })), []),
    toggle: useCallback((option: SearchOption) => setQuery((q) => ({ ...q, [option]: !q[option] })), []),
    runNow: useCallback(() => start(queryRef.current), [start]),
  };
}
