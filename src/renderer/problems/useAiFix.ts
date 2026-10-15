import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProblemRecord } from '../../shared/problem';
import { canRecheckAiFix, isAiFixJudged, nextAiFixPhase, startAiFix, type AiFixState } from './ai-fix';
import { NO_LOADS, type PreviewLoads } from './usePreviewLoads';

/** What the workbench provides: the code check's answer for a saved file, and saves of open files. */
export interface AiFixHost {
  /** Whether the code check still reports the problem in its file (null: no answer). */
  stillReported(record: ProblemRecord): Promise<boolean | null>;
  /** Calls the listener after every confirmed save of any open file. */
  onSaved(listener: (relPath: string) => void): () => void;
}

export interface AiFix {
  readonly fix: AiFixState | null;
  /** Bumped whenever a new AI fix is tracked (its card takes focus once). */
  readonly serial: number;
  /** An accepted "Fix with AI" change was applied (and saved, or its save failed). */
  committed(record: ProblemRecord, outcome: { saved: boolean; saveError?: string; loadsAtRequest: number }): void;
  recheck(): void;
  clear(): void;
}

/**
 * S35.2: the latest accepted AI fix and its verdict, with the same evidence rules as the one-click fix (S22.5,
 * useProblemFix): re-evaluated after every re-check, every change of the runtime problems and every save of the
 * fixed file (an undo in the editor followed by a save brings "still reported" back).
 */
export function useAiFix(
  host: AiFixHost | null,
  runtimeRecords: readonly ProblemRecord[],
  loads: PreviewLoads = NO_LOADS,
): AiFix {
  const [fix, setFix] = useState<AiFixState | null>(null);
  const [staticReports, setStaticReports] = useState<boolean | null>(null);
  const [serial, setSerial] = useState(0);
  const current = useRef(fix);
  current.current = fix;
  const checks = useRef(0);
  const loadsRef = useRef(loads);
  loadsRef.current = loads;

  const update = useCallback((target: AiFixState, patch: Partial<AiFixState>) => {
    setFix((now) => (now && now.record.id === target.record.id ? { ...now, ...patch } : now));
  }, []);

  const recheckNow = useCallback(
    (target: AiFixState, loadsAtSave: number | null) => {
      if (!host) return;
      const seq = ++checks.current;
      setStaticReports(null);
      update(target, { phase: 'checking', ...(loadsAtSave !== null ? { loadsAtSave } : {}) });
      void host.stillReported(target.record).then((reports) => {
        if (seq !== checks.current || current.current?.record.id !== target.record.id) return;
        if (reports === null) update(target, { phase: 'unchecked' });
        else setStaticReports(reports);
      });
    },
    [host, update],
  );

  useEffect(() => {
    if (!fix || staticReports === null) return;
    const next = nextAiFixPhase(fix, staticReports, runtimeRecords, loads.completed);
    if (next !== fix.phase) update(fix, { phase: next });
  }, [fix, staticReports, runtimeRecords, loads.completed, update]);

  useEffect(() => {
    if (!host) return undefined;
    return host.onSaved((relPath) => {
      const now = current.current;
      if (!now || relPath !== now.record.file) return;
      if (isAiFixJudged(now.phase) || now.phase === 'save-failed' || now.phase === 'unchecked') {
        recheckNow(now, loadsRef.current.started);
      }
    });
  }, [host, recheckNow]);

  const committed = useCallback<AiFix['committed']>(
    (record, outcome) => {
      const started = startAiFix(record, outcome);
      checks.current += 1;
      setStaticReports(null);
      setFix(started);
      current.current = started;
      setSerial((n) => n + 1);
      if (outcome.saved) recheckNow(started, outcome.loadsAtRequest);
    },
    [recheckNow],
  );

  const recheck = useCallback(() => {
    const now = current.current;
    if (now && canRecheckAiFix(now)) recheckNow(now, null);
  }, [recheckNow]);

  const clear = useCallback(() => {
    checks.current += 1;
    setFix(null);
    setStaticReports(null);
  }, []);

  return { fix, serial, committed, recheck, clear };
}
