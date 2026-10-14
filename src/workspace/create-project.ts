import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { checkFileName, sameName } from '../shared/file-names';
import { err, ok, type Result } from '../shared/result';
import { errorCode } from './paths';
import type { TemplateInfo } from './templates';

/**
 * Creates a new project folder from a built-in template (S20.2, PLAN §2 "Create"). Main process only.
 *
 * User data is sacred (AGENTS.md, ADR 0008):
 * - The project name becomes the folder name exactly as typed; names that Windows or macOS cannot represent are
 *   refused with the problems listed (src/shared/file-names), never silently changed.
 * - An existing entry with that name — a folder (empty or not) or a file — is never reused or overwritten, and a
 *   sibling whose name differs only in letter case is refused too (it would clash on Windows and macOS).
 * - The folder is created with a non-recursive mkdir (fails if it appeared meanwhile), every file with COPYFILE_EXCL.
 * - Exactly the manifest's `files` are copied (never template.json or the thumbnail); no `.noobide/` is written.
 * - If anything fails half-way, only what this call created is removed again, and the cause is reported.
 */
export type CreateProjectError =
  /** The name breaks the Windows or macOS rules; message lists the problems. */
  | 'invalid-name'
  /** Something with that name already exists; message is its name. */
  | 'exists'
  /** A sibling differs only in letter case; message is its name. */
  | 'case-conflict'
  /** The chosen location does not exist (any more) or is not a folder. */
  | 'location-missing'
  | 'permission-denied'
  | 'disk-full'
  /** A template file could not be read from the app's resources. */
  | 'template-broken'
  | 'create-failed';

export interface NewProjectTarget {
  /** Absolute folder the project goes into (the user's choice or the default location). */
  readonly parentDir: string;
  /** Folder name typed by the user. */
  readonly name: string;
}

/** The parts of node:fs the creator uses, injectable to simulate failures half-way (tests). */
export interface CreateFs {
  mkdir(p: string, options?: { recursive?: boolean }): Promise<unknown>;
  copyFile(from: string, to: string, mode: number): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  unlink(p: string): Promise<void>;
  rmdir(p: string): Promise<void>;
}

const realFs: CreateFs = {
  mkdir: (p, options) => mkdir(p, options),
  copyFile: (from, to, mode) => copyFile(from, to, mode),
  readdir: (dir) => readdir(dir),
  unlink,
  rmdir,
};

/** The absolute folder that would be created (for the wizard's "will create" line). No disk access. */
export function projectFolderPath(target: NewProjectTarget): string {
  return path.join(target.parentDir, target.name);
}

function checkName(name: string): Result<null, CreateProjectError> {
  const check = checkFileName(name);
  return check.ok ? ok(null) : err('invalid-name', check.problems.join(','));
}

/** Finds an existing sibling with the same name (`exists`) or one differing only in case (`case-conflict`). */
async function checkFree(parentDir: string, name: string, fs: CreateFs): Promise<Result<null, CreateProjectError>> {
  let siblings: string[];
  try {
    siblings = await fs.readdir(parentDir);
  } catch (e) {
    const code = errorCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR') return err('location-missing', code);
    return err(failureCode(e), code, e);
  }
  for (const sibling of siblings) {
    if (!sameName(sibling, name, false)) continue;
    return sibling.normalize('NFC') === name.normalize('NFC') ? err('exists', sibling) : err('case-conflict', sibling);
  }
  return ok(null);
}

/**
 * Checks a name and location without changing anything (live feedback in the wizard). A location that does not
 * exist yet is fine when `createParent` is set (the default "NoobIDE 项目" folder in Documents is made on demand).
 */
export async function checkNewProject(
  target: NewProjectTarget,
  options: { createParent?: boolean; fs?: CreateFs } = {},
): Promise<Result<{ folderPath: string }, CreateProjectError>> {
  const named = checkName(target.name);
  if (!named.ok) return named;
  const fs = options.fs ?? realFs;
  const free = await checkFree(target.parentDir, target.name, fs);
  if (!free.ok && !(free.code === 'location-missing' && options.createParent)) return free;
  return ok({ folderPath: projectFolderPath(target) });
}

/**
 * Creates `<parentDir>/<name>` and copies the template's files into it. Returns the new folder's real path.
 * `createParent` allows creating the location itself (only for the default location main chose).
 */
export async function createProjectFromTemplate(
  template: Pick<TemplateInfo, 'dir' | 'files'>,
  target: NewProjectTarget,
  options: { createParent?: boolean; fs?: CreateFs } = {},
): Promise<Result<{ root: string }, CreateProjectError>> {
  const fs = options.fs ?? realFs;
  const named = checkName(target.name);
  if (!named.ok) return named;

  let parent: string;
  try {
    if (options.createParent) await fs.mkdir(target.parentDir, { recursive: true });
    parent = await realpath(target.parentDir);
    if (!(await stat(parent)).isDirectory()) return err('location-missing', 'not a folder');
  } catch (e) {
    const code = errorCode(e);
    return code === 'ENOENT' || code === 'ENOTDIR' ? err('location-missing', code) : err(failureCode(e), code, e);
  }

  const free = await checkFree(parent, target.name, fs);
  if (!free.ok) return free;

  const root = path.join(parent, target.name);
  try {
    await fs.mkdir(root); // not recursive: EEXIST if anything took the name since the check
  } catch (e) {
    return errorCode(e) === 'EEXIST' ? err('exists', target.name) : err(failureCode(e), errorCode(e), e);
  }

  // Everything below is ours; on failure exactly this is removed again (files first, then folders deepest first).
  const createdFiles: string[] = [];
  const createdDirs: string[] = [root];
  try {
    for (const rel of template.files) {
      const segments = rel.split('/');
      let dir = root;
      for (const segment of segments.slice(0, -1)) {
        dir = path.join(dir, segment);
        if (!createdDirs.includes(dir)) {
          await fs.mkdir(dir);
          createdDirs.push(dir);
        }
      }
      const destination = path.join(root, ...segments);
      try {
        await fs.copyFile(path.join(template.dir, ...segments), destination, constants.COPYFILE_EXCL);
      } catch (e) {
        if (errorCode(e) === 'ENOENT') throw Object.assign(new Error('template file missing'), { code: 'TEMPLATE' });
        throw e;
      }
      createdFiles.push(destination);
    }
  } catch (e) {
    await rollback(createdFiles, createdDirs, fs);
    if (errorCode(e) === 'TEMPLATE') return err('template-broken', 'a template file is missing');
    return err(failureCode(e), errorCode(e), e);
  }
  return ok({ root: await realpath(root).catch(() => root) });
}

async function rollback(files: readonly string[], dirs: readonly string[], fs: CreateFs): Promise<void> {
  for (const file of [...files].reverse()) await fs.unlink(file).catch(() => undefined);
  // rmdir only removes empty folders: anything someone else put there meanwhile is never touched.
  for (const dir of [...dirs].reverse()) await fs.rmdir(dir).catch(() => undefined);
}

function failureCode(e: unknown): CreateProjectError {
  switch (errorCode(e)) {
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'permission-denied';
    case 'ENOSPC':
    case 'EDQUOT':
      return 'disk-full';
    case 'EEXIST':
      return 'exists';
    default:
      return 'create-failed';
  }
}
