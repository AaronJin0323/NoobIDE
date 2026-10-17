/**
 * JavaScript navigation (S57): go to definition, find references and rename across the project's scripts, limited
 * to what the JavaScript language service proves (docs/capabilities.md). Pure: the service's answers (file name +
 * text span) come in, project locations and a checked rename plan go out. js-navigation-monaco.ts asks the service.
 *
 * Only project `.js` / `.mjs` files take part. A place in a built-in library (`console`, the DOM) has no project file
 * and is not offered; an HTML page's inline `<script>` is not supported at all (the service never sees it).
 */

export interface ServiceSpan {
  /** The language service's file name: an editor model's URI or an extra lib's name. */
  readonly fileName: string;
  readonly textSpan: { readonly start: number; readonly length: number };
  /** rename: text to keep around the new name (`{ greet }` → `{ greet: hello }`). */
  readonly prefixText?: string;
  readonly suffixText?: string;
}

export interface NavLocation {
  readonly relPath: string;
  readonly fileName: string;
  /** 1-based. */
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  /** The whole line, for the list (in memory only; never logged). */
  readonly lineText: string;
}

export interface NavigationPaths {
  /** The project file of a service file name, or null when it is not a project script. */
  relPathOf(fileName: string): string | null;
  /** The text the service holds for a file name (open model or extra lib), or null. */
  textOf(fileName: string): string | null;
  /** Whether every project script is known to the service (none left out by the limits). */
  complete(): boolean;
}

/** 1-based line / column of an offset. */
export function positionAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function lineAt(text: string, line: number): string {
  return (text.split('\n')[line - 1] ?? '').replace(/\r$/, '');
}

