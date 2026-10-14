import type { Dirent } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DirListing, ListDirError, TreeEntry } from '../shared/ipc/contract';
import { err, ok, type Result } from '../shared/result';
import { isIgnoredName } from './ignore';
import { errorCode, isInside, resolveExisting } from './paths';

/**
 * One level of the lazy project tree (S07.2). The renderer asks for a folder's children only when the user expands
 * it, so opening a large project never walks the whole disk.
 *
 * Symbolic links and junctions are listed and marked. A link whose real target lies inside the project behaves like
 * its target; one that leads outside the project (or nowhere) is shown but never followed: it cannot be expanded or
 * opened, and its target is not revealed to the renderer.
 */
export const MAX_DIR_ENTRIES = 5000;

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Folders first, then natural order (`page2` before `page10`), ties broken by code points for a stable order. */
export function compareEntries(a: TreeEntry, b: TreeEntry): number {
  const rank = (e: TreeEntry) => (e.kind === 'directory' ? 0 : 1);
  return rank(a) - rank(b) || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export async function listDirectory(root: string, relPath: string): Promise<Result<DirListing, ListDirError>> {
  const dir = await resolveExisting(root, relPath);
  if (!dir.ok) return err(dir.code, dir.message);
  let dirents: Dirent[];
  try {
    if (!(await stat(dir.path)).isDirectory()) return err('not-a-directory', 'not a directory');
    dirents = await readdir(dir.path, { withFileTypes: true });
  } catch (e) {
    return err(listErrorCode(errorCode(e)), errorCode(e), e);
  }
  const visible = dirents.filter((d) => !isIgnoredName(d.name));
  const truncated = visible.length > MAX_DIR_ENTRIES;
  const entries: TreeEntry[] = [];
  for (const dirent of truncated ? visible.slice(0, MAX_DIR_ENTRIES) : visible) {
    const childRel = relPath === '' ? dirent.name : `${relPath}/${dirent.name}`;
    const entry = await describe(root, path.join(dir.path, dirent.name), dirent, childRel);
    if (entry) entries.push(entry);
  }
  entries.sort(compareEntries);
  return ok({ relPath, entries, truncated });
}

async function describe(root: string, full: string, dirent: Dirent, relPath: string): Promise<TreeEntry | null> {
  const name = dirent.name;
  if (dirent.isDirectory()) return { name, relPath, kind: 'directory', isLink: false };
  if (dirent.isFile()) return { name, relPath, kind: 'file', isLink: false };
  if (!dirent.isSymbolicLink()) return null; // sockets, FIFOs, devices: not part of a web page
  let real: string;
  try {
    real = await realpath(full);
  } catch {
    return { name, relPath, kind: 'link-broken', isLink: true };
  }
  if (real === root || !isInside(root, real)) return { name, relPath, kind: 'link-outside', isLink: true };
  try {
    const info = await stat(real);
    if (info.isDirectory()) return { name, relPath, kind: 'directory', isLink: true };
    if (info.isFile()) return { name, relPath, kind: 'file', isLink: true };
  } catch {
    // Vanished between realpath and stat.
  }
  return { name, relPath, kind: 'link-broken', isLink: true };
}

function listErrorCode(code: string): ListDirError {
  switch (code) {
    case 'ENOENT':
      return 'not-found';
    case 'ENOTDIR':
      return 'not-a-directory';
    case 'EACCES':
    case 'EPERM':
      return 'permission-denied';
    default:
      return 'list-failed';
  }
}
