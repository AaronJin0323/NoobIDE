import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  EMPTY_PROJECT_CONFIG,
  PROJECT_CONFIG_DIR,
  PROJECT_CONFIG_FILE,
  PROJECT_CONFIG_REL,
  parseProjectConfig,
  type ProjectConfig,
  type ProjectConfigProblem,
} from '../shared/project-config';
import { err, ok, type Result } from '../shared/result';
import { writeFileAtomic } from './atomic-write';
import { errorCode, resolveExisting } from './paths';

export * from '../shared/project-config';

/** File-system side of `.noobide/project.json` (S13.2); the schema and its rules are in src/shared/project-config.ts. */
const MAX_CONFIG_BYTES = 16 * 1024;

export type ReadConfigResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'ok'; readonly config: ProjectConfig }
  | { readonly kind: 'invalid'; readonly problems: readonly ProjectConfigProblem[] }
  | { readonly kind: 'unreadable'; readonly code: string };

/** Reads the project's configuration. A missing file is normal (defaults); nothing is ever written here. */
export async function readProjectConfig(root: string): Promise<ReadConfigResult> {
  const resolved = await resolveExisting(root, PROJECT_CONFIG_REL);
  if (!resolved.ok)
    return resolved.code === 'not-found' ? { kind: 'missing' } : { kind: 'unreadable', code: resolved.code };
  let text: string;
  try {
    const info = await stat(resolved.path);
    if (!info.isFile()) return { kind: 'unreadable', code: 'not-a-file' };
    if (info.size > MAX_CONFIG_BYTES) return { kind: 'invalid', problems: ['too-large'] };
    text = await readFile(resolved.path, 'utf8');
  } catch (e) {
    return { kind: 'unreadable', code: errorCode(e) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return { kind: 'invalid', problems: ['not-json'] };
  }
  const result = parseProjectConfig(parsed);
  return result.ok ? { kind: 'ok', config: result.config } : { kind: 'invalid', problems: result.problems };
}

/** The configuration in effect: the file's, or the defaults when it is missing, invalid or unreadable. */
export async function effectiveProjectConfig(root: string): Promise<ProjectConfig> {
  const read = await readProjectConfig(root);
  return read.kind === 'ok' ? read.config : EMPTY_PROJECT_CONFIG;
}

export type WriteConfigError = 'invalid' | 'invalid-existing' | 'outside-project' | 'write-failed';

/**
 * Writes the configuration (validated again) atomically to `.noobide/project.json`, creating `.noobide` when needed.
 * An existing file that NoobIDE cannot read (invalid, from a newer version) is never overwritten.
 */
export async function writeProjectConfig(
  root: string,
  config: ProjectConfig,
): Promise<Result<ProjectConfig, WriteConfigError>> {
  const checked = parseProjectConfig(config);
  if (!checked.ok) return err('invalid', checked.problems.join(','));
  const existing = await readProjectConfig(root);
  if (existing.kind === 'invalid' || existing.kind === 'unreadable') {
    return err('invalid-existing', existing.kind === 'invalid' ? existing.problems.join(',') : existing.code);
  }
  const dir = path.join(root, PROJECT_CONFIG_DIR);
  try {
    await mkdir(dir); // not recursive: the project root itself must exist
  } catch (e) {
    if (errorCode(e) !== 'EEXIST') return err('write-failed', errorCode(e), e);
  }
  const folder = await resolveExisting(root, PROJECT_CONFIG_DIR);
  if (!folder.ok) return err('outside-project', folder.code);
  try {
    const target = path.join(folder.path, PROJECT_CONFIG_FILE);
    const body = `${JSON.stringify(checked.config, null, 2)}\n`;
    await writeFileAtomic(target, new TextEncoder().encode(body), { createIfMissing: true });
  } catch (e) {
    return err('write-failed', errorCode(e), e);
  }
  return ok(checked.config);
}

/** URL path of the page the preview opens first: the configured entry when that file exists, else '' (index). */
export async function previewEntryPath(root: string): Promise<string> {
  const { entry } = await effectiveProjectConfig(root);
  if (!entry) return '';
  const target = await resolveExisting(root, entry);
  if (!target.ok) return '';
  try {
    if (!(await stat(target.path)).isFile()) return '';
  } catch {
    return '';
  }
  return entry.split('/').map(encodeURIComponent).join('/');
}