/** Project locations of the service's spans, in file then text order; places outside the project are dropped. */
export function toLocations(spans: readonly ServiceSpan[], paths: NavigationPaths): NavLocation[] {
  const out: NavLocation[] = [];
  const seen = new Set<string>();
  for (const span of spans) {
    const relPath = paths.relPathOf(span.fileName);
    const text = relPath === null ? null : paths.textOf(span.fileName);
    if (relPath === null || text === null) continue;
    const key = `${span.fileName}|${span.textSpan.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const start = positionAt(text, span.textSpan.start);
    const end = positionAt(text, span.textSpan.start + span.textSpan.length);
    out.push({
      relPath,
      fileName: span.fileName,
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
      lineText: lineAt(text, start.line),
    });
  }
  return out.sort((a, b) =>
    a.relPath === b.relPath ? a.line - b.line || a.column - b.column : a.relPath < b.relPath ? -1 : 1,
  );
}

// ── rename (S57.2) ──────────────────────────────────────────────────────────────────────────────────────────────

const RESERVED = new Set(
  (
    'break case catch class const continue debugger default delete do else enum export extends false finally for ' +
    'function if import in instanceof new null return super switch this throw true try typeof var void while with ' +
    'yield let static implements interface package private protected public await arguments eval undefined NaN Infinity'
  ).split(' '),
);

/** A name the new identifier may have: a plain JavaScript identifier that is not a reserved word. */
export function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_$À-￿][\w$À-￿]*$/.test(name) && !RESERVED.has(name);
}

export type RenameRefusal =
  /** The cursor is not on a name in a project script (an HTML page's inline <script> included). */
  | 'not-a-script'
  /** The service says this cannot be renamed (a keyword, a string, nothing under the cursor). */
  | 'not-renamable'
  /** The name belongs to the browser or a library (`console`, `document`), not to the project. */
  | 'built-in'
  /** Some of the project's scripts are not known to the service (limits), so some uses could be missed. */
  | 'incomplete-project'
  /** The name is also written in an HTML page (inline script, `onclick="…"`), which the service does not see. */
  | 'used-in-html'
  /** A use is in a file NoobIDE cannot change safely (not a project script, or its text is unknown). */
  | 'unknown-file'
  /** S57.2: a property or method: untyped JavaScript links its uses only by guess (`p.count`, `obj[key]`). */
  | 'property'
  /** The new name is already used in a project script or by the browser: renaming could change what code means. */
  | 'name-taken'
  /** An HTML page could not be read, so a use there cannot be ruled out. */
  | 'pages-unknown'
  | 'invalid-name'
  | 'same-name';

export interface FileEdit {
  readonly relPath: string;
  readonly fileName: string;
  /** The file's text the plan is based on, and the text after the rename. */
  readonly before: string;
  readonly after: string;
  /** Changed lines for the preview: 1-based line, its text before and after. */
  readonly lines: readonly { readonly line: number; readonly before: string; readonly after: string }[];
  readonly count: number;
}

export type RenamePlan =
  | { readonly ok: true; readonly oldName: string; readonly newName: string; readonly files: readonly FileEdit[] }
  | { readonly ok: false; readonly reason: RenameRefusal; readonly detail?: string };

export interface RenameInput {
  /** The service's rename info for the place under the cursor. */
  readonly info: { readonly canRename: boolean; readonly displayName?: string; readonly kind?: string };
  /** Every place the service would change (findRenameLocations). */
  readonly locations: readonly ServiceSpan[];
  readonly newName: string;
  readonly paths: NavigationPaths;
  /** The project's HTML pages (relative path → text), searched for the old name. */
  readonly htmlPages: readonly { readonly relPath: string; readonly text: string }[];
  /** Where `name` is already used — a project file, or `browser` for a name of the page's window — or null. */
  readonly nameInUse?: (name: string) => string | null;
}

/** Kinds of the language service a rename is certain for (TypeScript's ScriptElementKind). */
const RENAMABLE_KINDS = new Set([
  'function',
  'local function',
  'var',
  'local var',
  'let',
  'const',
  'parameter',
  'class',
  'local class',
  'alias',
]);
/** Kinds whose name is local to a function or a module: an HTML page cannot refer to them. */
const LOCAL_KINDS = new Set(['local function', 'local var', 'parameter', 'local class', 'alias']);

/** The parts of an HTML page that are JavaScript: inline `<script>` bodies and `on…="…"` attribute values. */
export function htmlScriptParts(html: string): string {
  const parts: string[] = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script\s*>/gi)) parts.push(m[1] ?? '');
  for (const m of html.matchAll(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi)) parts.push(m[1] ?? '');
  return parts.join('\n');
}

/** `name` as a whole JavaScript word in `text`. */
export function hasWord(text: string, name: string): boolean {
  const escaped = name.replace(/[$]/g, '\\$');
  return new RegExp(`(^|[^\\w$])${escaped}(?![\\w$])`).test(text);
}

/**
 * Checks a rename and computes every file's new text, or says why it is refused. Refuses whenever the service
 * cannot be certain it found every use: a name of the browser, scripts it does not see, uses in HTML pages.
 */
export function planRename(input: RenameInput): RenamePlan {
  const { info, locations, newName, paths } = input;
  if (!info.canRename || locations.length === 0) return { ok: false, reason: 'not-renamable' };
  const first = locations[0] as ServiceSpan;
  const firstText = paths.textOf(first.fileName);
  // The service's own name for the symbol; every span must say exactly that.
  const oldName =
    info.displayName ?? firstText?.slice(first.textSpan.start, first.textSpan.start + first.textSpan.length) ?? '';
  if (!isValidIdentifier(newName)) return { ok: false, reason: 'invalid-name', detail: newName };
  if (newName === oldName) return { ok: false, reason: 'same-name' };
  if (!paths.complete()) return { ok: false, reason: 'incomplete-project' };
  if (info.kind !== undefined && !RENAMABLE_KINDS.has(info.kind)) return { ok: false, reason: 'property' };
  const taken = input.nameInUse?.(newName) ?? null;
  if (taken !== null) return { ok: false, reason: 'name-taken', detail: taken };
  const byFile = new Map<string, ServiceSpan[]>();
  for (const span of locations) {
    if (/\.d\.ts$/.test(span.fileName) || !/^file:/i.test(span.fileName)) return { ok: false, reason: 'built-in' };
    if (paths.relPathOf(span.fileName) === null || paths.textOf(span.fileName) === null) {
      return { ok: false, reason: 'unknown-file', detail: span.fileName };
    }
    byFile.set(span.fileName, [...(byFile.get(span.fileName) ?? []), span]);
  }
  // A global (top-level name of a classic script) can be used by a page's inline script or onclick="…".
  if (info.kind === undefined || !LOCAL_KINDS.has(info.kind)) {
    const pages = input.htmlPages.filter((page) => hasWord(htmlScriptParts(page.text), oldName));
    if (pages.length > 0) return { ok: false, reason: 'used-in-html', detail: pages.map((p) => p.relPath).join(', ') };
  }

  const files: FileEdit[] = [];
  for (const [fileName, spans] of byFile) {
    const before = paths.textOf(fileName) as string;
    const relPath = paths.relPathOf(fileName) as string;
    let after = before;
    // From the end, so earlier offsets stay valid.
    for (const span of [...spans].sort((a, b) => b.textSpan.start - a.textSpan.start)) {
      const { start, length } = span.textSpan;
      if (before.slice(start, start + length) !== oldName && !span.prefixText && !span.suffixText) {
        return { ok: false, reason: 'not-renamable' }; // the service and the text disagree: do nothing
      }
      after = `${after.slice(0, start)}${span.prefixText ?? ''}${newName}${span.suffixText ?? ''}${after.slice(start + length)}`;
    }
    const oldLines = before.split('\n');
    const newLines = after.split('\n');
    const lines = [];
    for (let i = 0; i < oldLines.length; i += 1) {
      if (oldLines[i] !== newLines[i]) {
        lines.push({
          line: i + 1,
          before: (oldLines[i] ?? '').replace(/\r$/, ''),
          after: (newLines[i] ?? '').replace(/\r$/, ''),
        });
      }
    }
    files.push({ relPath, fileName, before, after, lines, count: spans.length });
  }
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { ok: true, oldName, newName, files };
}
