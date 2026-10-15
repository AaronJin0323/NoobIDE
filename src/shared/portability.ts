import { checkFileName, type FileNameProblem } from './file-names';

/**
 * S13.5 cross-platform project transfer (PLAN §7: "explicitly report names that cannot be represented on the target
 * system and any case conflicts; do not silently rename files"). Pure: main feeds it the names it read from disk,
 * tests feed it listings no single file system can hold (e.g. `Logo.png` next to `logo.png` on a case-insensitive
 * Mac volume). Nothing here renames, normalises or rewrites anything — it only describes what it sees.
 */
export type PortabilityIssue =
  /** Names in one folder that differ only by letter case: one file on Windows and on a default macOS volume. */
  | { readonly kind: 'case-conflict'; readonly folder: string; readonly names: readonly string[] }
  /**
   * Names in one folder that look the same but use different Unicode forms (NFC `é` vs NFD `e` + accent): macOS
   * treats them as one name, Windows and Linux as two.
   */
  | { readonly kind: 'unicode-conflict'; readonly folder: string; readonly names: readonly string[] }
  /**
   * A name stored in decomposed Unicode form (typical for files copied from older Macs). A link typed on Windows
   * uses the composed form and does not find the file there.
   */
  | { readonly kind: 'decomposed-name'; readonly relPath: string }
  /** A name Windows or macOS cannot represent (`:`, `?`, trailing dot, `CON`…; src/shared/file-names). */
  | {
      readonly kind: 'unportable-name';
      readonly relPath: string;
      readonly problems: readonly FileNameProblem[];
      readonly invalidChars: readonly string[];
    }
  /**
   * A text file with both CRLF and LF line breaks. Opening it changes nothing; saving after an edit unifies the line
   * breaks (docs/decisions/0011). Reported so the user is not surprised by a whole-file change.
   */
  | { readonly kind: 'mixed-eol'; readonly relPath: string };

export type PortabilityIssueKind = PortabilityIssue['kind'];

export interface PortabilityReport {
  readonly issues: readonly PortabilityIssue[];
  /** The scan stopped at its limits (very large project, unreadable folders): there may be more issues. */
  readonly truncated: boolean;
}

/** Problems that matter when a project moves to another system (dotfiles are not part of the listed project). */
const TRANSFER_PROBLEMS: ReadonlySet<FileNameProblem> = new Set<FileNameProblem>([
  'invalid-char',
  'control-char',
  'reserved-windows',
  'trailing-dot-or-space',
  'too-long',
]);

const join = (folder: string, name: string) => (folder === '' ? name : `${folder}/${name}`);

/**
 * Issues among the names of ONE folder (`folder` is its `/`-separated relative path, `''` for the project root).
 * The names are reported exactly as given.
 */
export function folderNameIssues(folder: string, names: readonly string[]): PortabilityIssue[] {
  const issues: PortabilityIssue[] = [];
  // Group names a case- and normalisation-insensitive file system would treat as one.
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const key = name.normalize('NFC').toLowerCase();
    const group = groups.get(key);
    if (group) group.push(name);
    else groups.set(key, [name]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const composed = new Set(group.map((n) => n.normalize('NFC')));
    issues.push({ kind: composed.size === 1 ? 'unicode-conflict' : 'case-conflict', folder, names: [...group] });
  }
  for (const name of names) {
    const relPath = join(folder, name);
    const check = checkFileName(name);
    const problems = check.problems.filter((p) => TRANSFER_PROBLEMS.has(p));
    if (problems.length > 0) {
      issues.push({ kind: 'unportable-name', relPath, problems, invalidChars: check.invalidChars });
    }
    if (name !== name.normalize('NFC')) issues.push({ kind: 'decomposed-name', relPath });
  }
  return issues;
}

/** Stable display order: name problems first (they block opening a file on the other system), then line endings. */
const ORDER: readonly PortabilityIssueKind[] = [
  'unportable-name',
  'case-conflict',
  'unicode-conflict',
  'decomposed-name',
  'mixed-eol',
];

export function sortIssues(issues: readonly PortabilityIssue[]): PortabilityIssue[] {
  const where = (i: PortabilityIssue) => ('relPath' in i ? i.relPath : i.folder);
  return [...issues].sort(
    (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || (where(a) < where(b) ? -1 : where(a) > where(b) ? 1 : 0),
  );
}
