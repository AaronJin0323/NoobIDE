import type { NoobideApi } from '../../shared/ipc/contract';
import type { TreeAction } from './file-tree-model';

/**
 * Listing requests of the lazy file tree (S07.2/S07.3). A folder can be listed again while an older listing of it is
 * still on its way (a watcher event or a file operation invalidates it). Replies may arrive in any order, so each
 * request carries a token and only the newest request per folder may update the tree; an older reply arriving late
 * would otherwise bring back deleted rows or hide new ones.
 */
export interface ListingTracker {
  /** Starts a request for `relPath`; every earlier request for it becomes stale. */
  begin(relPath: string): number;
  isCurrent(relPath: string, token: number): boolean;
  /** Another project: every request in flight becomes stale. */
  reset(): void;
}

export function createListingTracker(): ListingTracker {
  // One counter for all folders that never restarts, so a token from before a reset can never match again.
  let next = 0;
  const latest = new Map<string, number>();
  return {
    begin(relPath) {
      next += 1;
      latest.set(relPath, next);
      return next;
    },
    isCurrent: (relPath, token) => latest.get(relPath) === token,
    reset: () => latest.clear(),
  };
}

/** Lists one folder and reports the result, unless a newer listing of the same folder was started meanwhile. */
export async function listFolder(
  tracker: ListingTracker,
  listDir: NoobideApi['workspace']['listDir'],
  projectId: string,
  relPath: string,
  dispatch: (action: TreeAction) => void,
): Promise<void> {
  const token = tracker.begin(relPath);
  const result = await listDir({ projectId, relPath });
  if (!tracker.isCurrent(relPath, token)) return;
  if (result.ok)
    dispatch({ type: 'loaded', relPath, entries: result.value.entries, truncated: result.value.truncated });
  else dispatch({ type: 'failed', relPath, code: result.code });
}
