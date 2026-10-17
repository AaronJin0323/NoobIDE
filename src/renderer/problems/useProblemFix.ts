import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProblemRecord } from '../../shared/problem';
import {
  canRecheck,
  fixFile,
  nextPhase,
  recheckOnSave,
  startFix,
  type FixAction,
  type FixState,
  type NotAppliedReason,
} from './fix-model';
import { NO_LOADS, type PreviewLoads } from './usePreviewLoads';

export type ApplyOutcome =
  | { readonly kind: 'applied'; readonly version: number }
  | { readonly kind: 'save-failed'; readonly version: number; readonly code: string }
  /** `code`: why a file could not be created (S55.3, a workspace FileOpError). */
  | { readonly kind: 'not-applied'; readonly reason: NotAppliedReason; readonly code?: string };

export type UndoOutcome =
  { readonly kind: 'undone' } | { readonly kind: 'save-failed'; readonly code: string } | { readonly kind: 'changed' };

/** What the workbench provides: the editor edit, the file's save pipeline and the language service's re-check. */
export interface FixHost {
  /**
   * Opens the file, puts the fix in as one editor edit and saves it through the file's save pipeline (S55.3: for a
   * missing file, creates it first — never over anything that exists).
   */
  apply(action: FixAction, record?: ProblemRecord): Promise<ApplyOutcome>;
  /** Takes the fix back (the editor's undo when nothing changed since) and saves. */
  undo(fix: FixState): Promise<UndoOutcome>;
  /** Saves the file again through its save pipeline. */
  retrySave(relPath: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>;
  /** Asks the language service (or the beginner checks) whether the problem is still reported (null: no answer). */
  stillReported(fix: FixState): Promise<boolean | null>;
  /** Calls the listener after every confirmed save of any open file. */
  onSaved(listener: (relPath: string) => void): () => void;
}

export interface ProblemFix {
  readonly fix: FixState | null;
  /** Bumped whenever a new fix starts (the card takes focus once per fix). */
  readonly serial: number;
  /** Where the latest fix was chosen (S55.3): a lightbulb fix leaves focus in the editor. */
  readonly origin: 'card' | 'lightbulb';
  /** `origin`: the lightbulb keeps the keyboard in the editor (the card does not take focus). */
  apply(record: ProblemRecord, action: FixAction, origin?: 'card' | 'lightbulb'): void;
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
export function useProblemFix(
  host: FixHost | null,
  runtimeRecords: readonly ProblemRecord[],
  loads: PreviewLoads = NO_LOADS,
): ProblemFix {
  const [fix, setFix] = useState<FixState | null>(null);
  const [staticReports, setStaticReports] = useState<boolean | null>(null);
  const [serial, setSerial] = useState(0);
  const [origin, setOrigin] = useState<'card' | 'lightbulb'>('card');
  const current = useRef(fix);
  current.current = fix;
  const checks = useRef(0);
  const loadsRef = useRef(loads);
  loadsRef.current = loads;

  const update = useCallback((target: FixState, patch: Partial<FixState>) => {
    setFix((now) => (now === target || (now && now.action === target.action) ? { ...now, ...patch } : now));
  }, []);

  /**
   * `loadsAtSave`: the file was just saved — a page problem then needs a preview load that started after the count
   * given here. Callers take it when the save is *requested*: the refresh a confirmed save triggers (S10.5) can be
   * reported before the save's own result reaches this hook, and must still count.
   */
  const recheckNow = useCallback(
    (target: FixState, loadsAtSave: number | null) => {
      if (!host) return;
      const seq = ++checks.current;
      setStaticReports(null);
      update(target, { phase: 'checking', ...(loadsAtSave !== null ? { loadsAtSave } : {}) });
      void host.stillReported(target).then((reports) => {
        if (seq !== checks.current || current.current?.action !== target.action) return;
        // No answer is not a clean answer: the card says it could not check, and never calls it resolved.
        if (reports === null) update(target, { phase: 'unchecked' });
        else setStaticReports(reports);
      });
    },
    [host, update],
  );

  // Verdict: after a re-check answered, and whenever the runtime problems change.
  useEffect(() => {
    if (!fix || staticReports === null) return;
    const next = nextPhase(fix, staticReports, runtimeRecords, loads.completed);
    if (next !== fix.phase) update(fix, { phase: next });
  }, [fix, staticReports, runtimeRecords, loads.completed, update]);

  // A save of the fixed file (autosave after an undo in the editor, a retried save, the user's own edit) re-checks.
  useEffect(() => {
    if (!host) return undefined;
    return host.onSaved((relPath) => {
      const now = current.current;
      // Heard only after the save: a refresh it triggered may already be counted, so this can wait for one more
      // load than needed (never less) — conservative, and the preview's Refresh settles it.
      if (now && recheckOnSave(now, relPath)) recheckNow(now, loadsRef.current.started);
    });
  }, [host, recheckNow]);

  const apply = useCallback(
    (record: ProblemRecord, action: FixAction, from: 'card' | 'lightbulb' = 'card') => {
      if (!host || current.current?.phase === 'applying' || current.current?.phase === 'undoing') return;
      const started = startFix(record, action);
      checks.current += 1;
      setStaticReports(null);
      setFix(started);
      setOrigin(from);
      setSerial((n) => n + 1);
      const loadsAtRequest = loadsRef.current.started;
      void host.apply(action, record).then((outcome) => {
        if (outcome.kind === 'not-applied')
          update(started, {
            phase: 'not-applied',
            reason: outcome.reason,
            ...(outcome.code ? { saveError: outcome.code } : {}),
          });
        else if (outcome.kind === 'save-failed')
          update(started, { phase: 'save-failed', version: outcome.version, saveError: outcome.code });
        else {
          const applied = { ...started, version: outcome.version };
          update(started, { version: outcome.version });
          recheckNow(applied, loadsAtRequest);
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
    const loadsAtRequest = loadsRef.current.started;
    void host.retrySave(fixFile(now.action)).then((result) => {
      if (result.ok) recheckNow(now, loadsAtRequest);
      else update(now, { saveError: result.code });
    });
  }, [host, update, recheckNow]);

  const recheck = useCallback(() => {
    const now = current.current;
    if (now && canRecheck(now)) recheckNow(now, null);
  }, [recheckNow]);

  const clear = useCallback(() => {
    checks.current += 1;
    setFix(null);
    setStaticReports(null);
  }, []);

  return { fix, serial, origin, apply, undo, retrySave, recheck, clear };
}
