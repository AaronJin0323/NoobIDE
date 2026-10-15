/**
 * S35.1 inline edit (Ctrl/Cmd+I) and S35.2 "Fix with AI": the pure rules, unit-tested in inline-edit-model.test.ts.
 *
 * - The edited range is whole lines: the selected lines (a selection that ends at the start of a line does not
 *   include that line), or the whole file when nothing is selected.
 * - The request carries the range text plus bounded context before and after it (a few dozen lines, a few thousand
 *   characters), the instruction and the UI locale. Ranges too large to send are refused before anything is sent.
 * - The answer replaces the range only after review: it is normalised (line endings of the file, the range's trailing
 *   line break kept as it was), shown as a line diff, and applied on Accept only while the range still holds exactly
 *   the text that was sent (`sameRangeText`); otherwise nothing changes and the user is told why.
 */
import type { AiErrorCode, AiRequest } from '../../shared/ipc/ai-contract';
import { diffLines, type LineDiff } from '../recovery/line-diff';

export type EditRequest = Extract<AiRequest, { kind: 'edit' }>;

/** Lines of context sent before and after the range, and their character budget (each side). */
export const EDIT_CONTEXT_LINES = 40;
export const EDIT_CONTEXT_CHARS = 4000;
/** Larger ranges are not sent (the service's own limit is higher; this keeps answers reviewable). */
export const EDIT_MAX_RANGE_CHARS = 40_000;
/** Lines around a reported problem line that "Fix with AI" lets the model rewrite. */
export const FIX_LINES_AROUND = 3;

/** 1-based, inclusive. */
export interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
}

/** Whole lines of a selection (already clamped by the editor), or the whole file when there is none. */
export function editLinesOf(lineCount: number, selection: LineRange | null): LineRange & { wholeFile: boolean } {
  const last = Math.max(1, lineCount);
  if (!selection) return { startLine: 1, endLine: last, wholeFile: true };
  const startLine = Math.min(Math.max(1, selection.startLine), last);
  const endLine = Math.min(Math.max(startLine, selection.endLine), last);
  return { startLine, endLine, wholeFile: false };
}

/** Lines around a reported problem line for "Fix with AI" (clamped to the file). */
export function fixLinesOf(lineCount: number, line: number, around = FIX_LINES_AROUND): LineRange {
  const last = Math.max(1, lineCount);
  const at = Math.min(Math.max(1, line), last);
  return { startLine: Math.max(1, at - around), endLine: Math.min(last, at + around) };
}

const splitKeep = (text: string): string[] => text.split(/(?<=\n)/);

/**
 * Context around the range: at most EDIT_CONTEXT_LINES lines and EDIT_CONTEXT_CHARS characters on each side, the
 * lines nearest to the range kept first.
 */
export function editContext(fullText: string, range: LineRange): { readonly before: string; readonly after: string } {
  const lines = splitKeep(fullText);
  const beforeLines = lines.slice(Math.max(0, range.startLine - 1 - EDIT_CONTEXT_LINES), range.startLine - 1);
  const afterLines = lines.slice(range.endLine, range.endLine + EDIT_CONTEXT_LINES);
  let before = '';
  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    const line = beforeLines[i] ?? '';
    if (before.length + line.length > EDIT_CONTEXT_CHARS) break;
    before = line + before;
  }
  let after = '';
  for (const line of afterLines) {
    if (after.length + line.length > EDIT_CONTEXT_CHARS) break;
    after += line;
  }
  return { before: before.replace(/\r?\n$/, ''), after: after.replace(/\r?\n$/, '') };
}

export function buildEditRequest(input: {
  readonly projectId: string;
  readonly relPath: string;
  readonly languageId: string;
  readonly instruction: string;
  readonly fullText: string;
  readonly range: LineRange;
  readonly original: string;
  readonly locale: 'zh-CN' | 'en';
}): EditRequest {
  const { before, after } = editContext(input.fullText, input.range);
  return {
    kind: 'edit',
    projectId: input.projectId,
    relPath: input.relPath,
    languageId: input.languageId,
    instruction: input.instruction.trim(),
    selection: input.original,
    before,
    after,
    locale: input.locale,
  };
}

/** The instruction "Fix with AI" sends for a reported problem: where it is and the original error, verbatim. */
export function fixInstruction(problem: {
  readonly line?: number | undefined;
  readonly originalMessage: string;
  readonly code: string;
}): string {
  const where = problem.line !== undefined ? ` reported at line ${problem.line} of the file` : '';
  return (
    `Fix this problem${where} with the smallest change to the selected code; keep everything else as it is.\n` +
    `Original error (${problem.code}): ${problem.originalMessage}`
  );
}

/** Too large to send: checked before anything leaves the machine. */
export const rangeTooLarge = (original: string): boolean => original.length > EDIT_MAX_RANGE_CHARS;

/**
 * The answer as the replacement of the range: the file's line endings, and the range's trailing line break kept as
 * it was (a range of whole lines has none unless it is the whole file ending with one).
 */
