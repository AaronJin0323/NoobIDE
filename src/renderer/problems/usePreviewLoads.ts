import { useEffect, useState } from 'react';
import type { PreviewApi, PreviewState } from '../../shared/ipc/preview-contract';

/**
 * Preview page loads (S22.5): `started` is the number of the latest load that began; `completed` is the number of the
 * latest load that reached "running", reported a moment later so the errors of that load have reached the runtime problems first (the
 * runtime source republishes at most every 150 ms). A one-click fix of a problem the page reported is judged only
 * after a load that started after the fix was saved has completed (`completed > started-at-save`).
 *
 * Loads are numbered by main's `PreviewStatus.generation` (src/preview/state-machine.ts) — the same number runtime
 * problem records carry as `preview.generation` (S16.3) — so "a later load" means the same thing for both. Without a
 * generation (an older main) a start or refresh counts one more.
 */
export const LOAD_SETTLE_MS = 600;

export interface LoadTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: LoadTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PreviewLoads {
  readonly started: number;
  readonly completed: number;
}

export const NO_LOADS: PreviewLoads = { started: 0, completed: 0 };

export class PreviewLoadCounter {
  private loading = false;
  private timer: unknown = null;
  private started = 0;
  private completed = 0;

  constructor(
    private readonly onChange: (loads: PreviewLoads) => void,
    private readonly timers: LoadTimers = realTimers,
  ) {}

  status(state: PreviewState, generation?: number): void {
    if (state === 'starting' || state === 'refreshing') {
      // The same load reported again (e.g. its URL was added to the status) is not another load.
      if (this.loading && generation !== undefined && generation === this.started) return;
      this.cancel();
      this.loading = true;
      this.started = generation ?? this.started + 1;
      this.onChange({ started: this.started, completed: this.completed });
    } else if (state === 'running') {
      if (!this.loading || this.timer !== null) return;
      const load = this.started;
      this.timer = this.timers.set(() => {
        this.timer = null;
        this.loading = false;
        this.completed = load;
        this.onChange({ started: this.started, completed: this.completed });
      }, LOAD_SETTLE_MS);
    } else {
      this.cancel();
      this.loading = false;
    }
  }

  dispose(): void {
    this.cancel();
  }

  private cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}

export function usePreviewLoads(bridge: { readonly preview?: Pick<PreviewApi, 'onEvent'> } | undefined): PreviewLoads {
  const [loads, setLoads] = useState<PreviewLoads>(NO_LOADS);
  useEffect(() => {
    const preview = bridge?.preview;
    if (!preview) return undefined;
    const counter = new PreviewLoadCounter(setLoads);
    const unsubscribe = preview.onEvent((event) => {
      if (event.kind === 'status') counter.status(event.status.state, event.status.generation);
    });
    return () => {
      unsubscribe();
      counter.dispose();
    };
  }, [bridge]);
  return loads;
}
