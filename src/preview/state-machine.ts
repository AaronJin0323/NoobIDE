import type { PreviewFailure, PreviewState } from '../shared/ipc/preview-contract';

/**
 * The preview state machine (S14.1, PLAN §8): every preview instance is stopped, starting, running, refreshing,
 * unresponsive or failed. Pure — no Electron, no timers — so every transition is unit-tested; the preview manager
 * feeds it the events it observes (server ready, page loaded, navigation, watchdog, crash, Stop) and publishes the
 * result as `PreviewStatus`.
 *
 * **Generation** (for runtime diagnostics, S16.3): a counter that increases by one every time a new page load
 * begins — a Start, a refresh (automatic or by the user), or a navigation the page itself makes (link, form,
 * `location.href = …`). It never decreases and is not reset by Stop, so a record tagged with generation N belongs to
 * exactly one page load of this app run; anything tagged lower than the current generation is stale.
 */
export interface PreviewMachine {
  readonly state: PreviewState;
  /** Set only while `state` is 'failed'. */
  readonly failure?: PreviewFailure;
  readonly generation: number;
  /** State to return to when an unresponsive page answers again (internal). */
  readonly resumeTo?: PreviewState;
}

export type PreviewMachineEvent =
  /** Start was requested (also from failed or while live: a restart). */
  | { readonly type: 'start' }
  /** The loopback server could not start. */
  | { readonly type: 'server-failed' }
  /** A refresh was requested (save, toolbar, command). */
  | { readonly type: 'refresh' }
  /** The page began a new main-frame document by itself (link, form, script navigation). */
  | { readonly type: 'navigate' }
  /** The main frame finished loading. */
  | { readonly type: 'load-finished' }
  /** The main frame failed to load (DNS, refused, 404 is NOT a failure — the page shows it). */
  | { readonly type: 'load-failed' }
  /** The page's renderer process is gone. */
  | { readonly type: 'crashed' }
  /** The watchdog (or Chromium) found the page's main thread busy. */
  | { readonly type: 'unresponsive' }
  /** The page answers again; `loading` says whether its main frame is still loading. */
  | { readonly type: 'responsive'; readonly loading: boolean }
  /** Stop: the view is destroyed and the server shut down. */
  | { readonly type: 'stop' };

export const INITIAL_MACHINE: PreviewMachine = { state: 'stopped', generation: 0 };

const LIVE: readonly PreviewState[] = ['starting', 'running', 'refreshing', 'unresponsive'];

export function isLive(state: PreviewState): boolean {
  return LIVE.includes(state);
}

/** Next machine state. Events that do not apply in the current state return `machine` unchanged (same object). */
export function transition(machine: PreviewMachine, event: PreviewMachineEvent): PreviewMachine {
  const { state, generation } = machine;
  switch (event.type) {
    case 'start':
      return { state: 'starting', generation: generation + 1 };
    case 'stop':
      return state === 'stopped' ? machine : { state: 'stopped', generation };
    case 'server-failed':
      return state === 'starting' ? { state: 'failed', failure: 'server-failed', generation } : machine;
    case 'refresh':
      // Already loading a new document: the same page load, same generation.
      if (state === 'starting' || state === 'refreshing') return machine;
      // A hung page cannot reload itself (Stop recreates it); a crashed one has no document to refresh.
      if (state === 'running' || (state === 'failed' && machine.failure === 'load-failed')) {
        return { state: 'refreshing', generation: generation + 1 };
      }
      return machine;
    case 'navigate':
      // Only a running page navigates by itself; while starting/refreshing it is the load already counted, and
      // Chromium's error page after a failed load is not a new page load.
      return state === 'running' ? { state: 'refreshing', generation: generation + 1 } : machine;
    case 'load-finished':
      return state === 'starting' || state === 'refreshing' ? { state: 'running', generation } : machine;
    case 'load-failed':
      return state === 'starting' || state === 'refreshing' || state === 'running'
        ? { state: 'failed', failure: 'load-failed', generation }
        : machine;
    case 'crashed':
      return isLive(state) ? { state: 'failed', failure: 'crashed', generation } : machine;
    case 'unresponsive':
      return state === 'starting' || state === 'running' || state === 'refreshing'
        ? { state: 'unresponsive', generation, resumeTo: state }
        : machine;
    case 'responsive': {
      if (state !== 'unresponsive') return machine;
      const back = machine.resumeTo ?? 'running';
      // If the page finished loading while it was busy, it is running now.
      return { state: back === 'running' || !event.loading ? 'running' : back, generation };
    }
  }
}
