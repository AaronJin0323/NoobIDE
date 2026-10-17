/**
 * S48.4: the composer's trigger grammar. Typing `/` opens the command list and `@` the project's file list, but only
 * where a word starts (at the start of the text or after whitespace), so `a/b`, `http://` and `me@example.com` never
 * open anything. Pure: the panel hands in the text and the caret and gets back what to show and what to replace.
 */

/** A mention (the text after `@` or `/`) longer than this is ordinary text, not a trigger. */
export const MAX_MENTION = 256;
/** Project paths longer than this are never offered or accepted. */
export const MAX_PATH = 1024;

export type TriggerKind = 'command' | 'file';

export interface Trigger {
  readonly kind: TriggerKind;
  /** Index of the `/` or `@`. */
  readonly start: number;
  /** End of the word the caret is in (the whole word is replaced on accept). */
  readonly end: number;
  /** What to match: the word after the sigil, cleaned (see {@link cleanMention}). */
  readonly query: string;
}

const SIGILS: Readonly<Record<string, TriggerKind>> = { '/': 'command', '@': 'file' };

/** Latin and CJK punctuation people type right after a name ("看看 @index.html，好吗"), never part of it. */
const TRAILING_PUNCTUATION = /[.,;:!?'"`)\]}>。，、；：！？）】」』》〉…～·]+$/u;

/** Trailing punctuation stripped and backslashes (Windows paths) turned into `/`. */
export function cleanMention(raw: string): string {
  return raw.replace(/\\/g, '/').replace(TRAILING_PUNCTUATION, '');
}

/** The trigger the caret is in, or null. `caret` is a UTF-16 index into `text` (a textarea's selectionStart). */
export function findTrigger(text: string, caret: number): Trigger | null {
  const at = Math.max(0, Math.min(caret, text.length));
  let start = at;
  while (start > 0 && !/\s/u.test(text[start - 1] as string)) start -= 1;
  const kind = SIGILS[text[start] ?? ''];
  if (!kind || start === at) return null;
  let end = at;
  while (end < text.length && !/\s/u.test(text[end] as string)) end += 1;
  const word = text.slice(start + 1, at);
  if (word.length > MAX_MENTION) return null;
  return { kind, start, end, query: cleanMention(word) };
}

/** A project path the file list may offer and accept. */
export function acceptablePath(relPath: string): boolean {
  return relPath.length > 0 && relPath.length <= MAX_PATH;
}

/** The text with the trigger's word replaced, and where the caret goes. */
export function replaceTrigger(text: string, trigger: Trigger, replacement: string): { text: string; caret: number } {
  const before = text.slice(0, trigger.start);
  let after = text.slice(trigger.end);
  // Removing the word entirely must not leave two spaces behind.
  if (replacement === '' && /\s$/u.test(before) && /^\s/u.test(after)) after = after.slice(1);
  if (replacement !== '' && !/^\s/u.test(after)) replacement += ' ';
  return { text: before + replacement + after, caret: before.length + replacement.length };
}
