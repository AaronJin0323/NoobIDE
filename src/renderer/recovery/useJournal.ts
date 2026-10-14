import { useEffect, useMemo, useState } from 'react';
import type { NoobideApi } from '../../shared/ipc/contract';
import { JournalScheduler, browserTimers, type JournalHealth } from './journal-scheduler';

/**
 * One crash-recovery journal scheduler for the workbench (S12.1). The editor calls `begin` when a buffer is loaded,
 * `edited` on every change and `saved` after a successful save; nothing else in the workbench needs to know about
 * the journal. When tabs arrive (S09) each tab's buffer gets its own scheduler the same way.
 */
export function useJournal(bridge: NoobideApi | undefined): { scheduler: JournalScheduler; health: JournalHealth } {
  const [health, setHealth] = useState<JournalHealth>(null);
  const scheduler = useMemo(() => {
    const sink = bridge?.recovery ?? {
      record: async () => ({ ok: true as const, value: { written: false } }),
      discardSaved: async () => ({ ok: true as const, value: { removed: false } }),
    };
    return new JournalScheduler(sink, browserTimers, setHealth);
  }, [bridge]);

  // Closing the window normally: send the last unsent copy (best effort; a crash is covered by the 2 s bound).
  useEffect(() => {
    const flush = () => void scheduler.flush();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [scheduler]);

  return { scheduler, health };
}
