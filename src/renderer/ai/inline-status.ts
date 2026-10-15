/**
 * S32.1: the AI status as the inline suggestions see it (AI on, inline on, key stored, project allowed), cached so a
 * pause in typing does not cost an extra round trip, and refreshed when it may have changed: after a short time, when
 * the window regains focus, when the project changes, after the toggle command, and when a request fails because of
 * the key or consent. Monaco-free, so the workbench (toggle command, status text) can use it without loading the
 * editor chunk.
 */
import type { AiApi, AiConfig, AiStatus } from '../../shared/ipc/ai-contract';

/** The AI bridge from the preload (S31), or null when this build or window has none. */
export function aiBridge(): AiApi | null {
  if (typeof window === 'undefined') return null;
  return (window.noobide as { readonly ai?: AiApi } | undefined)?.ai ?? null;
}

/** Status older than this is fetched again before it is used (settings may have changed it meanwhile). */
export const INLINE_STATUS_TTL_MS = 2000;

type StatusApi = Pick<AiApi, 'status' | 'setConfig'>;

export class AiStatusCache {
  private status: AiStatus | null = null;
  private projectId: string | null = null;
  private fetchedAt = -Infinity;
  private inFlight: { readonly projectId: string | null; readonly promise: Promise<AiStatus | null> } | null = null;
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: () => StatusApi | null,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = INLINE_STATUS_TTL_MS,
  ) {}

  /** The last known status for the project, without asking (may be stale or null). */
  peek(projectId: string | null): AiStatus | null {
    return this.projectId === projectId ? this.status : null;
  }

  /** The status for the project: cached while fresh, fetched otherwise. null when there is no AI bridge. */
  get(projectId: string | null): Promise<AiStatus | null> {
    if (this.projectId === projectId && this.status && this.now() - this.fetchedAt < this.ttlMs) {
      return Promise.resolve(this.status);
    }
    if (this.inFlight && this.inFlight.projectId === projectId) return this.inFlight.promise;
    const api = this.api();
    if (!api) return Promise.resolve(null);
    const generation = this.generation;
    const promise = api.status({ projectId }).then(
      (result) => {
        const status = result.ok ? result.value : null;
        if (generation === this.generation) this.store(projectId, status);
        return status;
      },
      () => null,
    );
    const entry = { projectId, promise };
    this.inFlight = entry;
    void promise.finally(() => {
      if (this.inFlight === entry) this.inFlight = null;
    });
    return promise;
  }

  /** Forget the cached status: the next `get` asks main again. */
  invalidate(): void {
    this.generation += 1;
    this.fetchedAt = -Infinity;
    this.inFlight = null;
  }

  /** Switches inline suggestions on or off (S24 command). Resolves with the new value, or null when it failed. */
  async toggleInline(projectId: string | null): Promise<boolean | null> {
    const api = this.api();
    if (!api) return null;
    const status = await this.get(projectId);
    if (!status) return null;
    const config: AiConfig = { ...status.config, inlineCompletions: !status.config.inlineCompletions };
    const result = await api.setConfig({ config });
    this.invalidate();
    if (!result.ok) return null;
    this.store(projectId, { ...status, config: result.value });
    return result.value.inlineCompletions;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private store(projectId: string | null, status: AiStatus | null): void {
    const changed = this.projectId !== projectId || JSON.stringify(this.status) !== JSON.stringify(status);
    this.projectId = projectId;
    this.status = status;
    this.fetchedAt = this.now();
    if (changed) for (const listener of [...this.listeners]) listener();
  }
}

/** The one cache of this window, shared by the Monaco provider and the workbench. */
export const aiStatusCache = new AiStatusCache(aiBridge);

if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => aiStatusCache.invalidate());
}
