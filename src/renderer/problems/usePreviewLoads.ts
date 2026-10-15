import { useEffect, useState } from 'react';
import type { PreviewApi, PreviewState } from '../../shared/ipc/preview-contract';

/**
 * Preview page loads (S22.5): `started` counts starts and refreshes; `completed` is the number of the latest load that
 * reached "running", reported a moment later so the errors of that load have reached the runtime problems first (the
 * runtime source republishes at most every 150 ms). A one-click fix of a problem the page reported is judged only
 * after a load that started after the fix was saved has completed (`completed > started-at-save`).
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

  status(state: PreviewState): void {
    if (state === 'starting' || state === 'refreshing') {
      this.cancel();
      this.loading = true;
      this.started += 1;
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
      if (event.kind === 'status') counter.status(event.status.state);
    });
    return () => {
      unsubscribe();
      counter.dispose();
    };
  }, [bridge]);
  return loads;
}
