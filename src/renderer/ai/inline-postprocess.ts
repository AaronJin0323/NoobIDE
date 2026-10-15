/**
 * S32.1: turns the model's raw answer into the ghost text that is shown (and inserted on Tab). Pure; unit-tested in
 * inline-postprocess.test.ts. Models sometimes wrap code in Markdown fences, repeat the start of the current line, or
 * repeat what already follows the cursor (`</div>` twice); a beginner would accept that without noticing.
 */
export const INLINE_MAX_SUGGESTION_LINES = 16;
export const INLINE_MAX_SUGGESTION_CHARS = 2000;

const FENCE_OPEN = /^\s*(```|~~~)[\w+#.-]*[ \t]*\r?\n/;
const FENCE_CLOSE = /\r?\n?[ \t]*(```|~~~)\s*$/;

/** Removes one leading fence line (```html) and one trailing fence, as models add them out of chat habit. */
export function stripMarkdownFences(text: string): string {
  const open = FENCE_OPEN.exec(text);
  if (!open) return text.replace(FENCE_CLOSE, '');
  const body = text.slice(open[0].length);
  return body.replace(FENCE_CLOSE, '');
}

/** The model repeated the text of the current line before the cursor: keep only what comes after it. */
function dropRepeatedLineStart(completion: string, prefix: string): string {
  const lineStart = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (lineStart.trim().length === 0) return completion;
  return completion.startsWith(lineStart) ? completion.slice(lineStart.length) : completion;
}

/**
 * The end of the suggestion repeats the text that already follows the cursor: drop the repetition. Two shapes:
 * the suggestion ends with the start of the suffix (`color: red;}` before `}`), or its last line equals the next
 * non-empty line of the suffix (a closing tag the model wrote again).
 */
export function trimSuffixOverlap(completion: string, suffix: string): string {
  const max = Math.min(completion.length, suffix.length);
  for (let k = max; k > 0; k -= 1) {
    const head = suffix.slice(0, k);
    if (head.trim().length > 0 && completion.endsWith(head)) return completion.slice(0, completion.length - k);
  }
  const nextLine = suffix
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (nextLine === undefined) return completion;
  const lines = completion.split('\n');
  if (lines.length > 1 && lines[lines.length - 1]?.trim() === nextLine) {
    return lines.slice(0, -1).join('\n');
  }
  return completion;
}

/** At most `lines` lines and `chars` characters, cut at a line end where possible. */
export function capSuggestion(
  text: string,
  lines = INLINE_MAX_SUGGESTION_LINES,
  chars = INLINE_MAX_SUGGESTION_CHARS,
): string {
  let out = text.split('\n').slice(0, lines).join('\n');
  if (out.length > chars) {
    const cut = out.lastIndexOf('\n', chars);
    out = cut > 0 ? out.slice(0, cut) : out.slice(0, chars);
  }
  return out;
}

/**
 * The ghost text for a raw answer, or null when nothing useful is left. Line breaks come back as `\n`; the editor
 * converts them to the file's own line ending.
 */
export function postProcessSuggestion(raw: string, context: { prefix: string; suffix: string }): string | null {
  let text = raw.replace(/\r\n?/g, '\n');
  text = stripMarkdownFences(text);
  text = dropRepeatedLineStart(text, context.prefix);
  text = capSuggestion(text);
  text = trimSuffixOverlap(text, context.suffix);
  text = text.replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
  return text.trim().length === 0 ? null : text;
}

/**
 * Monaco shows a multi-line ghost text only when nothing follows the cursor on its line. When something does (the
 * cursor is before `</p>`), only the suggestion's first line is offered, so the text after the cursor stays as it is.
 */
export function fitToLine(suggestion: string, restOfLine: string): string | null {
  if (restOfLine.length === 0 || !suggestion.includes('\n')) return suggestion;
  const first = suggestion.slice(0, suggestion.indexOf('\n')).replace(/[ \t]+$/, '');
  return first.trim().length === 0 ? null : first;
}
