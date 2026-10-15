/**
 * S35.2 "Fix with AI": what happened to an accepted AI fix, and when it may be called resolved — the S22.5 rules
 * (fix-model.ts `judge`): resolved only after the code check answered that the problem is gone and, for a problem
 * the running page reported, a preview load completed after the save without it. A fix whose save failed is never
 * resolved. Pure, unit-tested in ai-fix.test.ts.
 *
 * Unlike the one-click fix, the AI may rewrite several lines, so the same problem is recognised by what it reports
 * (the same undefined name, or the same code and message in the same file), not by its line.
 */
import type { ProblemRecord } from '../../shared/problem';
import { undefinedName } from '../../diagnostics/rules';
import { judge } from './fix-model';
import { lastGeneration } from './sources';

export type AiFixPhase =
  /** Applied in the editor, but the save failed: not resolved. */
  | 'save-failed'
  /** Saved; the code check is re-checking. */
  | 'checking'
  /** Saved, but the code check gave no answer: not resolved. */
  | 'unchecked'
  | 'awaiting-refresh'
  | 'still-reported'
  | 'resolved';

export interface AiFixState {
  /** The problem as it was when "Fix with AI" was chosen (its original error stays available). */
  readonly record: ProblemRecord;
  readonly phase: AiFixPhase;
  readonly saveError?: string;
  /** Preview generation the problem last occurred in (page problems). */
  readonly generation?: number;
  /** Preview loads started when the fix was last saved. */
  readonly loadsAtSave?: number;
}

export function startAiFix(
  record: ProblemRecord,
  outcome: { readonly saved: boolean; readonly saveError?: string; readonly loadsAtRequest: number },
): AiFixState {
  const generation = record.source === 'static' ? undefined : lastGeneration(record);
  return {
    record,
    phase: outcome.saved ? 'checking' : 'save-failed',
    ...(outcome.saved ? { loadsAtSave: outcome.loadsAtRequest } : {}),
    ...(outcome.saveError ? { saveError: outcome.saveError } : {}),
    ...(generation !== undefined ? { generation } : {}),
  };
}

/** A newer report of the problem the AI fixed: same file, and the same undefined name or the same code and message. */
export function sameAiProblem(fixed: ProblemRecord, record: ProblemRecord): boolean {
  if (record.file !== fixed.file) return false;
  const name = undefinedName(fixed)?.name;
  if (name !== undefined) return undefinedName(record)?.name === name;
  return record.code === fixed.code && record.originalMessage === fixed.originalMessage;
}

const JUDGED: ReadonlySet<AiFixPhase> = new Set(['checking', 'awaiting-refresh', 'still-reported', 'resolved']);
export const isAiFixJudged = (phase: AiFixPhase): boolean => JUDGED.has(phase);

/** The phase after new evidence; only a saved fix is judged (a failed save keeps its phase). */
export function nextAiFixPhase(
  fix: AiFixState,
  staticReports: boolean | null,
  runtime: readonly ProblemRecord[],
  completedLoad: number,
): AiFixPhase {
  if (!JUDGED.has(fix.phase)) return fix.phase;
  return judge(fix, staticReports, runtime, completedLoad, (r) => sameAiProblem(fix.record, r));
}

export function canRecheckAiFix(fix: AiFixState): boolean {
  return (
    fix.phase === 'checking' ||
    fix.phase === 'unchecked' ||
    fix.phase === 'awaiting-refresh' ||
    fix.phase === 'still-reported'
  );
}
