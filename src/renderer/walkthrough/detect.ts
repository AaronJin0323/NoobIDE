/**
 * Completion detection for the walkthrough steps and the final task (S23.2, S23.3). Pure functions over file texts
 * and problem records, so every rule is unit-tested; the hook calls them with what is on disk after a confirmed save.
 *
 * A step that changes a file compares a short "signature" of the file when the step began (its baseline, kept in the
 * walkthrough state) with the signature after each save: the heading text, the colour / font declarations, the
 * string literals of the script. Signatures are summaries, never whole files, and contain no paths.
 */
import type { ProblemRecord } from '../../shared/problem';
import { MAX_BASELINE_LENGTH, type WalkthroughStepId } from '../../shared/walkthrough';

const cap = (text: string) => text.slice(0, MAX_BASELINE_LENGTH);
const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The text of the first <h1> element (tags removed, whitespace collapsed), or '' when there is none. */
export function headingText(html: string): string {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const match = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(withoutComments);
  return match ? collapse((match[1] ?? '').replace(/<[^>]*>/g, ' ')) : '';
}

/** Number of <p> elements (opening tags) outside comments. */
export function paragraphCount(html: string): number {
  return (html.replace(/<!--[\s\S]*?-->/g, '').match(/<p(?=[\s>/])/gi) ?? []).length;
}

const STYLE_PROPERTIES = /^(color|background|background-color|font-size|font-family|font-weight)$/i;
const COLOR_PROPERTIES = /^(color|background|background-color)$/i;

/** `selector{property:value}` for every declaration whose property matches, in source order. */
export function declarations(css: string, property: RegExp): string[] {
  const out: string[] = [];
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /([^{}]*)\{([^{}]*)\}/g;
  for (let match = rule.exec(source); match; match = rule.exec(source)) {
    const selector = collapse(match[1] ?? '');
    for (const declaration of (match[2] ?? '').split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      const name = declaration.slice(0, colon).trim();
      const value = collapse(declaration.slice(colon + 1)).toLowerCase();
      if (property.test(name) && value) out.push(`${selector}{${name.toLowerCase()}:${value}}`);
    }
  }
  return out;
}

/** Contents of the string literals ('…', "…", `…`) outside comments. */
export function stringLiterals(js: string): string[] {
  const out: string[] = [];
  const token = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`/g;
  for (let match = token.exec(js); match; match = token.exec(js)) {
    const text = match[0];
    if (text.startsWith('//') || text.startsWith('/*')) continue;
    out.push(text.slice(1, -1));
  }
  return out;
}

/** The file each file-changing step watches, and the signature it compares. */
export const STEP_FILES: Partial<Record<WalkthroughStepId, { file: string; signature(text: string): string }>> = {
  heading: { file: 'index.html', signature: (text) => cap(headingText(text)) },
  style: { file: 'style.css', signature: (text) => cap(JSON.stringify(declarations(text, STYLE_PROPERTIES))) },
  interaction: { file: 'script.js', signature: (text) => cap(JSON.stringify(stringLiterals(text))) },
};

/**
 * A file-changing step is done when the saved file's signature differs from the baseline; the heading must also not
 * be empty, and the script must have no error in the static problems (a change that broke the script is not done).
 */
export function fileStepDone(
  step: WalkthroughStepId,
  baseline: string,
  current: string,
  problems: readonly ProblemRecord[] = [],
): boolean {
  if (current === baseline) return false;
  if (step === 'heading') return current !== '';
  if (step === 'interaction') return !problems.some((p) => p.file === 'script.js' && p.severity === 'error');
  return true;
}

/** TypeScript's "Cannot find name" / "Did you mean" codes, as the static problems report them (S19.1). */
const UNDEFINED_NAME_CODES = new Set(['2304', '2552']);

/** The deliberate-error step: a problem for a misspelled (undefined) name in a JavaScript file is reported. */
export function misspelledNameReported(problems: readonly ProblemRecord[]): boolean {
  return problems.some(
    (p) =>
      p.severity === 'error' &&
      typeof p.file === 'string' &&
      /\.m?js$/i.test(p.file) &&
      (UNDEFINED_NAME_CODES.has(p.code) || /\bis not defined\b/.test(p.originalMessage)),
  );
}

/** The role files the "meet the files" step opens. */
export const ROLE_FILES = ['index.html', 'style.css', 'script.js'] as const;

export function roleFilesOpened(openTabs: readonly string[]): boolean {
  return ROLE_FILES.every((file) => openTabs.includes(file));
}

// ── S23.3 final task: add a paragraph to index.html and give text a colour of your own in style.css ──
export const TASK_FILES = ['index.html', 'style.css'] as const;

interface TaskSignature {
  readonly paragraphs: number;
  readonly colors: readonly string[];
}

export function taskSignature(html: string, css: string): string {
  const signature: TaskSignature = { paragraphs: paragraphCount(html), colors: declarations(css, COLOR_PROPERTIES) };
  return cap(JSON.stringify(signature));
}

function parseTask(signature: string): TaskSignature | null {
  try {
    const value = JSON.parse(signature) as Partial<TaskSignature>;
    return typeof value.paragraphs === 'number' && Array.isArray(value.colors)
      ? { paragraphs: value.paragraphs, colors: value.colors.map(String) }
      : null;
  } catch {
    return null;
  }
}

/** Done when the page has more paragraphs than at the start and a colour declaration was added or changed. */
export function taskDone(baseline: string, current: string): boolean {
  const before = parseTask(baseline);
  const after = parseTask(current);
  if (!before || !after) return false;
  const newColor = after.colors.some((decl) => !before.colors.includes(decl));
  return after.paragraphs > before.paragraphs && newColor;
}
