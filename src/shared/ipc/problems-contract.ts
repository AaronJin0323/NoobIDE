/**
 * Typed contract for runtime problems (S16.2–S16.6): the main process's problem store for the preview, read by the
 * Problems panel (src/renderer/problems/sources.ts, `bridgeRuntimeSource`). The preview page itself has no preload
 * and never reaches these channels. Pure TypeScript: no Electron, Node or DOM imports.
 */
import type { IpcResult } from './contract';
import type { ProblemRecord } from '../problem';

export const PROBLEMS_CHANNELS = {
  list: 'problems:list',
  clearResolved: 'problems:clear-resolved',
} as const;

/** Main → workbench: the full current list (coalesced, at most a few times per second). */
export const PROBLEMS_EVENT_CHANNEL = 'problems:changed';

export interface ProblemsApi {
  /** Runtime, console and resource problems of the previewed project; `stale` marks those not seen since a refresh. */
  list(): Promise<IpcResult<readonly ProblemRecord[], never>>;
  /** Subscribes to changes; the listener gets the full list. Returns the unsubscribe function. */
  onChanged(listener: (records: readonly ProblemRecord[]) => void): () => void;
  /** Removes the problems that did not occur again since the page last loaded. Returns how many were removed. */
  clearResolved(): Promise<IpcResult<number, never>>;
}