export function normalizeProposal(original: string, proposal: string, eol: '\n' | '\r\n'): string {
  let text = proposal.replace(/\r\n?/g, '\n');
  const originalEndsWithBreak = /\n$/.test(original);
  if (!originalEndsWithBreak) text = text.replace(/\n$/, '');
  else if (text !== '' && !text.endsWith('\n')) text += '\n';
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

/** Line endings do not count: the editor model has its own. */
export const sameRangeText = (current: string | null, original: string): boolean =>
  current !== null && current.replace(/\r\n?/g, '\n') === original.replace(/\r\n?/g, '\n');

export function proposalDiff(original: string, proposal: string): LineDiff {
  return diffLines(original, proposal, 3);
}

// ── session state ──

export type InlineEditPhase =
  /** Waiting for the user's instruction. */
  | 'instruction'
  /** The project has no AI consent yet: the consent prompt is shown first. */
  | 'consent'
  /** No API key / no secure storage: explained, with a way to Settings → AI. */
  | 'no-key'
  /** The file cannot be changed (read-only, other encoding). */
  | 'read-only'
  /** The request is running (Stop cancels it). */
  | 'running'
  /** The proposed change is shown as a diff: Accept / Reject. */
  | 'review'
  /** The answer is the same as the current code. */
  | 'no-change'
  /** Accept: putting the change in and saving. */
  | 'applying'
  /** Applied and saved (the zone closes; this is announced). */
  | 'applied'
  /** Applied in the editor, but the save failed: the change stays in the editor, unsaved. */
  | 'save-failed'
  /** The code in the range changed after it was sent: nothing applied. */
  | 'stale'
  /** The request failed (AiErrorCode explained), or was refused before sending (too large). */
  | 'error'
  /** Stopped by the user: nothing changed. */
  | 'cancelled';

export interface InlineEditState {
  readonly phase: InlineEditPhase;
  readonly instruction: string;
  readonly requestId: string | null;
  /** Normalised replacement of the range, once the answer is complete. */
  readonly proposal: string | null;
  readonly error: { readonly code: AiErrorCode | string; readonly message?: string } | null;
  /** Save error code for 'save-failed'. */
  readonly saveError: string | null;
}

export const initialEditState = (phase: InlineEditPhase, instruction = ''): InlineEditState => ({
  phase,
  instruction,
  requestId: null,
  proposal: null,
  error: null,
  saveError: null,
});

export type InlineEditAction =
  /** A new session (or the consent question again after main answered no-consent). */
  | { readonly type: 'reset'; readonly state: InlineEditState }
  | { readonly type: 'instruction'; readonly text: string }
  | { readonly type: 'consented' }
  | { readonly type: 'send' }
  | { readonly type: 'started'; readonly requestId: string }
  | { readonly type: 'answer'; readonly original: string; readonly text: string; readonly eol: '\n' | '\r\n' }
  | { readonly type: 'failed'; readonly code: AiErrorCode | string; readonly message?: string }
  | { readonly type: 'cancelled' }
  | { readonly type: 'accept' }
  | { readonly type: 'stale' }
  | { readonly type: 'applied' }
  | { readonly type: 'save-failed'; readonly code: string };

export function inlineEditReducer(state: InlineEditState, action: InlineEditAction): InlineEditState {
  switch (action.type) {
    case 'reset':
      return action.state;
    case 'instruction':
      return state.phase === 'instruction' ? { ...state, instruction: action.text } : state;
    case 'consented':
      return state.phase === 'consent' ? { ...state, phase: 'instruction' } : state;
    case 'send':
      // A new request from the instruction box, or "try again" after an error, a stop or a stale answer.
      if (!['instruction', 'error', 'cancelled', 'stale', 'no-change'].includes(state.phase)) return state;
      if (!state.instruction.trim()) return state;
      return { ...state, phase: 'running', requestId: null, proposal: null, error: null, saveError: null };
    case 'started':
      return state.phase === 'running' ? { ...state, requestId: action.requestId } : state;
    case 'answer': {
      if (state.phase !== 'running') return state;
      const proposal = normalizeProposal(action.original, action.text, action.eol);
      if (!proposal.trim() && action.original.trim()) {
        return { ...state, phase: 'error', error: { code: 'empty-answer' }, requestId: null };
      }
      return sameRangeText(proposal, action.original)
        ? { ...state, phase: 'no-change', proposal, requestId: null }
        : { ...state, phase: 'review', proposal, requestId: null };
    }
    case 'failed':
      if (state.phase !== 'running' && state.phase !== 'instruction') return state;
      return {
        ...state,
        phase: 'error',
        requestId: null,
        error: { code: action.code, ...(action.message ? { message: action.message } : {}) },
      };
    case 'cancelled':
      return state.phase === 'running' ? { ...state, phase: 'cancelled', requestId: null } : state;
    case 'accept':
      return state.phase === 'review' ? { ...state, phase: 'applying' } : state;
    case 'stale':
      return state.phase === 'applying' || state.phase === 'review' ? { ...state, phase: 'stale' } : state;
    case 'applied':
      return state.phase === 'applying' ? { ...state, phase: 'applied' } : state;
    case 'save-failed':
      return state.phase === 'applying' ? { ...state, phase: 'save-failed', saveError: action.code } : state;
  }
}

/** Error codes whose explanation offers Settings → AI. */
export const SETTINGS_ERRORS: ReadonlySet<string> = new Set(['disabled', 'no-key', 'unauthorized']);
