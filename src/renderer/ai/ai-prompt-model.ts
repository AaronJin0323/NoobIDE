/**
 * S42.2 inline `/ai` prompts (decision 0031): the pure rules, unit-tested in ai-prompt-model.test.ts.
 *
 * - A prompt is a line of an HTML, CSS or JavaScript file that is `/ai`, after optional leading spaces/tabs, followed
 *   by a space, tab or full-width space (U+3000) and the request. A bare `/ai` is recognised (for a hint) but has no
 *   request to run. `/aim`, `x /ai y`, `// /ai …` are not prompts.
 * - Plain Enter runs a prompt only on an armed line (one the user changed in this editor, decided by the Monaco
 *   glue), with the cursor at the end of it; Ctrl/Cmd+Enter and the context menu run any prompt line.
 * - The request is an `edit` request in generate mode: the prompt, the file's code around the prompt line (more of it
 *   than Ctrl/Cmd+I sends) and the file's problems nearest to the line.
 */
import type { AiEditProblem } from '../../shared/ipc/ai-contract';
import type { ProblemRecord, ProblemSeverity } from '../../shared/problem';
import { editContext, type EditRequest } from './inline-edit-model';

export const AI_PROMPT_LANGUAGES: ReadonlySet<string> = new Set(['html', 'css', 'javascript']);

/** Marker owner and problem code of a pending prompt line (the warning in the editor and in Problems). */
export const AI_PROMPT_MARKER_OWNER = 'noobide-ai-prompt';
export const AI_PROMPT_PENDING_CODE = 'ai-prompt-pending';

/** Code sent on each side of the prompt line: a whole beginner file, usually. */
export const GENERATE_CONTEXT_LINES = 200;
export const GENERATE_CONTEXT_CHARS = 12_000;
/** Problems sent with a prompt, and the size of each message. */
export const PROMPT_PROBLEMS_MAX = 8;
export const PROMPT_PROBLEM_CHARS = 500;
const CODE_CHARS = 200;

const PROMPT_LINE = /^([ \t]*)\/ai(?:[ \t\u3000]+(.*?))?[ \t\u3000]*$/;

export interface PromptLine {
  /** The line's leading spaces/tabs (the generated code is indented like the prompt). */
  readonly indent: string;
  /** The request, trimmed; '' for a bare `/ai`. */
  readonly prompt: string;
}

/** The prompt on a line of text, or null when the line is not an `/ai` line. */
export function parsePromptLine(text: string): PromptLine | null {
  const match = PROMPT_LINE.exec(text);
  if (!match) return null;
  return { indent: match[1] ?? '', prompt: (match[2] ?? '').trim() };
}

export const isPromptLanguage = (languageId: string): boolean => AI_PROMPT_LANGUAGES.has(languageId);

/** Lines (1-based) of every `/ai` line in a text. */
export function promptLinesOf(text: string): number[] {
  const out: number[] = [];
  text.split(/\r\n|\r|\n/).forEach((line, i) => {
    if (parsePromptLine(line)) out.push(i + 1);
  });
  return out;
}

/** The cursor is at the end of the line, trailing spaces aside (`column` is 1-based). */
export function atLineEnd(lineText: string, column: number): boolean {
  return column >= lineText.replace(/[ \t\u3000]+$/, '').length + 1;
}

/** One content change in the shape Monaco reports it (range start line, inserted text). */
export interface ChangeLike {
  readonly startLine: number;
  readonly text: string;
}

/** The lines (1-based, in the text after the change) that a change typed, pasted or replaced. */
export function linesTouched(change: ChangeLike): number[] {
  const breaks = change.text.split(/\r\n|\r|\n/).length - 1;
  return Array.from({ length: breaks + 1 }, (_, i) => change.startLine + i);
}

/** When plain Enter runs a prompt: an armed line with a request, the cursor at its end, nothing else going on. */
export function enterRuns(input: {
  readonly lineText: string;
  readonly column: number;
  readonly armed: boolean;
  /** One cursor, empty selection, no suggestion widget or inline suggestion shown, no IME composition open. */
  readonly quiet: boolean;
}): boolean {
  const line = parsePromptLine(input.lineText);
  return Boolean(line && line.prompt && input.armed && input.quiet && atLineEnd(input.lineText, input.column));
}

const SEVERITY_ORDER: Readonly<Record<ProblemSeverity, number>> = { error: 0, warning: 1, info: 2 };

/**
 * The file's problems to send with a prompt on `line`: problems of `relPath` that are not on an `/ai` line (the
 * prompt's own syntax error is noise), not stale, not NoobIDE's own prompt warning; errors first, then the nearest;
 * at most PROMPT_PROBLEMS_MAX, messages cut to PROMPT_PROBLEM_CHARS.
 */
export function promptProblems(
  records: readonly ProblemRecord[],
  relPath: string,
  line: number,
  promptLines: ReadonlySet<number>,
): AiEditProblem[] {
  const distance = (r: ProblemRecord) => (r.line === undefined ? Number.MAX_SAFE_INTEGER : Math.abs(r.line - line));
  return records
    .filter(
      (r) =>
        r.file === relPath &&
        !r.stale &&
        r.code !== AI_PROMPT_PENDING_CODE &&
        (r.line === undefined || !promptLines.has(r.line)),
    )
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || distance(a) - distance(b))
    .slice(0, PROMPT_PROBLEMS_MAX)
    .map((r) => ({
      ...(r.line !== undefined ? { line: r.line } : {}),
      severity: r.severity,
      source: r.source,
      code: r.code.slice(0, CODE_CHARS),
      message: r.originalMessage.slice(0, PROMPT_PROBLEM_CHARS),
    }));
}

export function buildGenerateRequest(input: {
  readonly projectId: string;
  readonly relPath: string;
  readonly languageId: string;
  readonly prompt: string;
  readonly fullText: string;
  /** The prompt line (1-based). */
  readonly line: number;
  readonly problems: readonly AiEditProblem[];
  readonly locale: 'zh-CN' | 'en';
}): EditRequest {
  const { before, after } = editContext(
    input.fullText,
    { startLine: input.line, endLine: input.line },
    { lines: GENERATE_CONTEXT_LINES, chars: GENERATE_CONTEXT_CHARS },
  );
  return {
    kind: 'edit',
    projectId: input.projectId,
    relPath: input.relPath,
    languageId: input.languageId,
    instruction: input.prompt.trim(),
    selection: '',
    before,
    after,
    locale: input.locale,
    mode: 'generate',
    problems: input.problems,
  };
}

/**
 * The answer indented like the prompt line: when its first non-empty line starts at column 1 and the prompt was
 * indented, every non-empty line gets the prompt's indentation (an answer that is already indented is kept).
 */
export function fitIndent(answer: string, indent: string): string {
  if (!indent) return answer;
  const first = answer.split('\n').find((l) => l.trim() !== '');
  if (first === undefined || /^[ \t]/.test(first)) return answer;
  return answer
    .split('\n')
    .map((l) => (l.replace(/\r$/, '').trim() === '' ? l : indent + l))
    .join('\n');
}
