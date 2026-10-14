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
  type SavedCopy,
  type SavedFile,
  type WriteFileError,
  type WriteFileRequest,
} from '../shared/ipc/contract';
import { err, ok, type Result } from '../shared/result';
import type { SaveHistoryHook } from '../recovery/history-triggers';
import { FileInUseError, replaceFileAtomic, writeFileAtomic, type AtomicWriteOptions } from './atomic-write';
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

export interface ProjectServiceOptions {
  /** Injected file system and retry policy for saves (tests simulate ENOSPC, locks and read-only folders). */
  readonly atomic?: AtomicWriteOptions;
  /** S21.2: local-history snapshots around each confirmed save. */
  readonly history?: SaveHistoryHook;
}

/** A project file whose new content is confirmed on disk. */
export interface SavedProjectFile {
  readonly projectId: string;
  readonly relPath: string;
  /** Real absolute path. */
  readonly path: string;
}

export class ProjectService {
  private readonly projects = new Map<string, Project>();
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly savedListeners = new Set<(file: SavedProjectFile) => void>();
  /** S21.2: local-history snapshots around each save (optional; never blocks or fails a save). */
  private readonly history: SaveHistoryHook | undefined;

  constructor(private readonly options: ProjectServiceOptions = {}) {
    this.history = options.history;
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
    return ok({
      text: decoded.text,
      eol: decoded.eol,
      bom: decoded.bom,
      mixedEol: decoded.mixedEol,
      uri: pathToFileURL(target.value).href,
    });
  }

  /**
   * Saves over an existing file (S10.1). Writes are serialized in arrival order — per request path from the first
   * moment (before any await), and per real path around the write itself (two names for one file) — so an older
   * write can never land after a newer one. "Saved" listeners run only after the temp file was renamed over the
   * target (S10.5). Creating files arrives with the file operations of S08.
   */
  write(request: WriteFileRequest): Promise<Result<SavedFile, WriteFileError>> {
    return this.serialized(`${request.projectId}\0${request.relPath}`, async () => {
      const target = await this.resolve(request);
      if (!target.ok) return target;
      const data = encodeText(request.text, request.bom);
      if (data.length > MAX_TEXT_FILE_BYTES) return err('too-large', `${data.length} bytes`);
      return this.serialized(target.value, async (): Promise<Result<SavedFile, WriteFileError>> => {
        try {
          if (!(await stat(target.value)).isFile()) return err('not-a-file', 'not a regular file');
          // Rename-over would silently replace a file the user marked read-only (POSIX allows it); refuse instead.
          await access(target.value, constants.W_OK);
          // S21.2: keep the version on disk before this save batch replaces it.
          await this.history?.beforeSave(this.rootOf(request.projectId) ?? '', request.relPath, target.value);
          await replaceFileAtomic(target.value, data, this.options.atomic);
        } catch (e) {
          return err(writeErrorCode(e), errorMessage(e), e);
        }
        await this.history?.afterSave(this.rootOf(request.projectId) ?? '', request.relPath, data); // S21.2
        this.emitSaved({ projectId: request.projectId, relPath: request.relPath, path: target.value });
        return ok({ savedAt: Date.now() });
      });
    });
  }

  /**
   * "Save elsewhere" (S10.3): writes the text of an open project file to a path the user chose in the native save
   * dialog (which already asked before replacing an existing file). The project file itself is not touched.
   */
  async writeCopy(destination: string, request: WriteFileRequest): Promise<Result<SavedCopy, WriteFileError>> {
    if (!this.projects.has(request.projectId)) return err('unknown-project', 'project is not open');
    const data = encodeText(request.text, request.bom);
    if (data.length > MAX_TEXT_FILE_BYTES) return err('too-large', `${data.length} bytes`);
    const target = path.resolve(destination);
    return this.serialized(target, async (): Promise<Result<SavedCopy, WriteFileError>> => {
      try {
        await writeFileAtomic(target, data, { ...this.options.atomic, createIfMissing: true });
      } catch (e) {
        return err(writeErrorCode(e), errorMessage(e), e);
      }
      return ok({ path: target });
    });
  }

  /** Subscribes to confirmed writes (main-side preview hook, S10.5). Returns the unsubscribe function. */
  onSaved(listener: (file: SavedProjectFile) => void): () => void {
    this.savedListeners.add(listener);
    return () => this.savedListeners.delete(listener);
  }

  private emitSaved(file: SavedProjectFile): void {
    for (const listener of [...this.savedListeners]) {
      try {
        listener(file);
      } catch {
        // A failing subscriber must not turn a confirmed save into a failure.
      }
    }
  }

  /** Runs `task` after every earlier task for the same path has finished (per-path mutex). */
  private async serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.writeQueues.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.writeQueues.get(key) === tail) this.writeQueues.delete(key);
    }
  }

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
        files.push({ relPath: segments.join(path.posix.sep), uri: pathToFileURL(full).href });
      }
    }
  };
  await walk(root, []);
  return { files, truncated };
}

/** The OS error code for the "details" line; a lock that outlasted every retry says so. Never file contents. */
function errorMessage(e: unknown): string {
  return e instanceof FileInUseError ? e.message : errorCode(e);
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
