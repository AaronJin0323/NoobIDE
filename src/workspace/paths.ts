import { lstat, realpath } from 'node:fs/promises';
import nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultCaseSensitive } from '../platform/index';
import { isUnsafePathSegment } from '../shared/file-names';

/**
 * Path utilities for project files (S07.1, PLAN §7). Main process only.
 *
 * Two kinds of path exist: absolute OS paths, which never leave main, and portable relative paths (`/`-separated,
 * relative to a project root), which cross IPC. Everything here goes through the `path` APIs — separators are never
 * concatenated by hand, paths are never lowercased and file names are never re-normalised (macOS may return NFD
 * names; they are kept exactly as the file system reports them). Every function takes the path flavour as an optional
 * last argument so the Windows rules (drive letters, UNC shares, `\`) are unit-tested on every platform.
 */
export type PathApi = typeof nodePath.win32;

const SEP = '/';

/** True when `candidate` lies strictly below `root` (the root itself is not inside), using path semantics. */
export function isInside(root: string, candidate: string, api: PathApi = nodePath): boolean {
  const rel = api.relative(root, candidate);
  return rel !== '' && !api.isAbsolute(rel) && rel.split(api.sep)[0] !== '..';
}

/**
 * Normalises a relative path to the portable form: OS separators become `/`, empty and `.` segments disappear.
 * Returns `null` for anything that is absolute, has a drive or URL prefix, or climbs with `..`.
 * On POSIX a backslash is an ordinary file-name character and is kept.
 */
export function normalizeRelPath(input: string, api: PathApi = nodePath): string | null {
  if (input.includes('\0') || api.isAbsolute(input) || input.startsWith('/')) return null;
  const segments = input.split(api.sep === '\\' ? /[\\/]/ : /\//).filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return '';
  if (segments.some((s) => s === '..')) return null;
  if (segments[0]?.includes(':')) return null; // `C:foo` (drive-relative on Windows) or `file:…`
  return segments.join(SEP);
}

/** The portable path of `absolute` relative to `root`: `''` for the root itself, `null` when outside. */
export function relativeToRoot(root: string, absolute: string, api: PathApi = nodePath): string | null {
  const rel = api.relative(root, absolute);
  if (rel === '') return '';
  if (api.isAbsolute(rel) || rel.split(api.sep)[0] === '..') return null; // another drive, or above the root
  return rel.split(api.sep).join(SEP);
}

/** The absolute path for a portable relative path, or `null` if it would leave the root. No disk access. */
export function absoluteFromRel(root: string, relPath: string, api: PathApi = nodePath): string | null {
  if (relPath === '') return root;
  const normal = normalizeRelPath(relPath, api);
  if (normal === null || normal !== relPath) return null;
  // Same segment rules as the IPC contract (NTFS streams, trailing dots/spaces, device names), defence in depth.
  if (relPath.split(SEP).some(isUnsafePathSegment)) return null;
  const candidate = api.resolve(root, ...relPath.split(SEP));
  return isInside(root, candidate, api) ? candidate : null;
}

export type ResolveError = 'outside-project' | 'not-found';

/**
 * Resolves an existing entry and checks that its real location (after symbolic links and junctions) is still
 * inside the project. `root` must itself be a realpath.
 */
export async function resolveExisting(
  root: string,
  relPath: string,
): Promise<{ ok: true; path: string } | { ok: false; code: ResolveError; message: string }> {
  const candidate = absoluteFromRel(root, relPath);
  if (candidate === null) return { ok: false, code: 'outside-project', message: 'path leaves the project' };
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (e) {
    return { ok: false, code: 'not-found', message: errorCode(e) };
  }
  if (real !== root && !isInside(root, real)) {
    return { ok: false, code: 'outside-project', message: 'link target leaves the project' };
  }
  return { ok: true, path: real };
}

/**
 * Resolves a path that is about to be created: its parent folder must exist and really be inside the project (or be
 * the root); the new name is appended exactly as given.
 */
export async function resolveNew(
  root: string,
  relPath: string,
): Promise<{ ok: true; path: string; parent: string } | { ok: false; code: ResolveError; message: string }> {
  const candidate = absoluteFromRel(root, relPath);
  if (candidate === null || relPath === '') {
    return { ok: false, code: 'outside-project', message: 'path leaves the project' };
  }
  const segments = relPath.split(SEP);
  const name = segments.pop() as string;
  const parent = await resolveExisting(root, segments.join(SEP));
  if (!parent.ok) return parent;
  return { ok: true, path: nodePath.join(parent.path, name), parent: parent.path };
}

/** The stable `file://` URI of an absolute path (editor model key). Round-trips with {@link fromFileUri}. */
export function toFileUri(absolute: string, api: PathApi = nodePath): string {
  return pathToFileURL(absolute, { windows: api.sep === '\\' }).href;
}

export function fromFileUri(uri: string, api: PathApi = nodePath): string {
  return fileURLToPath(uri, { windows: api.sep === '\\' });
}

/** The parts of node:fs this module needs, injectable for tests. */
export interface StatFs {
  lstat(p: string): Promise<{ dev: number | bigint; ino: number | bigint }>;
}
const realFs: StatFs = { lstat: (p) => lstat(p, { bigint: true }) };

/** Flips the case of the first cased letter: `Project` → `project`, `中文 a` → `中文 A`; `null` if there is none. */
function flipCase(name: string): string | null {
  const chars = [...name];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] as string;
    const upper = ch.toUpperCase();
    const lower = ch.toLowerCase();
    if (upper !== lower && upper.length === 1 && lower.length === 1) {
      chars[i] = ch === upper ? lower : upper;
      return chars.join('');
    }
  }
  return null;
}

/**
 * Whether the volume holding `dir` (an existing absolute path) treats names case-sensitively. Probes without
 * writing anything: looks up the path with one letter's case flipped in the nearest name that has letters. If that
 * finds the same file, the volume is case-insensitive. Falls back to the platform default when no component has a
 * cased letter (e.g. a folder named only in Chinese directly under a drive root).
 */
export async function isCaseSensitive(dir: string, fs: StatFs = realFs, api: PathApi = nodePath): Promise<boolean> {
  let current = dir;
  for (;;) {
    const name = api.basename(current);
    const flipped = name === '' ? null : flipCase(name);
    if (flipped !== null) {
      const variant = api.join(api.dirname(current), flipped);
      const original = await fs.lstat(current);
      try {
        const other = await fs.lstat(variant);
        return !(other.dev === original.dev && other.ino === original.ino);
      } catch {
        return true; // Only the exact spelling exists.
      }
    }
    const parent = api.dirname(current);
    if (parent === current) return defaultCaseSensitive();
    current = parent;
  }
}

export function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown';
}
