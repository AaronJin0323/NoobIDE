import { useEffect, useState } from 'react';
import type { ProblemRecord } from '../../shared/problem';
import { runtimeSourceFor, type RuntimeSource } from './sources';

export interface RuntimeProblemsHandle {
  readonly records: readonly ProblemRecord[];
  /** Which source feeds the list: main's problem store (S16) or the preview's event stream. */
  readonly kind: RuntimeSource['kind'] | null;
  clearResolved(): void;
}

/** S17.1: runtime, console and resource problems for the Problems panel (see sources.ts). */
export function useRuntimeProblems(bridge: Parameters<typeof runtimeSourceFor>[0]): RuntimeProblemsHandle {
  const [state, setState] = useState<{ source: RuntimeSource | null; records: readonly ProblemRecord[] }>({
    source: null,
    records: [],
  });
  useEffect(() => {
    const source = runtimeSourceFor(bridge);
    if (!source) return undefined;
    const unsubscribe = source.subscribe((records) => setState({ source, records }));
    return () => {
      unsubscribe();
      source.dispose();
    };
  }, [bridge]);
  return {
    records: state.records,
    kind: state.source?.kind ?? null,
    clearResolved: () => void state.source?.clearResolved(),
  };
}
