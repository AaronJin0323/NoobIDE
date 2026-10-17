/**
 * S48.4: the project's files for the composer's @file list, read through the same `listDir` the file tree uses (so
 * main's project-root checks apply). Breadth-first and bounded, so a huge folder never stalls the composer; hidden
 * entries (dotfiles) and dependency folders are left out, as the tree does.
 */
import type { DirListing, IpcResult, ListDirError } from '../../shared/ipc/contract';
import { acceptablePath } from './composer-triggers';

export type ListDir = (request: {
  readonly projectId: string;
  readonly relPath: string;
}) => Promise<IpcResult<DirListing, ListDirError>>;

export interface ProjectFileLimits {
  /** At most this many files are returned. */
  readonly files: number;
  /** At most this many folders are read. */
  readonly folders: number;
}

export const PROJECT_FILE_LIMITS: ProjectFileLimits = { files: 5000, folders: 500 };

const SKIPPED_FOLDERS = new Set(['node_modules']);

/** Project-relative paths of the project's files, shallow folders first. A folder that cannot be read is skipped. */
export async function listProjectFiles(
  listDir: ListDir,
  projectId: string,
  limits: ProjectFileLimits = PROJECT_FILE_LIMITS,
): Promise<string[]> {
  const files: string[] = [];
  const queue: string[] = [''];
  let read = 0;
  while (queue.length > 0 && read < limits.folders && files.length < limits.files) {
    const relPath = queue.shift() as string;
    read += 1;
    let result: Awaited<ReturnType<ListDir>>;
    try {
      result = await listDir({ projectId, relPath });
    } catch {
      continue;
    }
    if (!result.ok) continue;
    for (const entry of result.value.entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.kind === 'directory') {
        if (!SKIPPED_FOLDERS.has(entry.name)) queue.push(entry.relPath);
      } else if (entry.kind === 'file' && acceptablePath(entry.relPath)) {
        files.push(entry.relPath);
        if (files.length >= limits.files) break;
      }
    }
  }
  return files;
}
