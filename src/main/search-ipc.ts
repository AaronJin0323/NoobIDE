import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { toIpcResult, type IpcResult } from '../shared/ipc/contract';
import {
  SEARCH_CHANNELS,
  parseSearchCancel,
  parseSearchRequest,
  type SearchError,
  type SearchRequest,
  type SearchResults,
} from '../shared/ipc/search-contract';
import type { Result } from '../shared/result';
import { searchProject } from '../workspace/project-search';
import { isTrustedSender, senderInfo } from './ipc';

/** Runs one search to its end (or until the signal aborts). The real one is searchProject over the project root. */
export type SearchRunner = (request: SearchRequest, signal: AbortSignal) => Promise<Result<SearchResults, SearchError>>;

/**
 * One search at a time per window (S51.2): a new request aborts the running one, which answers `cancelled` — never its
 * results, even if it had already finished scanning — so the panel cannot show stale matches.
 */
export class SearchCoordinator {
  private readonly running = new Map<number, { readonly searchId: number; readonly controller: AbortController }>();

  constructor(private readonly runner: SearchRunner) {}

  async run(senderId: number, request: SearchRequest): Promise<Result<SearchResults, SearchError>> {
    this.running.get(senderId)?.controller.abort();
    const controller = new AbortController();
    const entry = { searchId: request.searchId, controller };
    this.running.set(senderId, entry);
    try {
      const result = await this.runner(request, controller.signal);
      if (controller.signal.aborted) return { ok: false, code: 'cancelled', message: 'search cancelled' };
      return result;
    } finally {
      if (this.running.get(senderId) === entry) this.running.delete(senderId);
    }
  }

  /** Cancels the window's running search if it is `searchId`. */
  cancel(senderId: number, searchId: number): void {
    const entry = this.running.get(senderId);
    if (entry?.searchId === searchId) entry.controller.abort();
  }

  /** The window closed: nothing of it keeps scanning. */
  forget(senderId: number): void {
    this.running.get(senderId)?.controller.abort();
    this.running.delete(senderId);
  }
}

export interface SearchIpcDeps {
  readonly allowedOrigin: string;
  /** The project's realpath root, or undefined when the projectId is not open. */
  rootOf(projectId: string): string | undefined;
  /** Test seam: replaces searchProject. */
  readonly runner?: SearchRunner;
}

const FORBIDDEN = { ok: false, code: 'forbidden-sender', message: 'sender is not the workbench' } as const;
const INVALID = { ok: false, code: 'invalid-request', message: 'payload does not match the contract' } as const;

/** S51.2: the search channels, behind the same checks as ipc.ts (trusted top-level sender, one valid argument). */
export function registerSearchHandlers(ipc: Pick<IpcMain, 'handle'>, deps: SearchIpcDeps): SearchCoordinator {
  const runner: SearchRunner =
    deps.runner ??
    (async (request, signal) => {
      const root = deps.rootOf(request.projectId);
      if (root === undefined) return { ok: false, code: 'unknown-project', message: 'project is not open' };
      return searchProject(root, request.searchId, request.query, request.openBuffers, { signal });
    });
  const coordinator = new SearchCoordinator(runner);
  const guard =
    <P>(parse: (payload: unknown) => P | null, run: (payload: P, event: IpcMainInvokeEvent) => Promise<unknown>) =>
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedSender(senderInfo(event), deps.allowedOrigin)) return FORBIDDEN;
      if (args.length !== 1) return INVALID;
      const payload = parse(args[0]);
      if (payload === null) return INVALID;
      return run(payload, event);
    };
  ipc.handle(
    SEARCH_CHANNELS.run,
    guard(parseSearchRequest, async (request, event): Promise<IpcResult<SearchResults, SearchError>> =>
      toIpcResult(await coordinator.run(event.sender.id, request)),
    ),
  );
  ipc.handle(
    SEARCH_CHANNELS.cancel,
    guard(parseSearchCancel, async ({ searchId }, event) => {
      coordinator.cancel(event.sender.id, searchId);
      return { ok: true, value: null };
    }),
  );
  return coordinator;
}
