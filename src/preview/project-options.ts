import { findMisnamedPages } from './misnamed-pages';
import type { PreviewProjectOptions, RefreshMode, SetRefreshModeError } from '../shared/ipc/preview-contract';
import { err, ok, type Result } from '../shared/result';
import {
  EMPTY_PROJECT_CONFIG,
  readProjectConfig,
  writeProjectConfig,
  type ProjectConfig,
} from '../workspace/project-config';
import { listEntryPages } from './entry-pages';

/**
 * Preview settings of a project (S14.2 refresh mode, S14.3 entry page). They live in `.noobide/project.json`, owned
 * by the S13.2 module (src/workspace/project-config.ts): this file only maps them to what the preview toolbar shows,
 * and writes through that module (validated, atomic, never over a file it cannot read).
 *
 * The refresh mode is stored as `preview.autoRefresh` (false = manual). If the schema moves to
 * `preview.refresh: 'auto' | 'manual'`, only `refreshModeOf` and `withRefreshMode` change.
 */
export function refreshModeOf(config: ProjectConfig): RefreshMode {
  return config.preview?.autoRefresh === false ? 'manual' : 'auto';
}

/** The config with the refresh mode set. Automatic is the default, so it is stored by leaving the key out. */
export function withRefreshMode(config: ProjectConfig, mode: RefreshMode): ProjectConfig {
  const { preview, ...rest } = config;
  const { autoRefresh: _old, ...otherPrefs } = preview ?? {};
  const prefs = mode === 'manual' ? { ...otherPrefs, autoRefresh: false } : otherPrefs;
  return Object.keys(prefs).length > 0 ? { ...rest, preview: prefs } : rest;
}

export async function readPreviewOptions(root: string): Promise<PreviewProjectOptions> {
  const [read, listing] = await Promise.all([readProjectConfig(root), listEntryPages(root)]);
  const config = read.kind === 'ok' ? read.config : EMPTY_PROJECT_CONFIG;
  const entry = config.entry && listing.pages.includes(config.entry) ? config.entry : null;
  return {
    pages: listing.pages,
    truncated: listing.truncated,
    entry,
    refresh: refreshModeOf(config),
    configLocked: read.kind === 'invalid' || read.kind === 'unreadable',
    // A project without any page previews as 404: look for a page saved without its .html ending.
    ...(listing.pages.length === 0 && !listing.truncated ? { misnamed: await findMisnamedPages(root) } : {}),
  };
}

export async function writeRefreshMode(
  root: string,
  mode: RefreshMode,
): Promise<Result<RefreshMode, Exclude<SetRefreshModeError, 'unknown-project'>>> {
  const read = await readProjectConfig(root);
  if (read.kind === 'invalid' || read.kind === 'unreadable') {
    return err('invalid-existing', 'the project file cannot be read; it is left as it is');
  }
  const current = read.kind === 'ok' ? read.config : EMPTY_PROJECT_CONFIG;
  if (read.kind === 'missing' && mode === 'auto') return ok(mode); // the default: nothing to write
  const written = await writeProjectConfig(root, withRefreshMode(current, mode));
  if (written.ok) return ok(refreshModeOf(written.value));
  return written.code === 'invalid'
    ? err('write-failed', written.message)
    : err(written.code, written.message, written.cause);
}
