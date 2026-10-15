/**
 * Where the Problems panel gets runtime, console and resource problems from (S17.1).
 *
 * - Preferred: the main process's problem store (S16.2, src/main/problems-bridge.ts), exposed by preload as
 *   `window.noobide.problems` — `list()`, `onChanged(listener)`, `clearResolved()`. It is feature-detected here.
 * - Until then: the same records are built in the workbench from the preview's own event stream (S05.4 raw records →
 *   src/preview/to-problem.ts → the bounded ProblemStore of src/diagnostics/store.ts). Attribution: every preview
 *   start or refresh begins a new generation; a problem that has not occurred since is marked `stale`.
 *
 * Static problems come from the editor (useStaticProblems) and are merged by the panel.
 */
import type { PreviewApi, PreviewEvent, PreviewStatus } from '../../shared/ipc/preview-contract';
import type { ProblemRecord } from '../../shared/problem';
import { ProblemStore } from '../../diagnostics/store';
import { previewEntryToProblem } from '../../preview/to-problem';

/** The S16 bridge API (typed here until it is part of NoobideApi). */
export interface RuntimeProblemsApi {
  list(): Promise<{ readonly ok: boolean; readonly value?: readonly ProblemRecord[] }>;
  onChanged(listener: (records: readonly ProblemRecord[]) => void): () => void;
  clearResolved(): Promise<unknown>;
}

export interface RuntimeSource {
  /** 'bridge': main's store (S16); 'preview-events': built here from the preview's records. */
  readonly kind: 'bridge' | 'preview-events';
  /** Calls the listener with the full current list now and on every change; returns the unsubscribe function. */
  subscribe(listener: (records: readonly ProblemRecord[]) => void): () => void;
  /** Removes problems that have not occurred again since the preview refreshed. */
  clearResolved(): Promise<void>;
  dispose(): void;
}

export function bridgeRuntimeSource(api: RuntimeProblemsApi): RuntimeSource {
  let latest: readonly ProblemRecord[] = [];
  const listeners = new Set<(records: readonly ProblemRecord[]) => void>();
  const publish = (records: readonly ProblemRecord[]) => {
    latest = records;
    for (const listener of [...listeners]) listener(records);
  };
  const unsubscribe = api.onChanged(publish);
  void api.list().then((result) => {
    if (result.ok && result.value) publish(result.value);
  });
  return {
    kind: 'bridge',
    subscribe(listener) {
      listeners.add(listener);
      listener(latest);
      return () => listeners.delete(listener);
    },
    async clearResolved() {
      await api.clearResolved();
    },
    dispose() {
      unsubscribe();
      listeners.clear();
    },
  };
}

export interface PreviewEventsOptions {
  /** Republish at most this often (a page can log thousands of messages; the store already caps and dedupes). */
  readonly throttleMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
}

/** The generation a record last occurred in. */
export const lastGeneration = (r: ProblemRecord): number | undefined => (r.last?.preview ?? r.preview)?.generation;

export function previewEventsRuntimeSource(
  preview: Pick<PreviewApi, 'onEvent'>,
  options: PreviewEventsOptions = {},
): RuntimeSource {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const throttleMs = options.throttleMs ?? 150;
  let store = new ProblemStore({ now });
  let status: PreviewStatus = { state: 'stopped', projectId: null };
  let generation = 0;
  let sessionId = `s${now().toString(36)}`;
  const listeners = new Set<(records: readonly ProblemRecord[]) => void>();
  let scheduled = false;

  const records = (): ProblemRecord[] =>
    store.list().map((r) => (lastGeneration(r) === generation ? r : { ...r, stale: true }));
  const flush = () => {
    scheduled = false;
    const list = records();
    for (const listener of [...listeners]) listener(list);
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimer(flush, throttleMs);
  };

  const onStatus = (next: PreviewStatus) => {
    const previous = status;
    status = next;
    if (next.projectId !== previous.projectId && next.projectId !== null) {
      // Another project's preview: its problems belong to that project only.
      store = new ProblemStore({ now });
      sessionId = `s${now().toString(36)}`;
      generation = 0;
    }
    // A start or refresh is a new generation: earlier problems are kept but marked as "before the refresh".
    if ((next.state === 'starting' || next.state === 'refreshing') && previous.state !== next.state) generation += 1;
    schedule();
  };

  const onEvent = (event: PreviewEvent) => {
    if (event.kind === 'status') {
      onStatus(event.status);
      return;
    }
    const projectId = status.projectId;
    const origin = status.url ? safeOrigin(status.url) : null;
    if (!projectId || !origin) return;
    for (const entry of event.entries) {
      const input = previewEntryToProblem(entry, {
        projectId,
        preview: { sessionId, generation },
        previewOrigin: origin,
      });
      if (input) store.add(input);
    }
    schedule();
  };
  const unsubscribe = preview.onEvent(onEvent);

  return {
    kind: 'preview-events',
    subscribe(listener) {
      listeners.add(listener);
      listener(records());
      return () => listeners.delete(listener);
    },
    async clearResolved() {
      store.clear((r) => lastGeneration(r) !== generation);
      flush();
    },
    dispose() {
      unsubscribe();
      listeners.clear();
    },
  };
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Picks the runtime source for this bridge: main's problem store when present, else the preview's event stream. */
export function runtimeSourceFor(
  bridge: { readonly preview?: Pick<PreviewApi, 'onEvent'>; readonly problems?: unknown } | undefined,
): RuntimeSource | null {
  const problems = bridge?.problems as RuntimeProblemsApi | undefined;
  if (problems && typeof problems.onChanged === 'function' && typeof problems.list === 'function') {
    return bridgeRuntimeSource(problems);
  }
  return bridge?.preview ? previewEventsRuntimeSource(bridge.preview) : null;
}
