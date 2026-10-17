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
import { beginnerFacts } from '../../diagnostics/beginner-checks';
import { identifierColumns } from '../../diagnostics/text';
import { lastGeneration } from './sources';

export type ReplaceTextAction = Extract<ProblemAction, { kind: 'replace-text' }>;
/** S55.3: create a missing file from a template (never overwrites). */
export type CreateFileAction = Extract<ProblemAction, { kind: 'create-file' }>;
/** What a fix does: replace one span (S22.5, S55.3) or create one missing file (S55.3). */
export type FixAction = ReplaceTextAction | CreateFileAction;

/** The file a fix edits: the replaced span's file, or the created file. */
export const fixFile = (action: FixAction): string => (action.kind === 'create-file' ? action.path : action.span.file);

/** Where the problem a fix addresses is reported (the created file's reference, for a create-file fix). */
export function problemSite(action: FixAction): { readonly file: string; readonly line: number } {
  return action.kind === 'create-file'
    ? { file: action.problemFile, line: action.problemLine }
    : { file: action.span.file, line: action.span.line };
}

/** The S22.5 misspelled-name fix (re-checked by the JavaScript language service), not an S55.3 quick fix. */
export const isNameFix = (action: FixAction): action is ReplaceTextAction =>
  action.kind === 'replace-text' && (action.match ?? 'identifier') === 'identifier';

/** Rules 16, 18, 19, 23 and 24 (S55.2) whose single unambiguous action is a quick fix (S55.3). */
export const QUICK_FIX_RULES: ReadonlySet<string> = new Set([
  'html-broken-ref',
  'html-ref-case',
  'html-img-no-alt',
  'html-mismatched-close',
  'js-selector-prefix',
]);

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

/**
 * `exists`: a file to create is already there (never overwritten); `created-empty`: created, then not filled;
 * `create-failed`: the file could not be created (the error code is kept in `saveError`).
 */
export type NotAppliedReason = 'changed' | 'read-only' | 'not-open' | 'exists' | 'created-empty' | 'create-failed';

export interface FixState {
  /** Snapshot of the problem as it was when the fix was chosen: its original error stays available until cleared. */
  readonly record: ProblemRecord;
  readonly action: FixAction;
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
 * The fix the card and the lightbulb may offer for this explanation: a `replace-text` action of the did-you-mean
 * rule with exactly one candidate, whose replacement is that candidate (S22.5); or the one quick fix of rules 16, 18,
 * 19, 23 and 24 (S55.3) — an exact replacement or a file creation. Several fix actions are ambiguous: none is offered.
 */
export function fixActionOf(explanation: ProblemExplanation): FixAction | null {
  if (explanation.ruleId === UNDEFINED_NAME_RULE_ID) {
    if (explanation.candidates?.length !== 1) return null;
    const action = explanation.actions.find((a): a is ReplaceTextAction => a.kind === 'replace-text');
    if (!action || action.to !== explanation.candidates[0] || action.from === action.to) return null;
    return action;
  }
  if (!QUICK_FIX_RULES.has(explanation.ruleId)) return null;
  const fixes = explanation.actions.filter(
    (a): a is FixAction => (a.kind === 'replace-text' && a.match === 'exact') || a.kind === 'create-file',
  );
  const [only] = fixes;
  if (fixes.length !== 1 || !only) return null;
  if (
    only.kind === 'replace-text' &&
    (only.from === only.to || only.span.endColumn !== only.span.column + only.from.length)
  )
    return null;
  return only;
}

export function startFix(record: ProblemRecord, action: FixAction): FixState {
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

/**
 * S55.3: the text a fix expects at `column` of `lineText`: the whole identifier (S22.5 name fix), or exactly that
 * text (a path, a tag name, a selector string).
 */
export function holdsText(
  lineText: string,
  column: number,
  text: string,
  match: 'identifier' | 'exact' = 'identifier',
) {
  return match === 'identifier'
    ? holdsIdentifier(lineText, column, text)
    : lineText.slice(column - 1, column - 1 + text.length) === text;
}

/** Facts that tell one beginner finding from another on the same line (S55.2 `data`). */
const KEY_FACTS = ['ref', 'tagName', 'selector', 'id', 'property'] as const;

/**
 * S55.3: a beginner-check finding (code, line, message) is the problem `record` reported again: same code, same line,
 * and the same key facts (the same path, tag, selector or id).
 */
export function sameBeginnerFinding(
  record: ProblemRecord,
  finding: { readonly code: string; readonly line: number; readonly message: string },
): boolean {
  if (finding.code !== record.code || finding.line !== record.line) return false;
  const facts = beginnerFacts(finding.code, finding.message) ?? {};
  return KEY_FACTS.every((k) => record.data?.[k] === undefined || String(record.data[k]) === facts[k]);
}

/** A current problem is the one the fix addresses: the same misspelled name (S22.5) or beginner finding (S55.3). */
export function reportsSameProblem(fix: FixState, record: ProblemRecord): boolean {
  const { action } = fix;
  if (isNameFix(action)) {
    const { span, from } = action;
    return record.file === span.file && record.line === span.line && undefinedName(record)?.name === from;
  }
  const site = problemSite(action);
  return (
    record.file === site.file &&
    record.code === fix.record.code &&
    sameBeginnerFinding(fix.record, { code: record.code, line: record.line ?? 0, message: record.originalMessage })
  );
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
  return judge(fix, staticReports, runtime, completedLoad, (r) => reportsSameProblem(fix, r));
}

/** What a verdict needs of a fix: the one-click fix above, or an AI fix (S35.2, problems/ai-fix.ts). */
export interface JudgedFix {
  readonly record: ProblemRecord;
  readonly generation?: number;
  readonly loadsAtSave?: number;
}

/**
 * The S22.5 rules for any fix, given how to recognise the same problem in a newer report (`same`): still reported
 * when the re-check says so or the page reported it again in a newer load; resolved only after a re-check answered
 * and — for a page problem — a preview load completed after the save without it.
 */
export function judge(
  fix: JudgedFix,
  staticReports: boolean | null,
  runtime: readonly ProblemRecord[],
  completedLoad: number,
  same: (record: ProblemRecord) => boolean,
): Verdict {
  if (staticReports === true) return 'still-reported';
  const fromPage = fix.record.source !== 'static';
  const live = runtime.filter((r) => !r.stale && r.source !== 'static' && same(r));
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

/**
 * Whether a confirmed save of `relPath` re-checks the fix. A save of the fixed file always may (a retried save, an
 * undo in the editor, the user's own edit). A save of the page that reports the problem (S55.3: the reference to a
 * created file lives in another file) re-checks only a saved fix: a fix whose own save failed stays "save failed"
 * until the fixed file itself is saved, so it can never become resolved through another file.
 */
export function recheckOnSave(fix: FixState, relPath: string): boolean {
  const own = relPath === fixFile(fix.action);
  if (!own && relPath !== problemSite(fix.action).file) return false;
  return isJudged(fix.phase) || fix.phase === 'unchecked' || (own && fix.phase === 'save-failed');
}
