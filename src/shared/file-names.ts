/**
 * Cross-platform file name rules (S07.1, S08.2, PLAN §7). Pure: used by the renderer for immediate feedback and by
 * main, which enforces them again before touching the disk.
 *
 * A project must keep working when it moves between Windows and macOS, so a name is checked against the rules of
 * BOTH systems on every platform: a name that only a Mac accepts is still explained on a Mac, never silently changed.
 */
export type FileNameProblem =
  | 'empty'
  /** `.` or `..` — they name the current or parent folder. */
  | 'dot-name'
  /** One of `< > : " / \ | ? *` — not allowed on Windows (`/` and `:` not on macOS either). */
  | 'invalid-char'
  /** Characters below U+0020 (tab, line breaks…). */
  | 'control-char'
  /** CON, PRN, AUX, NUL, COM0–9, LPT0–9 (with any extension) are device names on Windows. */
  | 'reserved-windows'
  /** Windows silently drops a trailing dot or space, so `a.` and `a` would become the same file. */
  | 'trailing-dot-or-space'
  /** Names starting with `.` are hidden by the OS, the file tree and the preview server. */
  | 'starts-with-dot'
  /** More than 255 bytes in UTF-8 (the macOS limit; stricter than Windows' 255 UTF-16 units). */
  | 'too-long';

export interface FileNameCheck {
  readonly ok: boolean;
  readonly problems: readonly FileNameProblem[];
  /** The offending characters for `invalid-char`, in order of appearance, without duplicates. */
  readonly invalidChars: readonly string[];
}

const INVALID_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
// COM¹ COM² COM³ and LPT¹²³ are device names too (superscript digits).
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[0-9¹²³])$/i;
export const MAX_NAME_BYTES = 255;

export function checkFileName(name: string): FileNameCheck {
  const problems: FileNameProblem[] = [];
  const invalidChars: string[] = [];
  if (name.length === 0) return { ok: false, problems: ['empty'], invalidChars };
  if (name === '.' || name === '..') return { ok: false, problems: ['dot-name'], invalidChars };
  let control = false;
  for (const ch of name) {
    if (ch.charCodeAt(0) < 0x20) control = true;
    else if (INVALID_CHARS.has(ch) && !invalidChars.includes(ch)) invalidChars.push(ch);
  }
  if (invalidChars.length > 0) problems.push('invalid-char');
  if (control) problems.push('control-char');
  // Windows looks only at the part before the first dot, and ignores trailing spaces there: "con .txt" is CON too.
  const base = name.split('.')[0]?.trimEnd() ?? '';
  if (RESERVED.test(base)) problems.push('reserved-windows');
  if (/[. ]$/.test(name)) problems.push('trailing-dot-or-space');
  if (name.startsWith('.')) problems.push('starts-with-dot');
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) problems.push('too-long');
  return { ok: problems.length === 0, problems, invalidChars };
}

/**
 * Segment rules for every relative path that crosses IPC (security review of S03): a `:` anywhere (on Windows,
 * `name:stream` addresses an NTFS alternate data stream of `name`), a trailing dot or space (Windows strips them,
 * so `a.html.` reaches `a.html`) and Windows device names. Stricter rules for NEW names are in {@link checkFileName};
 * these are the ones an existing file's path must also pass, applied on every platform.
 */
export function isUnsafePathSegment(segment: string): boolean {
  if (segment.includes(':') || /[. ]$/.test(segment)) return true;
  return RESERVED.test(segment.split('.')[0]?.trimEnd() ?? '');
}

/**
 * Compares two names the way a file system would. Unicode normalisation is ignored (macOS may hand back NFD names
 * for what the user typed as NFC); case is ignored only for case-insensitive volumes. Only for comparison — paths
 * and names themselves are never lowercased or re-normalised.
 */
export function sameName(a: string, b: string, caseSensitive: boolean): boolean {
  const na = a.normalize('NFC');
  const nb = b.normalize('NFC');
  if (caseSensitive) return na === nb;
  return na.toUpperCase() === nb.toUpperCase() || na.toLowerCase() === nb.toLowerCase();
}

/** True when `a` and `b` differ, but only by letter case (and/or Unicode normalisation). */
export function differsOnlyByCase(a: string, b: string): boolean {
  return a !== b && sameName(a, b, false);
}

/**
 * S52.2: the name of a copy (Duplicate, or a paste into a folder that has the name already), the same on every
 * platform so a project reads alike on Windows and macOS: `page.html` → `page copy.html`, then `page copy 2.html`…
 * A copy of a copy counts on (`page copy.html` → `page copy 2.html`). Folders keep dots in their names. `isFree`
 * decides whether a name is taken (callers compare ignoring case, like every file operation). The result always
 * passes {@link checkFileName}: a long name is shortened before the `copy` suffix.
 */
export function copyName(
  name: string,
  isFree: (candidate: string) => boolean,
  kind: 'file' | 'directory' = 'file',
): string {
  const dot = kind === 'file' ? name.lastIndexOf('.') : -1;
  const ext = dot > 0 ? name.slice(dot) : '';
  const base = dot > 0 ? name.slice(0, dot) : name;
  // At most 6 digits count as a copy number (a name like `page copy 9007199254740991` is just a name).
  const numbered = /^(.*) copy(?: (\d{1,6}))?$/.exec(base);
  const stem = numbered?.[1] ?? base;
  const first = numbered ? Number(numbered[2] ?? '1') + 1 : 1;
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  for (let n = first; n < first + 10_000; n += 1) {
    const suffix = `${n === 1 ? ' copy' : ` copy ${n}`}${ext}`;
    let root = stem;
    while (root.length > 0 && bytes(root) + bytes(suffix) > MAX_NAME_BYTES) root = [...root].slice(0, -1).join('');
    const candidate = `${root.replace(/[. ]+$/, '')}${suffix}`;
    if (checkFileName(candidate).ok && isFree(candidate)) return candidate;
  }
  throw new Error('no free name for a copy');
}
