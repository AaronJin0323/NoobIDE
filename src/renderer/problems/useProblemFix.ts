import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProblemRecord } from '../../shared/problem';
import {
  canRecheck,
  isJudged,
  nextPhase,
  startFix,
  type FixState,
  type NotAppliedReason,
  type ReplaceTextAction,
} from './fix-model';

export type ApplyOutcome =
  | { readonly kind: 'applied'; readonly version: number }
  | { readonly kind: 'save-failed'; readonly version: number; readonly code: string }
  | { readonly kind: 'not-applied'; readonly reason: NotAppliedReason };

export type UndoOutcome =
  { readonly kind: 'undone' } | { readonly kind: 'save-failed'; readonly code: string } | { readonly kind: 'changed' };

/** What the workbench provides: the editor edit, the file's save pipeline and the language service's re-check. */
export interface FixHost {
  /** Opens the file, puts the fix in as one editor edit and saves it through the file's save pipeline. */
  apply(action: ReplaceTextAction): Promise<ApplyOutcome>;
  /** Takes the fix back (the editor's undo when nothing changed since) and saves. */
  undo(fix: FixState): Promise<UndoOutcome>;
  /** Saves the file again through its save pipeline. */
  retrySave(relPath: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>;
  /** Asks the language service whether the file still reports the misspelled name on that line (null: no answer). */
  stillReported(fix: FixState): Promise<boolean | null>;
  /** Calls the listener after every confirmed save of any open file. */
  onSaved(listener: (relPath: string) => void): () => void;
}

export interface ProblemFix {
  readonly fix: FixState | null;
  /** Bumped whenever a new fix starts (the card takes focus once per fix). */
  readonly serial: number;
  apply(record: ProblemRecord, action: ReplaceTextAction): void;
  undo(): void;
  retrySave(): void;
  recheck(): void;
  clear(): void;
}

/**
 * S22.5: the latest one-click fix and its state (fix-model.ts). The verdict is re-evaluated after every re-check, every
 * change of the runtime problems (a preview refresh marks them stale) and every save of the fixed file — so undoing in
 * the editor (Ctrl/Cmd+Z, then autosave) brings back "still reported" instead of a stale "resolved".
 */
export function useProblemFix(host: FixHost | null, runtimeRecords: readonly ProblemRecord[]): ProblemFix {
  const [fix, setFix] = useState<FixState | null>(null);
  const [staticReports, setStaticReports] = useState<boolean | null>(null);
  const [serial, setSerial] = useState(0);
  const current = useRef(fix);
  current.current = fix;
  const checks = useRef(0);

  const update = useCallback((target: FixState, patch: Partial<FixState>) => {
    setFix((now) => (now === target || (now && now.action === target.action) ? { ...now, ...patch } : now));
  }, []);

  const recheckNow = useCallback(
    (target: FixState) => {
      if (!host) return;
      const seq = ++checks.current;
      setStaticReports(null);
      update(target, { phase: 'checking' });
      void host.stillReported(target).then((reports) => {
        if (seq === checks.current && current.current?.action === target.action) setStaticReports(reports);
      });
    },
    [host, update],
  );

  // Verdict: after a re-check answered, and whenever the runtime problems change.
  useEffect(() => {
    if (!fix || staticReports === null) return;
    const next = nextPhase(fix, staticReports, runtimeRecords);
    if (next !== fix.phase) update(fix, { phase: next });
  }, [fix, staticReports, runtimeRecords, update]);

  // A save of the fixed file (autosave after an undo in the editor, a retried save, the user's own edit) re-checks.
  useEffect(() => {
    if (!host) return undefined;
    return host.onSaved((relPath) => {
      const now = current.current;
      if (!now || relPath !== now.action.span.file) return;
      if (isJudged(now.phase) || now.phase === 'save-failed') recheckNow(now);
    });
  }, [host, recheckNow]);

  const apply = useCallback(
    (record: ProblemRecord, action: ReplaceTextAction) => {
      if (!host || current.current?.phase === 'applying' || current.current?.phase === 'undoing') return;
      const started = startFix(record, action);
      checks.current += 1;
      setStaticReports(null);
      setFix(started);
      setSerial((n) => n + 1);
      void host.apply(action).then((outcome) => {
        if (outcome.kind === 'not-applied') update(started, { phase: 'not-applied', reason: outcome.reason });
        else if (outcome.kind === 'save-failed')
          update(started, { phase: 'save-failed', version: outcome.version, saveError: outcome.code });
        else {
          const applied = { ...started, version: outcome.version };
          update(started, { version: outcome.version });
          recheckNow(applied);
        }
      });
    },
    [host, update, recheckNow],
  );

  const undo = useCallback(() => {
    const now = current.current;
    if (!host || !now || now.version === undefined) return;
    checks.current += 1;
    update(now, { phase: 'undoing' });
    void host.undo(now).then((outcome) => {
      if (outcome.kind === 'undone') update(now, { phase: 'undone' });
      else if (outcome.kind === 'changed') update(now, { phase: 'undo-failed', reason: 'changed' });
      else update(now, { phase: 'undo-failed', saveError: outcome.code });
    });
  }, [host, update]);

  const retrySave = useCallback(() => {
    const now = current.current;
    if (!host || !now || now.phase !== 'save-failed') return;
    void host.retrySave(now.action.span.file).then((result) => {
      if (result.ok) recheckNow(now);
      else update(now, { saveError: result.code });
    });
  }, [host, update, recheckNow]);

  const recheck = useCallback(() => {
    const now = current.current;
    if (now && canRecheck(now)) recheckNow(now);
  }, [recheckNow]);

  const clear = useCallback(() => {
    checks.current += 1;
    setFix(null);
    setStaticReports(null);
  }, []);

  return { fix, serial, apply, undo, retrySave, recheck, clear };
}
