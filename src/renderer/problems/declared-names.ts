/**
 * Names declared in scope at a problem's location, from the JavaScript language service (S22.4/S22.5): the input of the
 * did-you-mean rule (src/diagnostics/rules/undefined-name.ts). Monaco-free, so the filtering is unit-tested; the
 * worker calls live in rule-context-monaco.ts.
 *
 * - Completions at the location list every name in scope. Only the program's own declarations count: names from the
 *   built-in libraries (`kindModifiers` contains `declare`: window, document, name…) and the plain words TypeScript
 *   offers in JavaScript files (`kind` 'warning', which includes the misspelled name itself) are left out.
 * - The declaration line is taken from the file's navigation tree, and only when the name is declared exactly once in
 *   that file (otherwise "line 9" could point at the wrong declaration).
 */
import type { DeclaredName } from '../../diagnostics/rules';

/** TypeScript ScriptElementKind values of declarations a beginner writes. */
const DECLARATION_KINDS = new Set([
  'var',
  'let',
  'const',
  'local var',
  'local let',
  'local const',
  'function',
  'local function',
  'class',
  'local class',
  'parameter',
  'alias',
]);

export interface CompletionEntryLike {
  readonly name: string;
  readonly kind: string;
  readonly kindModifiers?: string;
}

export interface NavigationItemLike {
  readonly text: string;
  readonly kind: string;
  readonly spans?: readonly { readonly start: number; readonly length: number }[];
  readonly childItems?: readonly NavigationItemLike[];
}

const isLibrary = (entry: CompletionEntryLike) => (entry.kindModifiers ?? '').split(',').includes('declare');

/** The program's own declarations among the completion entries, in their order, without duplicates. */
export function declaredFromCompletions(entries: readonly CompletionEntryLike[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (!DECLARATION_KINDS.has(entry.kind) || isLibrary(entry) || out.includes(entry.name)) continue;
    out.push(entry.name);
  }
  return out;
}

/** Offset of the only declaration of `name` in the navigation tree, or undefined (none, or several). */
export function soleDeclarationOffset(tree: NavigationItemLike | undefined, name: string): number | undefined {
  const found: number[] = [];
  const visit = (item: NavigationItemLike, root: boolean) => {
    const start = item.spans?.[0]?.start;
    if (!root && item.text === name && DECLARATION_KINDS.has(item.kind) && start !== undefined) found.push(start);
    for (const child of item.childItems ?? []) visit(child, false);
  };
  if (tree) visit(tree, true);
  return found.length === 1 ? found[0] : undefined;
}

/** Builds the rule's DeclaredName list; `lineOf` gives the 1-based declaration line of a name in `file`, if known. */
export function toDeclaredNames(
  names: readonly string[],
  file: string,
  lineOf: (name: string) => number | undefined,
): DeclaredName[] {
  return names.map((name) => {
    const line = lineOf(name);
    return line === undefined ? { name } : { name, file, line };
  });
}
