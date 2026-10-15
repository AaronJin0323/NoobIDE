/**
 * One-click fix for a misspelled name (S22.5): the state of the latest fix, and when it may be called resolved.
 * Pure (no React, no Monaco), so every rule below is unit-tested.
 *
 * - Offered only when the did-you-mean rule found exactly one declared name and located the misspelled span
 *   (`fixActionOf`); otherwise the card shows the normal explanation and Go to code.
 * - The fix is an ordinary editor edit followed by the file's normal save pipeline. A failed save keeps the edit (in the
 *   editor) and the card says the save failed: such a fix is never resolved.
 * - Resolved only on evidence: the language service re-checked the saved file and no longer reports the name on that
 *   line, and — for a problem the running page reported — the preview has reloaded since and it has not occurred
 *   again. Until then the card says what it is waiting for. The original record stays on the card until cleared.
 */
import type { ProblemAction, ProblemExplanation, ProblemRecord } from '../../shared/problem';
import { UNDEFINED_NAME_RULE_ID, undefinedName } from '../../diagnostics/rules';
import { identifierColumns } from '../../diagnostics/text';
import { lastGeneration } from './sources';

export type ReplaceTextAction = Extract<ProblemAction, { kind: 'replace-text' }>;

export type FixPhase =
  /** Opening the file, putting the edit in, saving. */
  | 'applying'
  /** Nothing was changed (the code changed since the check, the file is read-only or could not be opened). */
  | 'not-applied'
  /** The edit is in the editor but the save failed: never resolved. */
  | 'save-failed'
  /** Saved; the language service is re-checking. */
  | 'checking'
  /** Saved, but the language service gave no answer (timed out, file closed, not JavaScript): not resolved. */
  | 'unchecked'
  /** Saved and the code check is clear; the page reported this problem, so a preview reload must confirm it. */
  | 'awaiting-refresh'
  /** The re-check (or the reloaded page) still reports it. */
  | 'still-reported'
  | 'resolved'
  | 'undoing'
  /** The card's Undo put the original text back (and saved it). */
  | 'undone'
  /** Undo could not be applied or saved. */
  | 'undo-failed';

export type NotAppliedReason = 'changed' | 'read-only' | 'not-open';

export interface FixState {
  /** Snapshot of the problem as it was when the fix was chosen: its original error stays available until cleared. */
  readonly record: ProblemRecord;
  readonly action: ReplaceTextAction;
  readonly phase: FixPhase;
  readonly reason?: NotAppliedReason;
  /** Save error code (save pipeline / contract code) when a save failed. */
  readonly saveError?: string;
  /** Editor model version right after the fix (the card's Undo uses the editor's own undo while it still matches). */
  readonly version?: number;
  /** Preview generation the problem last occurred in when the fix was made (runtime problems). */
  readonly generation?: number;
  /** Preview loads started when the fix was last saved (usePreviewLoads): a page problem needs a later load. */
  readonly loadsAtSave?: number;
}

/**
 * The fix the card may offer for this explanation: only a `replace-text` action of the did-you-mean rule with
 * exactly one candidate, whose replacement is that candidate.
 */
export function fixActionOf(explanation: ProblemExplanation): ReplaceTextAction | null {
  if (explanation.ruleId !== UNDEFINED_NAME_RULE_ID || explanation.candidates?.length !== 1) return null;
  const action = explanation.actions.find((a): a is ReplaceTextAction => a.kind === 'replace-text');
  if (!action || action.to !== explanation.candidates[0] || action.from === action.to) return null;
  return action;
}

export function startFix(record: ProblemRecord, action: ReplaceTextAction): FixState {
  const generation = record.source === 'static' ? undefined : lastGeneration(record);
  return { record, action, phase: 'applying', ...(generation !== undefined ? { generation } : {}) };
}

/**
 * True when `name` stands at 1-based `column` of `lineText` as a whole identifier — not a piece of a longer name
 * (`usrNameList`) and not a property after `.`. A fix or its undo touches the text only then.
 */
export function holdsIdentifier(lineText: string, column: number, name: string): boolean {
  return identifierColumns(lineText, name).includes(column);
}

/** A current problem reports the same misspelled name on the same line of the same file. */
export function reportsSameProblem(fix: FixState, record: ProblemRecord): boolean {
  const { span, from } = fix.action;
  return record.file === span.file && record.line === span.line && undefinedName(record)?.name === from;
}

export type Verdict = 'checking' | 'awaiting-refresh' | 'still-reported' | 'resolved';

/**
 * Whether a saved fix is resolved.
 * @param staticReports the language service's answer after the save: true = still reported, false = not reported,
 *   null = no answer (yet)
 * @param runtime current runtime/console records of the project (with `stale` set for those not seen since the
 *   preview reloaded)
 * @param completedLoad number of the latest completed preview load (usePreviewLoads `completed`)
 */
export function verdict(
  fix: FixState,
  staticReports: boolean | null,
  runtime: readonly ProblemRecord[],
  completedLoad = 0,
): Verdict {
  if (staticReports === true) return 'still-reported';
  const fromPage = fix.record.source !== 'static';
  const live = runtime.filter((r) => !r.stale && r.source !== 'static' && reportsSameProblem(fix, r));
  // Seen again in a page load after the one the fix was made in.
  if (fromPage && live.some((r) => (lastGeneration(r) ?? 0) > (fix.generation ?? 0))) return 'still-reported';
  if (staticReports === null) return 'checking';
  // A page problem needs a page load that completed after the fix was saved, and in which it did not occur.
  if (fromPage && (fix.loadsAtSave === undefined || completedLoad <= fix.loadsAtSave)) return 'awaiting-refresh';
  if (fromPage && live.length > 0) return 'awaiting-refresh';
  return 'resolved';
}

/** Phases in which the fix is in the file (so the card offers Undo). */
export function canUndo(fix: FixState): boolean {
  return (
    fix.version !== undefined &&
    (fix.phase === 'save-failed' ||
      fix.phase === 'checking' ||
      fix.phase === 'unchecked' ||
      fix.phase === 'awaiting-refresh' ||
      fix.phase === 'still-reported' ||
      fix.phase === 'resolved' ||
      fix.phase === 'undo-failed')
  );
}

/** Phases in which the fix is saved and its effect is being (or can be) checked again. */
export function canRecheck(fix: FixState): boolean {
  return (
    fix.phase === 'checking' ||
    fix.phase === 'unchecked' ||
    fix.phase === 'awaiting-refresh' ||
    fix.phase === 'still-reported'
  );
}

/** Phases whose outcome follows the re-check and the runtime problems (the fix is saved). */
const JUDGED: ReadonlySet<FixPhase> = new Set(['checking', 'awaiting-refresh', 'still-reported', 'resolved']);

/**
 * The phase after new evidence. Only a saved fix is judged: applying, not applied, a failed save and undo keep
 * their phase — so a fix whose save failed can never become resolved.
 */
export function nextPhase(
  fix: FixState,
  staticReports: boolean | null,
  runtime: readonly ProblemRecord[],
  completedLoad = 0,
): FixPhase {
  return JUDGED.has(fix.phase) ? verdict(fix, staticReports, runtime, completedLoad) : fix.phase;
}

export const isJudged = (phase: FixPhase): boolean => JUDGED.has(phase);
