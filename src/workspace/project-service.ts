import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MAX_TEXT_FILE_BYTES,
  type FileContent,
  type FileEntry,
  type FileRequest,
  type OpenedProject,
  type ReadFileError,
  type SavedFile,
  type WriteFileError,
  type WriteFileRequest,
} from '../shared/ipc/contract';
import { err, ok, type Result } from '../shared/result';
import type { SaveHistoryHook } from '../recovery/history-triggers';
import { replaceFileAtomic } from './atomic-write';
import { isListedEntry } from './listing-filter';
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

/** S21.2: longest a save waits for local history to read the version it is about to replace. */
export const HISTORY_CAPTURE_TIMEOUT_MS = 1000;

interface Project {
  readonly root: string;
}

export class ProjectService {
  private readonly projects = new Map<string, Project>();
  /** S21.2: local-history snapshots around each save (optional; never blocks or fails a save). */
  private readonly history: SaveHistoryHook | undefined;
  /** Fault injection for tests (docs/testing.md); the real atomic replace otherwise. */
  private readonly replaceFile: typeof replaceFileAtomic;

  constructor(options: { history?: SaveHistoryHook; replaceFile?: typeof replaceFileAtomic } = {}) {
    this.history = options.history;
    this.replaceFile = options.replaceFile ?? replaceFileAtomic;
  }

  /** Registers a folder the user chose and lists its files. */
  async open(chosenPath: string): Promise<Result<OpenedProject, 'list-failed'>> {
    try {
      const root = await realpath(chosenPath);
      if (!(await stat(root)).isDirectory()) return err('list-failed', 'not a directory');
      const { files, truncated } = await listFiles(root);
      const projectId = randomUUID();
      this.projects.set(projectId, { root });
      return ok({ projectId, name: path.basename(root), rootPath: root, files, truncated });
    } catch (e) {
      return err('list-failed', errorCode(e), e);
    }
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
    return ok({ text: decoded.text, eol: decoded.eol, bom: decoded.bom, uri: pathToFileURL(target.value).href });
  }

  /** Saves over an existing file. Creating files arrives with the file operations of S08. */
  async write(request: WriteFileRequest): Promise<Result<SavedFile, WriteFileError>> {
    const target = await this.resolve(request);
    if (!target.ok) return target;
    const data = encodeText(request.text, request.bom);
    if (data.length > MAX_TEXT_FILE_BYTES) return err('too-large', `${data.length} bytes`);
    let before: Uint8Array | null = null; // S21.2
    try {
      if (!(await stat(target.value)).isFile()) return err('not-a-file', 'not a regular file');
      // Rename-over would silently replace a file the user marked read-only (POSIX allows it); refuse instead.
      await access(target.value, constants.W_OK);
      before = await this.captureBeforeSave(target.value); // S21.2
      await this.replaceFile(target.value, data);
    } catch (e) {
      this.recordSave(request.projectId, target.value, before, null); // S21.2
      return err(writeErrorCode(e), errorCode(e), e);
    }
    this.recordSave(request.projectId, target.value, before, data); // S21.2
    return ok({ savedAt: Date.now() });
  }

  // --- S21.2: local history around saves. Only reading the old bytes precedes the replace (bounded by a timeout);
  // storing snapshots is queued, not awaited. A throwing, slow or hanging hook never fails or delays a save. ---
  private async captureBeforeSave(absPath: string): Promise<Uint8Array | null> {
    if (!this.history) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), HISTORY_CAPTURE_TIMEOUT_MS);
      });
      return await Promise.race([this.history.captureBeforeSave(absPath), timeout]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private recordSave(projectId: string, absPath: string, before: Uint8Array | null, after: Uint8Array | null): void {
    const root = this.rootOf(projectId);
    if (!this.history || root === undefined || (!before && !after)) return;
    try {
      // Keyed by the real path relative to the root (canonical case on Windows) in Unicode NFC.
      const relKey = path.relative(root, absPath).split(path.sep).join(path.posix.sep).normalize('NFC');
      this.history.recordSave(root, relKey, before, after);
    } catch {
      // History is a safety net; the save result stands.
    }
  }
  // --- end S21.2 ---

  private async resolve(
    request: FileRequest,
  ): Promise<Result<string, 'unknown-project' | 'outside-project' | 'not-found'>> {
    const project = this.projects.get(request.projectId);
    if (!project) return err('unknown-project', 'project is not open');
    const candidate = path.resolve(project.root, ...request.relPath.split(path.posix.sep));
    if (!isInside(project.root, candidate)) return err('outside-project', 'path leaves the project');
    let real: string;
    try {
      real = await realpath(candidate);
    } catch (e) {
      return err('not-found', errorCode(e), e);
    }
    // Symbolic links and junctions may point anywhere; the real target must still be inside the project.
    if (!isInside(project.root, real)) return err('outside-project', 'link target leaves the project');
    return ok(real);
  }
}

/** True when `candidate` lies strictly below `root` (the root itself is not a file), using path APIs only. */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== '' && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..';
}

async function listFiles(root: string): Promise<{ files: FileEntry[]; truncated: boolean }> {
  const files: FileEntry[] = [];
  let truncated = false;
  const walk = async (dir: string, relSegments: string[]): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= LIST_LIMITS.maxFiles) {
        truncated = true;
        return;
      }
      // Dotfiles (.git, .noobide, editor temp files) and node_modules are not listed; links are not followed.
      if (!isListedEntry(entry.name, entry.isDirectory()) || entry.isSymbolicLink()) continue;
      const segments = [...relSegments, entry.name];
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (segments.length > LIST_LIMITS.maxDepth) {
          truncated = true;
          continue;
        }
        await walk(full, segments);
      } else if (entry.isFile()) {
        files.push({ relPath: segments.join(path.posix.sep), uri: pathToFileURL(full).href });
      }
    }
  };
  await walk(root, []);
  return { files, truncated };
}

function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown';
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
