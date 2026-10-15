/**
 * S32.1 ghost-text completions: what may be sent and when (decision 0025, docs/product/ai-plan.md). Pure: no Monaco,
 * no DOM, no bridge — unit-tested in inline-context.test.ts.
 *
 * Limits (characters = UTF-16 code units, like Monaco offsets):
 * - Prefix 4 000 / suffix 1 000. About 1 000 + 250 tokens: enough for the enclosing HTML element, CSS rule or JS
 *   function of a beginner's file, small enough that the fast inline model answers in well under a second and a
 *   suggestion costs a fraction of a cent. The suffix is shorter because it is only needed to close what the prefix
 *   opened (and to avoid repeating text that already follows the cursor).
 * - Files over 200 000 characters get no suggestions: they are generated, minified or vendored (a library copied in),
 *   where a suggestion is useless and every request would send a large excerpt.
 */
import type { AiStatus } from '../../shared/ipc/ai-contract';

export const INLINE_MAX_PREFIX_CHARS = 4000;
export const INLINE_MAX_SUFFIX_CHARS = 1000;
export const INLINE_MAX_FILE_CHARS = 200_000;
/** Wait after the last keystroke or cursor move before asking (one request per pause, not per key). */
export const INLINE_DEBOUNCE_MS = 300;
/** A suggestion that has not finished by then is cancelled: a late ghost text would interrupt the typing. */
export const INLINE_TIMEOUT_MS = 10_000;
/** Languages NoobIDE suggests for (Monaco language ids). */
export const INLINE_LANGUAGES: readonly string[] = ['html', 'css', 'javascript'];

/** Why no request is made. `null` from the gate functions means "allowed". */
export type InlineBlockReason =
  | 'no-bridge'
  | 'ai-off'
  | 'inline-off'
  | 'no-key'
  | 'no-consent'
  /** S39.2: today's token budget is used up: suggestions pause (the status line says so). */
  | 'budget-reached'
  | 'no-project'
  | 'read-only'
  | 'encoding'
  | 'language'
  | 'too-large'
  | 'multiple-cursors'
  | 'selection'
  | 'mid-word';

/** The AI side: AI on, inline on, a key for the chosen provider, and this project allowed to send code. */
export function statusBlockReason(status: AiStatus | null): InlineBlockReason | null {
  if (!status) return 'no-bridge';
  const { config } = status;
  if (!config.enabled) return 'ai-off';
  if (!config.inlineCompletions) return 'inline-off';
  if (config.provider === null || !status.keyStored[config.provider]) return 'no-key';
  if (!status.projectConsent) return 'no-consent';
  if (status.budgetReached === true) return 'budget-reached';
  return null;
}

/** The file on screen, as the workbench describes it. */
export interface InlineTarget {
  readonly projectId: string;
  readonly relPath: string;
  /** Non-UTF-8 files (S07.4) and files being moved are read-only. */
  readonly readOnly: boolean;
  /** Present for a non-UTF-8 file. */
  readonly encoding?: string | undefined;
}

export interface EditorFacts {
  /** null for the welcome sample (no project). */
  readonly target: InlineTarget | null;
  readonly languageId: string;
  readonly fileLength: number;
  readonly cursorCount: number;
  /** The primary selection is not empty. */
  readonly hasSelection: boolean;
  /** The character right after the cursor, '' at the end of a line or file. */
  readonly charAfterCursor: string;
}

/** The editor side: a real, editable UTF-8 HTML/CSS/JS file of reasonable size, one empty cursor not inside a word. */
export function editorBlockReason(facts: EditorFacts): InlineBlockReason | null {
  const { target } = facts;
  if (!target) return 'no-project';
  if (target.encoding !== undefined) return 'encoding';
  if (target.readOnly) return 'read-only';
  if (!INLINE_LANGUAGES.includes(facts.languageId)) return 'language';
  if (facts.fileLength > INLINE_MAX_FILE_CHARS) return 'too-large';
  if (facts.cursorCount !== 1) return 'multiple-cursors';
  if (facts.hasSelection) return 'selection';
  // Typing in the middle of a word ("col|or") is not a place to suggest; the rest of the word is already there.
  if (/^[\p{L}\p{N}_$]$/u.test(facts.charAfterCursor)) return 'mid-word';
  return null;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Text before / after `offset`, bounded. The prefix starts at a line start when the cut falls inside a line (a
 * half line confuses the model more than a missing one); the suffix ends at a line end for the same reason. A single
 * line longer than the limit is cut by characters. A cut never splits a surrogate pair (CJK extension characters,
 * emoji).
 */
export function boundedContext(
  text: string,
  offset: number,
  limits: { readonly prefix: number; readonly suffix: number } = {
    prefix: INLINE_MAX_PREFIX_CHARS,
    suffix: INLINE_MAX_SUFFIX_CHARS,
  },
): { readonly prefix: string; readonly suffix: string } {
  const at = Math.max(0, Math.min(offset, text.length));
  let start = Math.max(0, at - limits.prefix);
  if (start > 0 && text[start - 1] !== '\n') {
    const nextLine = text.indexOf('\n', start);
    if (nextLine !== -1 && nextLine < at) start = nextLine + 1;
  }
  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start))) start += 1;
  let end = Math.min(text.length, at + limits.suffix);
  if (end < text.length && text[end] !== '\n') {
    const lineEnd = text.lastIndexOf('\n', end - 1);
    if (lineEnd >= at) end = lineEnd + 1;
  }
  if (end > at && end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return { prefix: text.slice(start, at), suffix: text.slice(at, end) };
}
