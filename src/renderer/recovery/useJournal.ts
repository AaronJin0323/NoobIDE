import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NoobideApi } from '../../shared/ipc/contract';
import { JournalScheduler, browserTimers, type JournalHealth, type JournalSink } from './journal-scheduler';

export interface Journals {
  /** A scheduler for one open tab's buffer (S09 tabs): `begin` on load, `edited` on change, `saved` after a save. */
  create(): JournalScheduler;
  /** Stops journaling a closed tab's buffer. Its last record stays in the journal until the file is saved. */
  release(scheduler: JournalScheduler): void;
  /** Last journal failure of any buffer, for the UI. */
  readonly health: JournalHealth;
}

/**
 * Crash-recovery journal schedulers for the workbench (S12.1): one per open tab, so each buffer's unsaved edits are
 * journaled independently of the others (and independently of undo, autosave and history).
 */
export function useJournals(bridge: NoobideApi | undefined): Journals {
  const [health, setHealth] = useState<JournalHealth>(null);
  const live = useRef(new Set<JournalScheduler>());
  const sink = useMemo<JournalSink>(
    () =>
      bridge?.recovery ?? {
        record: async () => ({ ok: true as const, value: { written: false } }),
        discardSaved: async () => ({ ok: true as const, value: { removed: false } }),
      },
    [bridge],
  );

  const create = useCallback(() => {
    const scheduler = new JournalScheduler(sink, browserTimers, setHealth);
    live.current.add(scheduler);
    return scheduler;
  }, [sink]);

  const release = useCallback((scheduler: JournalScheduler) => {
    scheduler.begin(null);
    live.current.delete(scheduler);
  }, []);

  // Closing the window normally: send the last unsent copies (best effort; a crash is covered by the 2 s bound).
  useEffect(() => {
    const flush = () => {
      for (const scheduler of live.current) void scheduler.flush();
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  return useMemo(() => ({ create, release, health }), [create, release, health]);
}
