import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { FileOpError } from '../shared/ipc/contract';
import { checkFileName, sameName } from '../shared/file-names';
import { err, ok, type Result } from '../shared/result';
import { errorCode, isInside, resolveExisting, resolveNew } from './paths';

/**
 * Create, rename/move and trash inside a project (S08.2–S08.4, ADR 0008). Main process only. User data is sacred:
 *
 * - New names must pass the Windows AND macOS rules on every platform; a bad name is explained, never changed.
 * - Nothing is ever overwritten. Files are created with `wx`, folders without `recursive`. A file is moved with
 *   link() + unlink(), which the OS refuses when the target exists; folders and links (and volumes without hard
 *   links) are moved with rename() right after an existence check — the residual window is documented in ADR 0008.
 * - A sibling whose name differs only in case is a conflict on every volume (the project must keep working on
 *   case-insensitive Windows and macOS). Only the entry itself may be skipped, and only by its exact name.
 * - A case-only rename (`index.html` → `Index.html`) is tried directly and verified by listing the folder; only if
 *   the volume kept the old spelling does it hop through a visible temporary name, which is reported if it sticks.
 * - Existing entries are addressed by the exact name the OS lists, never followed if they are links, so a link is
 *   renamed or trashed itself, never its target, and Windows aliases (`a.html.`, `a.html:stream`) never resolve.
 */
export type EntryKind = 'file' | 'directory';

