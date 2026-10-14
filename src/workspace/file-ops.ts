import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import type { FileOpError } from '../shared/ipc/contract';
import { checkFileName, differsOnlyByCase, sameName } from '../shared/file-names';
import { err, ok, type Result } from '../shared/result';
import { errorCode, isInside, resolveExisting, resolveNew } from './paths';

/**
 * Create, rename/move and trash inside a project (S08.2–S08.4). Main process only. User data is sacred:
 *
 * - New names must pass the Windows AND macOS rules on every platform; a bad name is explained, never changed.
 * - Nothing is ever overwritten: files are created with `wx`, folders without `recursive`, and a rename checks its
 *   target first. A sibling whose name differs only in case is a conflict too (it would clash on Windows/macOS).
 * - A case-only rename (`index.html` → `Index.html`) is allowed when source and target are the same file on a
 *   case-insensitive volume, and done in two steps through a unique temporary name.
 * - Links are renamed or trashed themselves, never their targets.
 */
export type EntryKind = 'file' | 'directory';

const SEP = '/';

function splitRel(relPath: string): { parent: string; name: string } {
  const i = relPath.lastIndexOf(SEP);
  return i < 0 ? { parent: '', name: relPath } : { parent: relPath.slice(0, i), name: relPath.slice(i + 1) };
}

/**
 * An existing entry addressed by its own path (not followed if it is a link): the parent folder is realpath-checked
 * inside the project, the name is appended as is.
 */
export async function resolveEntry(root: string, relPath: string): Promise<Result<string, FileOpError>> {
  if (relPath === '') return err('outside-project', 'the project folder itself');
  const { parent, name } = splitRel(relPath);
  const dir = await resolveExisting(root, parent);
  if (!dir.ok) return err(dir.code, dir.message);
  const full = path.join(dir.path, name);
  if (!isInside(root, full)) return err('outside-project', 'path leaves the project');
  try {
    await lstat(full);
  } catch (e) {
    return err(opErrorCode(e), errorCode(e), e);
  }
  return ok(full);
}

/** A new name must be valid on Windows and macOS alike; the message lists the problems (src/shared/file-names). */
function checkName(name: string): Result<null, FileOpError> {
  const check = checkFileName(name);
  return check.ok ? ok(null) : err('invalid-name', check.problems.join(','));
}

/** Finds a sibling that would collide with a new name (exactly or by case only). */
async function checkTarget(
  parentDir: string,
  name: string,
  ignoreSameFileAs?: { dev: bigint; ino: bigint },
): Promise<Result<null, FileOpError>> {
  let siblings: string[];
  try {
    siblings = await readdir(parentDir);
  } catch (e) {
    return err(opErrorCode(e), errorCode(e), e);
  }
  for (const sibling of siblings) {
    if (!sameName(sibling, name, false)) continue;
    if (ignoreSameFileAs) {
      const info = await lstat(path.join(parentDir, sibling), { bigint: true });
      if (info.dev === ignoreSameFileAs.dev && info.ino === ignoreSameFileAs.ino) continue; // the entry itself
    }
    return sibling.normalize('NFC') === name.normalize('NFC') ? err('exists', sibling) : err('case-conflict', sibling);
  }
  return ok(null);
}

export async function createEntry(
  root: string,
  relPath: string,
  kind: EntryKind,
): Promise<Result<{ relPath: string }, FileOpError>> {
  const named = checkName(splitRel(relPath).name);
  if (!named.ok) return named;
  const target = await resolveNew(root, relPath);
  if (!target.ok) return err(target.code, target.message);
  const checked = await checkTarget(target.parent, splitRel(relPath).name);
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
): Promise<Result<{ from: string; to: string }, FileOpError>> {
  if (from === to) return ok({ from, to });
  if (to.startsWith(`${from}${SEP}`)) return err('into-itself', 'a folder cannot be moved into itself');
  const named = checkName(splitRel(to).name);
  if (!named.ok) return named;
  const source = await resolveEntry(root, from);
  if (!source.ok) return source;
  const target = await resolveNew(root, to);
  if (!target.ok) return err(target.code, target.message);
  let identity: { dev: bigint; ino: bigint };
  try {
    const info = await lstat(source.value, { bigint: true });
    identity = { dev: info.dev, ino: info.ino };
  } catch (e) {
    return err(opErrorCode(e), errorCode(e), e);
  }
  const checked = await checkTarget(target.parent, splitRel(to).name, identity);
  if (!checked.ok) return checked;

  const caseOnly =
    splitRel(from).parent === splitRel(to).parent && differsOnlyByCase(splitRel(from).name, splitRel(to).name);
  try {
    if (caseOnly) {
      // Through a unique temporary name, so case-insensitive volumes see a real change of name.
      const temp = path.join(target.parent, `.${randomUUID()}.noobide-rename`);
      await rename(source.value, temp);
      try {
        await rename(temp, target.path);
      } catch (e) {
        await rename(temp, source.value).catch(() => undefined);
        throw e;
      }
    } else {
      // Last check right before the rename: rename() itself would replace an existing file on every platform.
      if (await exists(target.path)) return err('exists', splitRel(to).name);
      await rename(source.value, target.path);
    }
  } catch (e) {
    return err(opErrorCode(e), errorCode(e), e);
  }
  return ok({ from, to });
}

export async function trashEntry(
  root: string,
  relPath: string,
  trashItem: (fullPath: string) => Promise<void>,
): Promise<Result<null, FileOpError>> {
  const target = await resolveEntry(root, relPath);
  if (!target.ok) return target;
  try {
    await trashItem(target.value);
  } catch (e) {
    // shell.trashItem rejects with a plain Error (e.g. the file is open in another program on Windows).
    return err('trash-failed', e instanceof Error ? e.message : String(e), e);
  }
  return ok(null);
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
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
