import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { OpenBuffer, SearchApi } from '../../shared/ipc/search-contract';
import { MAX_SEARCH_BUFFERS } from '../../shared/ipc/search-contract';
import { SearchPanel, SearchStripButton, type SearchPanelProps } from './SearchPanel';
import { useProjectSearch, type ProjectSearch } from './useProjectSearch';
import { useReplaceInFiles } from './useReplaceInFiles';
import type { ReplaceHost } from './replace-apply';

export interface FindInFilesOptions {
  readonly api: SearchApi | undefined;
  readonly projectId: string | null;
  /** The open editor buffers (relPath and live text); searched instead of the disk copy. */
  readonly openBuffers: () => readonly OpenBuffer[];
  readonly onOpenHit: SearchPanelProps['onOpenHit'];
  /** The Problems panel shares the bottom region: one of the two is open at a time. */
  readonly problemsOpen: boolean;
  readonly closeProblems: () => void;
  /** S51.4: how a replace reaches the files (the workbench's editor tabs and save pipeline); none: find only. */
  readonly replaceHost?: ReplaceHost | undefined;
}

export interface FindInFiles {
  readonly open: boolean;
  readonly search: ProjectSearch;
  /** Ctrl/Cmd+Shift+F: opens the panel and puts the keyboard in its query field. */
  show(): void;
  /** Ctrl/Cmd+Shift+H: the same, with the replace row open. */
  showReplace(): void;
  readonly panel: ReactNode;
  readonly stripButton: ReactNode;
}

/**
 * S51.3: the find-in-files panel's state and elements for the workbench (one hook, so the workbench only places the
 * panel and its strip button). Opening it collapses Problems and the other way round, so the bottom region never
 * takes the editor's room twice. S51.4 adds the replace row (useReplaceInFiles.tsx).
 */
export function useFindInFiles(options: FindInFilesOptions): FindInFiles {
  const { api, projectId, problemsOpen, closeProblems } = options;
  const [open, setOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const buffers = options.openBuffers;
  const search = useProjectSearch(api, projectId, () => buffers().slice(0, MAX_SEARCH_BUFFERS));
  const replace = useReplaceInFiles(search, options.replaceHost);

  const closeProblemsRef = useRef(closeProblems);
  closeProblemsRef.current = closeProblems;
  const problemsOpenRef = useRef(problemsOpen);
  problemsOpenRef.current = problemsOpen;
  const show = useCallback(() => {
    if (problemsOpenRef.current) closeProblemsRef.current();
    setOpen(true);
    setFocusRequest((n) => n + 1);
  }, []);
  const expandReplace = replace.expand;
  const showReplace = useCallback(() => {
    expandReplace();
    show();
  }, [expandReplace, show]);
  const toggle = useCallback(() => {
    if (open) setOpen(false);
    else show();
  }, [open, show]);
  // Problems opened while the search panel was open: the search panel gives way.
  useEffect(() => {
    if (problemsOpen) setOpen(false);
  }, [problemsOpen]);

  return {
    open,
    search,
    show,
    showReplace,
    panel: (
      <SearchPanel
        open={open}
        projectOpen={projectId !== null}
        search={search}
        focusRequest={focusRequest}
        onClose={() => setOpen(false)}
        onOpenHit={options.onOpenHit}
        replace={replace.row}
        renderHitExtra={replace.renderHitExtra}
        renderFileExtra={replace.renderFileExtra}
        replacementFor={replace.replacementFor}
      />
    ),
    stripButton: <SearchStripButton open={open} onToggle={toggle} />,
  };
}
