import { isPortableRelPath } from './ipc/contract';

/**
 * `.noobide/project.json` (S13.2, PLAN §6): the only file NoobIDE may write into a project. It holds the entry page,
 * preview preferences and its own version — nothing else: no absolute or machine-specific paths, no secrets, no
 * history or caches (those live in app data). Everything in it is optional; a project without it (or after the
 * user deletes it) is an ordinary website that previews from its index.html.
 *
 * Reading is strict: unknown keys, absolute paths anywhere, or a file from a newer NoobIDE make the file "invalid",
 * and the defaults apply without touching it. It is written only when the user changes a setting it holds.
 */
export const PROJECT_CONFIG_VERSION = 1;
export const PROJECT_CONFIG_DIR = '.noobide';
export const PROJECT_CONFIG_FILE = 'project.json';
/** Portable relative path of the file inside the project. */
export const PROJECT_CONFIG_REL = `${PROJECT_CONFIG_DIR}/${PROJECT_CONFIG_FILE}`;

export interface PreviewPrefs {
  /** Refresh the preview after every confirmed save (default true). */
  readonly autoRefresh?: boolean;
}

export interface ProjectConfig {
  readonly version: typeof PROJECT_CONFIG_VERSION;
  /** The page the preview opens first: a portable relative `.html` path. Absent: the server's index.html. */
  readonly entry?: string;
  readonly preview?: PreviewPrefs;
}

export type ProjectConfigProblem =
  | 'not-json'
  | 'not-an-object'
  | 'too-large'
  | 'bad-version'
  | 'newer-version'
  | 'unknown-key'
  | 'absolute-path'
  | 'invalid-entry'
  | 'invalid-preview';

export const EMPTY_PROJECT_CONFIG: ProjectConfig = { version: PROJECT_CONFIG_VERSION };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * True for strings that look like an absolute or machine-specific location on any system: `/x`, `\x`, `C:…`,
 * `\\server`, `file:`/other URL schemes, `~/…`. Checked in every string value, not only in `entry`.
 */
export function looksAbsolute(value: string): boolean {
  return /^([/\\~]|[a-zA-Z]:|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(value.trim());
}

function hasAbsoluteString(value: unknown): boolean {
  if (typeof value === 'string') return looksAbsolute(value);
  if (Array.isArray(value)) return value.some(hasAbsoluteString);
  if (isRecord(value)) return Object.values(value).some(hasAbsoluteString);
  return false;
}

/** A page the preview can open: portable relative path, not inside a dot folder, ending in .html / .htm. */
export function isEntryPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isPortableRelPath(value) &&
    !value.split('/').some((segment) => segment.startsWith('.')) &&
    /\.html?$/i.test(value)
  );
}

export function parseProjectConfig(
  raw: unknown,
):
  | { readonly ok: true; readonly config: ProjectConfig }
  | { readonly ok: false; readonly problems: ProjectConfigProblem[] } {
  if (!isRecord(raw)) return { ok: false, problems: ['not-an-object'] };
  const problems: ProjectConfigProblem[] = [];
  if (hasAbsoluteString(raw)) problems.push('absolute-path');
  if (Object.keys(raw).some((key) => !['version', 'entry', 'preview'].includes(key))) problems.push('unknown-key');
  const { version, entry, preview } = raw;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) problems.push('bad-version');
  else if (version > PROJECT_CONFIG_VERSION) problems.push('newer-version');
  if (entry !== undefined && !isEntryPath(entry) && !problems.includes('absolute-path')) problems.push('invalid-entry');
  let prefs: PreviewPrefs | undefined;
  if (preview !== undefined) {
    if (
      !isRecord(preview) ||
      Object.keys(preview).some((key) => key !== 'autoRefresh') ||
      (preview.autoRefresh !== undefined && typeof preview.autoRefresh !== 'boolean')
    ) {
      problems.push('invalid-preview');
    } else {
      prefs = preview.autoRefresh === undefined ? {} : { autoRefresh: preview.autoRefresh };
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      version: PROJECT_CONFIG_VERSION,
      ...(typeof entry === 'string' ? { entry } : {}),
      ...(prefs ? { preview: prefs } : {}),
    },
  };
}
