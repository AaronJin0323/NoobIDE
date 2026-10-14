import { randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_TEXT_FILE_BYTES,
  type FileContent,
  type DirListing,
  type DirRequest,
  type FileEntry,
  type ListDirError,
  type FileRequest,
  type OpenedProject,
  type ReadFileError,
  type SavedFile,
  type WriteFileError,
  type WriteFileRequest,
} from '../shared/ipc/contract';
import { err, ok, type Result } from '../shared/result';
import { replaceFileAtomic } from './atomic-write';
import { errorCode, isInside, resolveExisting, toFileUri } from './paths';
import { listDirectory } from './tree';
import { decodeText, encodeText } from './text-codec';

/**
 * Projects the user opened and file access inside them (S03.3, S03.4). Main process only.
 *
 * A root is registered only from a path the user chose in the native dialog. Every file request is resolved with
 * path APIs from the root plus the request's `/`-separated segments, then realpath-checked to still lie inside the
 * root — so `..`, symbolic links and junctions cannot reach other files. Paths are never lowercased or joined by hand.
 */

/** Listing limits until the lazy tree model (S07) replaces this flat list. */
export const LIST_LIMITS = { maxFiles: 2000, maxDepth: 8 } as const;

/** Folders that are never listed: dependency and VCS folders are huge and not part of a beginner's page. */
const SKIPPED_DIRS = new Set(['node_modules']);

interface Project {
  readonly root: string;
}

export class ProjectService {
  private readonly projects = new Map<string, Project>();

  /** Registers a folder the user chose and lists its files. */
  async open(chosenPath: string): Promise<Result<OpenedProject, 'list-failed'>> {
    try {
      const root = await realpath(chosenPath);
      if (!(await stat(root)).isDirectory()) return err('list-failed', 'not a directory');
      const { files, truncated } = await listFiles(root);
      const projectId = randomUUID();
      // One open project in v1: opening another revokes access through every earlier projectId (security review).
      this.projects.clear();
      this.projects.set(projectId, { root });
      return ok({ projectId, name: path.basename(root), rootPath: root, files, truncated });
    } catch (e) {
      return err('list-failed', errorCode(e), e);
    }
  }

  /** One folder of the lazy tree (S07.2). */
  async listDir(request: DirRequest): Promise<Result<DirListing, ListDirError>> {
    const project = this.projects.get(request.projectId);
    if (!project) return err('unknown-project', 'project is not open');
    return listDirectory(project.root, request.relPath);
  }

  rootOf(projectId: string): string | undefined {
    return this.projects.get(projectId)?.root;
  }

  async read(request: FileRequest): Promise<Result<FileContent, ReadFileError>> {
    const target = await this.resolve(request);
    if (!target.ok) return target;
    let bytes: Uint8Array;
    try {
      const info = await stat(target.value);
      if (!info.isFile()) return err('not-a-file', 'not a regular file');
      if (info.size > MAX_TEXT_FILE_BYTES) return err('too-large', `${info.size} bytes`);
      bytes = await readFile(target.value);
    } catch (e) {
      return err(isNotFound(e) ? 'not-found' : 'read-failed', errorCode(e), e);
    }
    const decoded = decodeText(bytes);
    if (!decoded.ok) return err('unsupported-encoding', decoded.reason);
    return ok({ text: decoded.text, eol: decoded.eol, bom: decoded.bom, uri: toFileUri(target.value) });
  }

  /** Saves over an existing file. Creating files arrives with the file operations of S08. */
  async write(request: WriteFileRequest): Promise<Result<SavedFile, WriteFileError>> {
    const target = await this.resolve(request);
    if (!target.ok) return target;
    const data = encodeText(request.text, request.bom);
    if (data.length > MAX_TEXT_FILE_BYTES) return err('too-large', `${data.length} bytes`);
    try {
      if (!(await stat(target.value)).isFile()) return err('not-a-file', 'not a regular file');
      // Rename-over would silently replace a file the user marked read-only (POSIX allows it); refuse instead.
      await access(target.value, constants.W_OK);
      await replaceFileAtomic(target.value, data);
    } catch (e) {
      return err(writeErrorCode(e), errorCode(e), e);
    }
    return ok({ savedAt: Date.now() });
  }

  private async resolve(
    request: FileRequest,
  ): Promise<Result<string, 'unknown-project' | 'outside-project' | 'not-found'>> {
    const project = this.projects.get(request.projectId);
    if (!project) return err('unknown-project', 'project is not open');
    // Symbolic links and junctions may point anywhere; the real target must still be inside the project.
    const resolved = await resolveExisting(project.root, request.relPath);
    if (!resolved.ok) return err(resolved.code, resolved.message);
    if (resolved.path === project.root) return err('outside-project', 'the project root is not a file');
    return ok(resolved.path);
  }
}

export { isInside };

async function listFiles(root: string): Promise<{ files: FileEntry[]; truncated: boolean }> {
  const files: FileEntry[] = [];
  let truncated = false;
  const walk = async (dir: string, relSegments: string[]): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      // An unreadable subfolder must not make the whole project unopenable (security review); the root still must be.
      if (relSegments.length === 0) throw e;
      truncated = true;
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= LIST_LIMITS.maxFiles) {
        truncated = true;
        return;
      }
      // Dotfiles (.git, .noobide, editor temp files) are not part of the page; links are not followed.
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const segments = [...relSegments, entry.name];
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        if (segments.length > LIST_LIMITS.maxDepth) {
          truncated = true;
          continue;
        }
        await walk(full, segments);
      } else if (entry.isFile()) {
        files.push({ relPath: segments.join(path.posix.sep), uri: toFileUri(full) });
      }
    }
  };
  await walk(root, []);
  return { files, truncated };
}

function isNotFound(e: unknown): boolean {
  const code = errorCode(e);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function writeErrorCode(e: unknown): WriteFileError {
  switch (errorCode(e)) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'not-found';
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'permission-denied';
    case 'EBUSY':
    case 'ETXTBSY':
      return 'busy';
    case 'ENOSPC':
    case 'EDQUOT':
      return 'disk-full';
    default:
      return 'write-failed';
  }
}
