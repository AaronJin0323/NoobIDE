import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Result } from '../shared/result';

/**
 * Maps a preview HTTP request target to a file inside the project root, or refuses it (S04.1, PLAN §8).
 *
 * Two layers, both required:
 * 1. `parseRequestTarget` is pure: it decodes the URL path segment by segment and rejects traversal (`..`, also
 *    percent-encoded), backslashes, NUL, drive letters / alternate data streams (`:`), empty segments, Windows
 *    device names and dotfiles (`.git`, `.noobide`, `.env`, …).
 * 2. `resolveInRoot` builds the path with path APIs, resolves it with the OS realpath (follows symbolic links and
 *    junctions, expands Windows 8.3 short names such as `GIT~1`) and checks that the real file is still inside the
 *    real root and that no real path segment is a dotfile.
 */

export type TargetError = 'bad-request' | 'forbidden';

export interface RequestTarget {
  /** Decoded path segments below the root; empty for `/`. */
  readonly segments: readonly string[];
  /** The URL path ended with `/` (a directory request: serve its index.html). */
  readonly directory: boolean;
}

const MAX_TARGET_LENGTH = 4096;
// Win32 trims trailing spaces and dots, so "con .txt" and "nul." name devices too.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)[ .]*(\..*)?$/i;
// Characters Windows forbids in names (wildcards are interpreted by some APIs) and control characters.
// eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
const FORBIDDEN_CHARS = /[<>"|?*\u0000-\u001f]/;

export function parseRequestTarget(rawTarget: string): Result<RequestTarget, TargetError> {
  if (rawTarget.length === 0 || rawTarget.length > MAX_TARGET_LENGTH) return err('bad-request', 'target length');
  // Origin-form only ("/path?query"); absolute-form, authority-form and "*" are refused.
  if (!rawTarget.startsWith('/') || rawTarget.startsWith('//')) return err('bad-request', 'not an origin-form path');
  const pathPart = rawTarget.split(/[?#]/, 1)[0] ?? '';
  if (pathPart.includes('\\')) return err('bad-request', 'backslash in path');
  const rawSegments = pathPart.slice(1).split('/');
  const directory = rawSegments[rawSegments.length - 1] === '';
  if (directory) rawSegments.pop();
  const segments: string[] = [];
  for (const raw of rawSegments) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return err('bad-request', 'invalid percent-encoding');
    }
    if (segment === '' || segment === '.' || segment === '..') return err('bad-request', 'empty or dot segment');
    if (/[/\\\0:]/.test(segment)) return err('bad-request', 'separator, NUL or colon in segment');
    if (FORBIDDEN_CHARS.test(segment)) return err('bad-request', 'reserved character in segment');
    if (WINDOWS_DEVICE.test(segment)) return err('bad-request', 'device name');
    if (segment.startsWith('.')) return err('forbidden', 'dotfile');
    segments.push(segment);
  }
  return ok({ segments, directory });
}

export type ResolveError = 'forbidden' | 'not-found' | 'redirect-to-directory';

/** `root` must already be a real path (see PreviewServer.start). */
export async function resolveInRoot(root: string, target: RequestTarget): Promise<Result<string, ResolveError>> {
  const candidate = path.resolve(root, ...target.segments);
  if (candidate !== root && !isInside(root, candidate)) return err('forbidden', 'path leaves the root');
  const real = await realFile(root, candidate);
  if (!real.ok) return real;
  let info;
  try {
    info = await stat(real.value);
  } catch {
    return err('not-found', 'stat failed');
  }
  if (info.isFile()) {
    // "/page.html/" is not a directory; refuse it rather than guessing.
    return target.directory ? err('not-found', 'file requested as directory') : ok(real.value);
  }
  if (!info.isDirectory()) return err('not-found', 'not a regular file');
  if (!target.directory && target.segments.length > 0) return err('redirect-to-directory', 'directory without /');
  const index = await realFile(root, path.join(real.value, 'index.html'));
  if (!index.ok) return index;
  try {
    return (await stat(index.value)).isFile() ? ok(index.value) : err('not-found', 'index is not a file');
  } catch {
    return err('not-found', 'stat failed');
  }
}

async function realFile(root: string, candidate: string): Promise<Result<string, 'forbidden' | 'not-found'>> {
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return err('not-found', 'no such file');
  }
  if (real === root) return ok(real);
  // Links and junctions may point anywhere: the real target must still be inside the root…
  if (!isInside(root, real)) return err('forbidden', 'real path leaves the root');
  // …and must not be a dotfile under another name (a link named "notes" → ".env", or the short name GIT~1).
  if (
    path
      .relative(root, real)
      .split(path.sep)
      .some((s) => s.startsWith('.'))
  ) {
    return err('forbidden', 'real path is a dotfile');
  }
  return ok(real);
}

/** True when `candidate` lies strictly below `root`, using path semantics (not string prefixes). */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== '' && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..';
}
