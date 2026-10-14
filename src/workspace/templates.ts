import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Result } from '../shared/result';

/**
 * Built-in webpage templates (S20.1). Pure loader: reads `<baseDir>/<id>/template.json` manifests and checks that
 * every listed file exists. Copying a template into a new project is the create-project wizard's job (S20.2), which
 * copies exactly `files` (never `template.json` or the thumbnail) and never overwrites an existing folder.
 */

export type TemplateLocale = 'zh-CN' | 'en';
export const TEMPLATE_LOCALES: readonly TemplateLocale[] = ['zh-CN', 'en'];

export interface TemplateManifest {
  readonly id: string;
  readonly order: number;
  readonly default: boolean;
  readonly name: Readonly<Record<TemplateLocale, string>>;
  readonly description: Readonly<Record<TemplateLocale, string>>;
  /** Page the preview opens, `/`-separated and relative to the template folder. Always one of `files`. */
  readonly entry: string;
  /** Files copied into a new project, `/`-separated relative paths. */
  readonly files: readonly string[];
  /** Picture for the wizard; stays in the app, not copied. */
  readonly thumbnail: string;
}

export interface TemplateInfo extends TemplateManifest {
  /** Absolute folder of the template inside the app's resources. */
  readonly dir: string;
}

export type ManifestError = 'invalid-manifest';
export type ListTemplatesError = 'unreadable-base-dir';

export interface TemplateProblem {
  readonly folder: string;
  readonly reason: string;
}

export interface TemplateListing {
  readonly templates: readonly TemplateInfo[];
  /** Folders that were skipped and why (no file contents, safe to log). */
  readonly problems: readonly TemplateProblem[];
}

const ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export const MANIFEST_FILE = 'template.json';

/**
 * A safe project-relative path: `/`-separated, no empty / `.` / `..` segments, not absolute, no backslashes, no
 * dot-files (the static server denies them) and nothing inside `.noobide/`.
 */
export function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > 200 || p.includes('\\') || p.includes('\0') || p.includes(':')) return false;
  if (p.startsWith('/')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !seg.startsWith('.'));
}

function localized(value: unknown): Record<TemplateLocale, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const out = {} as Record<TemplateLocale, string>;
  for (const locale of TEMPLATE_LOCALES) {
    const text = (value as Record<string, unknown>)[locale];
    if (typeof text !== 'string' || text.trim() === '') return undefined;
    out[locale] = text;
  }
  return out;
}

/** Validates a parsed `template.json`. `folder` is the template's folder name, which must equal its id. */
export function parseTemplateManifest(raw: unknown, folder: string): Result<TemplateManifest, ManifestError> {
  const bad = (why: string) => err('invalid-manifest' as const, `${folder}/${MANIFEST_FILE}: ${why}`);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('not an object');
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id)) return bad('id must be lower-case letters, digits and -');
  if (m.id !== folder) return bad(`id "${m.id}" does not match its folder`);
  if (typeof m.order !== 'number' || !Number.isInteger(m.order)) return bad('order must be an integer');
  if (typeof m.default !== 'boolean') return bad('default must be true or false');
  const name = localized(m.name);
  if (!name) return bad('name needs non-empty zh-CN and en');
  const description = localized(m.description);
  if (!description) return bad('description needs non-empty zh-CN and en');
  if (!Array.isArray(m.files) || m.files.length === 0) return bad('files must be a non-empty list');
  const files: string[] = [];
  for (const f of m.files) {
    if (typeof f !== 'string' || !isSafeRelativePath(f)) return bad(`unsafe file path ${JSON.stringify(f)}`);
    if (f === MANIFEST_FILE) return bad(`${MANIFEST_FILE} must not be copied into projects`);
    if (files.some((g) => g.toLowerCase() === f.toLowerCase())) return bad(`duplicate file ${f}`);
    files.push(f);
  }
  if (typeof m.entry !== 'string' || !files.includes(m.entry)) return bad('entry must be one of files');
  if (!/\.html?$/i.test(m.entry)) return bad('entry must be an HTML page');
  if (typeof m.thumbnail !== 'string' || !isSafeRelativePath(m.thumbnail)) return bad('thumbnail must be a path');
  if (files.includes(m.thumbnail)) return bad('thumbnail must not be one of files');
  return ok({
    id: m.id,
    order: m.order,
    default: m.default,
    name,
    description,
    entry: m.entry,
    files,
    thumbnail: m.thumbnail,
  });
}

/**
 * True when `rel` exists under `dir` with exactly this spelling. Windows and default macOS volumes are
 * case-insensitive, so a plain stat would accept `Images/A.svg` for `images/a.svg`; the user's page would then break
 * on a case-sensitive server. Compares each segment against the real directory listing instead.
 */
export async function existsWithExactCase(dir: string, rel: string): Promise<boolean> {
  let current = dir;
  for (const segment of rel.split('/')) {
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      return false;
    }
    if (!names.includes(segment)) return false;
    current = path.join(current, segment);
  }
  return true;
}

async function loadOne(baseDir: string, folder: string): Promise<Result<TemplateInfo, ManifestError>> {
  const dir = path.join(baseDir, folder);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), 'utf8'));
  } catch (e) {
    return err('invalid-manifest', `${folder}/${MANIFEST_FILE}: missing or not valid JSON`, e);
  }
  const parsed = parseTemplateManifest(raw, folder);
  if (!parsed.ok) return parsed;
  for (const rel of [...parsed.value.files, parsed.value.thumbnail]) {
    if (!(await existsWithExactCase(dir, rel)) || !(await stat(path.join(dir, ...rel.split('/')))).isFile()) {
      return err('invalid-manifest', `${folder}: listed file ${rel} is missing`);
    }
  }
  return ok({ ...parsed.value, dir });
}

/** Lists the valid templates under `baseDir`, sorted by `order`. Invalid folders are reported, not thrown. */
export async function listTemplates(baseDir: string): Promise<Result<TemplateListing, ListTemplatesError>> {
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch (e) {
    return err('unreadable-base-dir', 'template folder could not be read', e);
  }
  const templates: TemplateInfo[] = [];
  const problems: TemplateProblem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const one = await loadOne(baseDir, entry.name);
    if (one.ok) templates.push(one.value);
    else problems.push({ folder: entry.name, reason: one.message });
  }
  templates.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return ok({ templates, problems });
}

/** The template to preselect: the one marked default, else the first. */
export function defaultTemplate(templates: readonly TemplateInfo[]): TemplateInfo | undefined {
  return templates.find((t) => t.default) ?? templates[0];
}

export interface TemplatesDirInput {
  /** `app.isPackaged` */
  readonly isPackaged: boolean;
  /** `process.resourcesPath` — forge `extraResource` puts `resources/templates` at `<resourcesPath>/templates`. */
  readonly resourcesPath: string;
  /** `app.getAppPath()` — the repository root when running `npm start` or the e2e build from `.vite/`. */
  readonly appPath: string;
}

/** Where the built-in templates live at runtime (see resources/templates/README.md, Packaging). */
export function resolveTemplatesDir({ isPackaged, resourcesPath, appPath }: TemplatesDirInput): string {
  return isPackaged ? path.join(resourcesPath, 'templates') : path.join(appPath, 'resources', 'templates');
}
