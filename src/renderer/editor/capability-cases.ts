/**
 * The language capability suite's case format (S18.1, S18.2). Cases live in tests/fixtures/lang-capabilities/cases.json
 * and run inside the real app (capability-probe.ts). Pure, so the format and the docs ↔ suite link are unit-tested.
 */
export type CapabilityKind =
  | 'completion'
  | 'hover'
  | 'format'
  // S53: run an editor action (or Emmet's Tab) at the cursor / selection, then compare the whole document.
  | 'edit'
  // S53.3: the colour values that get a swatch.
  | 'colors'
  // S57: JavaScript navigation through NoobIDE's own commands (js-navigation.ts).
  | 'definition'
  | 'references'
  | 'rename';
export type CapabilityLanguage = 'html' | 'css' | 'javascript';

export interface CapabilityCase {
  readonly id: string;
  readonly language: CapabilityLanguage;
  readonly kind: CapabilityKind;
  /** Document text; one `|` marks the cursor (completion, hover); two mark a selection (edit). */
  readonly text: string;
  /**
   * completion: labels that must be offered; hover: strings the hover must contain; colors: the colour texts that get
   * a swatch, in document order; definition / references: `file:line:column` of every location found, in order, or
   * `unsupported` when the command does not apply there; rename: `refused` or `refused:<reason>` when the rename
   * must be refused.
   */
  readonly expect?: readonly string[];
  /** format / edit: the whole document afterwards. */
  readonly expectText?: string;
  /**
   * edit: what runs — `emmet` (Tab with Emmet on), `linked-type` (wait for linked tag editing, then type `typeText`),
   * or a Monaco / NoobIDE editor action id (e.g. `editor.action.commentLine`, `noobide.wrapWithTag`).
   */
  readonly action?: string;
  /** edit: text typed after the action (for `linked-type`, and the tag name for `noobide.wrapWithTag`). */
  readonly typeText?: string;
  /** rename: the new name. */
  readonly newName?: string;
  /** rename: every changed file's text afterwards (the case's own file under its file name). */
  readonly expectFiles?: Readonly<Record<string, string>>;
  /**
   * Project files that are not open in a tab: they reach the JavaScript service as extra libraries, the way the
   * workbench passes closed project scripts (project-scripts.ts). relative name → text.
   */
  readonly closedFiles?: Readonly<Record<string, string>>;
  /** Extra files loaded beside the case (multi-file cases): relative name → text. */
  readonly files?: Readonly<Record<string, string>>;
  /** The case's own file name (default `case.<ext>`); relative imports resolve against it. */
  readonly fileName?: string;
}

export interface CapabilityResult {
  readonly id: string;
  readonly pass: boolean;
  /** What was seen (labels / hover text, shortened) — for the failure message only. Never project code. */
  readonly seen?: string;
  readonly ms: number;
}

export const CURSOR = '|';

const KINDS: readonly string[] = [
  'completion',
  'hover',
  'format',
  'edit',
  'colors',
  'definition',
  'references',
  'rename',
];
/** Kinds whose `expect` may be empty (nothing found is the claim). */
const MAY_FIND_NOTHING: readonly string[] = ['definition', 'references', 'colors'];
const LANGUAGES: readonly string[] = ['html', 'css', 'javascript'];

export function extensionOf(language: CapabilityLanguage): string {
  return language === 'javascript' ? 'js' : language;
}

/** Splits the cursor marker out of a case's text: 1-based line/column of the cursor and the text without it. */
export function cursorOf(text: string): { text: string; line: number; column: number } {
  const at = text.indexOf(CURSOR);
  if (at < 0) return { text, line: 1, column: 1 };
  const before = text.slice(0, at);
  const lines = before.split('\n');
  return {
    text: before + text.slice(at + 1),
    line: lines.length,
    column: (lines[lines.length - 1]?.length ?? 0) + 1,
  };
}

/**
 * Splits two `|` markers out of a case's text: the selection from the first to the second (1-based). With one marker
 * the selection is empty at the cursor.
 */
export function selectionOf(text: string): {
  text: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
} {
  const first = cursorOf(text);
  if (!first.text.includes(CURSOR)) {
    const at = { line: first.line, column: first.column };
    return { text: first.text, start: at, end: at };
  }
  const second = cursorOf(first.text);
  return {
    text: second.text,
    start: { line: first.line, column: first.column },
    end: { line: second.line, column: second.column },
  };
}

/** Validates the parsed cases.json. Throws with the offending case id, so a broken fixture fails loudly. */
export function parseCases(json: unknown): CapabilityCase[] {
  const cases = (json as { cases?: unknown } | null)?.cases;
  if (!Array.isArray(cases)) throw new Error('cases.json: missing "cases" array');
  const seen = new Set<string>();
  return cases.map((raw: unknown, index) => {
    const c = raw as Partial<CapabilityCase> | null;
    const id = typeof c?.id === 'string' && c.id ? c.id : `#${index}`;
    const fail = (why: string): never => {
      throw new Error(`cases.json ${id}: ${why}`);
    };
    if (!c || typeof c.id !== 'string' || !/^[a-z0-9-]+$/.test(c.id)) fail('id must be kebab-case');
    if (seen.has(id)) fail('duplicate id');
    seen.add(id);
    if (!LANGUAGES.includes(c?.language as string)) fail('unknown language');
    if (!KINDS.includes(c?.kind as string)) fail('unknown kind');
    if (typeof c?.text !== 'string') fail('text must be a string');
    if (c?.kind === 'format') {
      if (typeof c.expectText !== 'string') fail('format cases need expectText');
    } else if (c?.kind === 'edit') {
      if (typeof c.expectText !== 'string') fail('edit cases need expectText');
      if (typeof c.action !== 'string' || !c.action) fail('edit cases need an action');
      if (!c.text?.includes(CURSOR)) fail('needs a | cursor marker');
    } else if (c?.kind === 'rename') {
      if (!c.text?.includes(CURSOR)) fail('needs a | cursor marker');
      if (typeof c.newName !== 'string' || !c.newName) fail('rename cases need newName');
      const refused =
        Array.isArray(c.expect) && c.expect.length === 1 && /^refused(?::[a-z-]+)?$/.test(c.expect[0] ?? '');
      if (!refused && (typeof c.expectFiles !== 'object' || c.expectFiles === null)) {
        fail('rename cases need expectFiles or expect ["refused"]');
      }
    } else if (MAY_FIND_NOTHING.includes(c?.kind as string)) {
      if (c?.kind !== 'colors' && !c?.text?.includes(CURSOR)) fail('needs a | cursor marker');
      if (!Array.isArray(c?.expect)) fail('needs an expect list');
    } else {
      if (!c?.text?.includes(CURSOR)) fail('needs a | cursor marker');
      if (!Array.isArray(c?.expect) || c.expect.length === 0) fail('needs a non-empty expect list');
    }
    return c as CapabilityCase;
  });
}

/** Case ids cited in docs/capabilities.md: `` `case-id` `` in the last cell of a table row. */
export function citedCaseIds(markdown: string): string[] {
  const ids: string[] = [];
  for (const line of markdown.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').filter((cell) => cell.trim() !== '');
    const last = cells[cells.length - 1] ?? '';
    for (const m of last.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g)) if (m[1]) ids.push(m[1]);
  }
  return ids;
}