/** The file-system calls file operations make, injectable so failures between steps can be tested. */
export interface FileOpsFs {
  rename(from: string, to: string): Promise<void>;
  link(existing: string, newPath: string): Promise<void>;
  unlink(p: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  lstat(p: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
}

const realFs: FileOpsFs = {
  rename,
  link,
  unlink,
  readdir: (dir) => readdir(dir),
  lstat: (p) => lstat(p),
};

const SEP = '/';

/** Prefix of the temporary name of a case-only rename that had to hop; visible in the tree and in Explorer/Finder. */
export const RENAME_TEMP_PREFIX = 'NoobIDE-renaming-';

/** Errors of link() that mean "this volume cannot hard-link here", so the move falls back to rename(). */
const LINK_UNSUPPORTED = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EMLINK', 'EINVAL']);

function splitRel(relPath: string): { parent: string; name: string } {
  const i = relPath.lastIndexOf(SEP);
  return i < 0 ? { parent: '', name: relPath } : { parent: relPath.slice(0, i), name: relPath.slice(i + 1) };
}

/**
 * An existing entry addressed by its own path (not followed if it is a link). The parent folder is realpath-checked
 * inside the project, and the name must be listed in it exactly — so NTFS streams and names Windows rewrites never
 * resolve, while a real file whose name is not portable (from a zip or a Mac) can still be renamed or trashed.
 */
export async function resolveEntry(
  root: string,
  relPath: string,
  fs: FileOpsFs = realFs,
): Promise<Result<string, FileOpError>> {
  if (relPath === '') return err('outside-project', 'the project folder itself');
  const { parent, name } = splitRel(relPath);
  if (name === '' || name === '.' || name === '..' || name.includes('\0') || name.includes(path.sep)) {
    return err('outside-project', 'not a name in this folder');
  }
  const dir = await resolveExisting(root, parent);
  if (!dir.ok) return err(dir.code, dir.message);
  let names: string[];
  try {
    names = await fs.readdir(dir.path);
  } catch (e) {
    return err(opErrorCode(e), errorCode(e), e);
  }
  if (!names.includes(name)) return err('not-found', 'no entry with exactly this name');
  const full = path.join(dir.path, name);
  if (!isInside(root, full)) return err('outside-project', 'path leaves the project');
  return ok(full);
}

/** A new name must be valid on Windows and macOS alike; the message lists the problems (src/shared/file-names). */
function checkName(name: string): Result<null, FileOpError> {
  const check = checkFileName(name);
  return check.ok ? ok(null) : err('invalid-name', check.problems.join(','));
}

/**
 * Finds a sibling that would collide with a new name: the same name (`exists`) or one differing only in case or
 * Unicode normalisation (`case-conflict`). `self` is the entry being renamed in this folder: only the sibling with
 * exactly its name is skipped (never by inode, which network volumes may report as 0 or reuse).
 */
async function checkTarget(
  parentDir: string,
  name: string,
  fs: FileOpsFs,
  self?: string,
): Promise<Result<null, FileOpError>> {
  let siblings: string[];
  try {
    siblings = await fs.readdir(parentDir);
  } catch (e) {
    return err(opErrorCode(e), errorCode(e), e);
  }
  for (const sibling of siblings) {
    if (sibling === self || !sameName(sibling, name, false)) continue;
    return sibling.normalize('NFC') === name.normalize('NFC') ? err('exists', sibling) : err('case-conflict', sibling);
  }
  return ok(null);
}

export async function createEntry(
  root: string,
  relPath: string,
  kind: EntryKind,
  fs: FileOpsFs = realFs,
): Promise<Result<{ relPath: string }, FileOpError>> {
  const named = checkName(splitRel(relPath).name);
  if (!named.ok) return named;
  const target = await resolveNew(root, relPath);
  if (!target.ok) return err(target.code, target.message);
  const checked = await checkTarget(target.parent, splitRel(relPath).name, fs);
  if (!checked.ok) return checked;
  try {
    if (kind === 'directory') {
      await mkdir(target.path); // not recursive: fails with EEXIST instead of reusing a folder
    } else {
      // `wx`: fails if anything appeared meanwhile, so an existing file is never truncated. Empty = LF by default.
      const handle = await open(target.path, 'wx');
      await handle.close();
    }
  } catch (e) {
    return err(opErrorCode(e), errorCode(e), e);
  }
  return ok({ relPath });
}

export async function renameEntry(
  root: string,
  from: string,
  to: string,
  fs: FileOpsFs = realFs,
): Promise<Result<{ from: string; to: string }, FileOpError>> {
  if (from === to) return ok({ from, to });
  const toName = splitRel(to).name;
  const named = checkName(toName);
  if (!named.ok) return named;
  const source = await resolveEntry(root, from, fs);
  if (!source.ok) return source;
  const target = await resolveNew(root, to);
  if (!target.ok) return err(target.code, target.message);
  // After resolving: also catches `sub` → `SUB/inner` and moves through a junction into the folder itself.
  if (target.path === source.value || isInside(source.value, target.path)) {
    return err('into-itself', 'a folder cannot be moved into itself');
  }
  const sourceDir = path.dirname(source.value);
  const fromName = path.basename(source.value);
  const sameDir = sourceDir === target.parent;
  const checked = await checkTarget(target.parent, toName, fs, sameDir ? fromName : undefined);
  if (!checked.ok) return checked;

  try {
    if (sameDir && sameName(fromName, toName, false)) {
      return await caseOnlyRename(sourceDir, fromName, toName, fs, { from, to });
    }
    const info = await fs.lstat(source.value);
    const moved = await moveWithoutReplace(source.value, target.path, info.isFile() && !info.isSymbolicLink(), fs);
    if (!moved.ok) return moved.code === 'exists' ? err('exists', toName) : moved;
  } catch (e) {
    return err(opErrorCode(e), errorCode(e), e);
  }
  return ok({ from, to });
}

/** Moves without ever replacing an existing target (see the module comment). */
async function moveWithoutReplace(
  source: string,
  target: string,
  isFile: boolean,
  fs: FileOpsFs,
): Promise<Result<null, FileOpError>> {
  if (isFile) {
    let linked = false;
    try {
      await fs.link(source, target); // atomic: refuses with EEXIST if the target exists
      linked = true;
    } catch (e) {
      if (errorCode(e) === 'EEXIST') return err('exists', path.basename(target));
      if (!LINK_UNSUPPORTED.has(errorCode(e))) return err(opErrorCode(e), errorCode(e), e);
    }
    if (linked) {
      try {
        await fs.unlink(source);
        return ok(null);
      } catch (e) {
        // E.g. a read-only file on Windows: undo the second name, then try a plain rename below.
        await fs.unlink(target).catch(() => undefined);
        if (!LINK_UNSUPPORTED.has(errorCode(e))) return err(opErrorCode(e), errorCode(e), e);
      }
    }
  }
  if (await exists(target, fs)) return err('exists', path.basename(target));
  await fs.rename(source, target);
  return ok(null);
}

/**
 * Renames `fromName` to `toName` in `dir` when they differ only in case/normalisation. Direct rename() first (NTFS
 * and APFS handle it), verified by listing the folder; a hop through a visible temporary name only if the volume
 * kept the old spelling. If the hop cannot finish and cannot be undone, the temporary name is reported.
 */
async function caseOnlyRename(
  dir: string,
  fromName: string,
  toName: string,
  fs: FileOpsFs,
  result: { from: string; to: string },
): Promise<Result<{ from: string; to: string }, FileOpError>> {
  const source = path.join(dir, fromName);
  const target = path.join(dir, toName);
  await fs.rename(source, target);
  let names = await fs.readdir(dir);
  if (names.includes(toName) && !names.includes(fromName)) return ok(result);

  const tempName = `${RENAME_TEMP_PREFIX}${randomBytes(4).toString('hex')}-${toName}`;
  const temp = path.join(dir, tempName);
  const current = names.includes(fromName) ? source : target; // where the entry is now
  await fs.rename(current, temp);
  try {
    await fs.rename(temp, target);
  } catch (e) {
    try {
      await fs.rename(temp, source);
    } catch {
      return err('interrupted', tempName); // nothing is lost: the entry is under this visible name
    }
    return err(opErrorCode(e), errorCode(e), e);
  }
  names = await fs.readdir(dir);
  if (!names.includes(toName)) return err('op-failed', 'the volume did not keep the new spelling');
  return ok(result);
}

export async function trashEntry(
  root: string,
  relPath: string,
  trashItem: (fullPath: string) => Promise<void>,
  beforeTrash?: (fullPath: string) => Promise<void>,
): Promise<Result<null, FileOpError>> {
  const target = await resolveEntry(root, relPath);
  if (!target.ok) return target;
  // Local history (S21) snapshots the files first. Not for links: their target may lie outside the project.
  if (beforeTrash) {
    const isLink = await lstat(target.value).then(
      (info) => info.isSymbolicLink(),
      () => true,
    );
    if (!isLink) await beforeTrash(target.value).catch(() => undefined);
  }
  try {
    await trashItem(target.value);
  } catch (e) {
    // shell.trashItem rejects with a plain Error (e.g. the file is open in another program on Windows).
    return err('trash-failed', e instanceof Error ? e.message : String(e), e);
  }
  return ok(null);
}

async function exists(p: string, fs: FileOpsFs): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export function opErrorCode(e: unknown): FileOpError {
  switch (errorCode(e)) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'not-found';
    case 'EEXIST':
    case 'ENOTEMPTY':
      return 'exists';
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'permission-denied';
    case 'EBUSY':
    case 'ETXTBSY':
      return 'busy';
    case 'EINVAL':
    case 'ENAMETOOLONG':
      return 'invalid-name';
    default:
      return 'op-failed';
  }
}
