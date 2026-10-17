import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { OpenBuffer, SearchApi } from '../../shared/ipc/search-contract';
import { MAX_SEARCH_BUFFERS } from '../../shared/ipc/search-contract';
import { SearchPanel, SearchStripButton, type SearchPanelProps } from './SearchPanel';
import { useProjectSearch, type ProjectSearch } from './useProjectSearch';

export interface FindInFilesOptions {
  readonly api: SearchApi | undefined;
  readonly projectId: string | null;
  /** The open editor buffers (relPath and live text); searched instead of the disk copy. */
  readonly openBuffers: () => readonly OpenBuffer[];
  readonly onOpenHit: SearchPanelProps['onOpenHit'];
  /** The Problems panel shares the bottom region: one of the two is open at a time. */
  readonly problemsOpen: boolean;
  readonly closeProblems: () => void;
  /** S51.4: replace in files, rendered inside the panel. */
  readonly replace?: (search: ProjectSearch) => Pick<SearchPanelProps, 'replace' | 'renderHitExtra'>;
}

export interface FindInFiles {
  readonly open: boolean;
  readonly search: ProjectSearch;
  /** Ctrl/Cmd+Shift+F: opens the panel and puts the keyboard in its query field. */
  show(): void;
  readonly panel: ReactNode;
  readonly stripButton: ReactNode;
}

/**
 * S51.3: the find-in-files panel's state and elements for the workbench (one hook, so the workbench only places the
 * panel and its strip button). Opening it collapses Problems and the other way round, so the bottom region never
 * takes the editor's room twice.
 */
export function useFindInFiles(options: FindInFilesOptions): FindInFiles {
  const { api, projectId, problemsOpen, closeProblems } = options;
  const [open, setOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const buffers = options.openBuffers;
  const search = useProjectSearch(api, projectId, () => buffers().slice(0, MAX_SEARCH_BUFFERS));

  const closeProblemsRef = useRef(closeProblems);
  closeProblemsRef.current = closeProblems;
  const problemsOpenRef = useRef(problemsOpen);
  problemsOpenRef.current = problemsOpen;
  const reveal = useCallback(() => {
    if (problemsOpenRef.current) closeProblemsRef.current();
    setOpen(true);
  }, []);
  const show = useCallback(() => {
    reveal();
    setFocusRequest((n) => n + 1);
  }, [reveal]);
  const toggle = useCallback(() => {
    if (open) setOpen(false);
    else show();
  }, [open, show]);
  // Problems opened while the search panel was open: the search panel gives way.
  useEffect(() => {
    if (problemsOpen) setOpen(false);
  }, [problemsOpen]);

  const extra = options.replace?.(search);
  return {
    open,
    search,
    show,
    panel: (
      <SearchPanel
        open={open}
        projectOpen={projectId !== null}
        search={search}
        focusRequest={focusRequest}
        onClose={() => setOpen(false)}
        onOpenHit={options.onOpenHit}
        {...extra}
      />
    ),
    stripButton: <SearchStripButton open={open} onToggle={toggle} />,
  };
}
