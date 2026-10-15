import type { Dirent } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { MAX_TEXT_FILE_BYTES } from '../shared/ipc/contract';
import { folderNameIssues, sortIssues, type PortabilityIssue, type PortabilityReport } from '../shared/portability';
import { isListedEntry } from './listing-filter';
import { decodeText } from './text-codec';

/**
 * S13.5: walks an open project READ-ONLY and reports what would break when it moves between Windows and macOS
 * (src/shared/portability). It never writes, renames, re-normalises or touches timestamps of anything: folders are
 * listed with readdir and text files are read with a read-only handle. Links are not followed (like the listing).
 */
export const PORTABILITY_LIMITS = {
  /** Directory entries looked at in total. */
  maxEntries: 5000,
  maxDepth: 8,
  /** Text files whose line endings are checked. */
  maxTextFiles: 500,
} as const;

/** Text the editor opens (S09): the files whose line endings matter. */
const TEXT_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.txt',
  '.md',
  '.svg',
  '.xml',
]);

export async function scanPortability(
  root: string,
  limits: { readonly [K in keyof typeof PORTABILITY_LIMITS]: number } = PORTABILITY_LIMITS,
): Promise<PortabilityReport> {
  const issues: PortabilityIssue[] = [];
  let truncated = false;
  let seen = 0;
  let textFiles = 0;

  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (rel === '') throw e;
      truncated = true; // an unreadable subfolder is skipped, never an error for the whole project
      return;
    }
    const listed = entries.filter((e) => isListedEntry(e.name, e.isDirectory()));
    if (seen + listed.length > limits.maxEntries) {
      truncated = true;
      return;
    }
    seen += listed.length;
    issues.push(
      ...folderNameIssues(
        rel,
        listed.map((e) => e.name),
      ),
    );
    for (const entry of listed) {
      const full = path.join(dir, entry.name);
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth + 1 > limits.maxDepth) truncated = true;
        else await walk(full, childRel, depth + 1);
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        if (textFiles >= limits.maxTextFiles) {
          truncated = true;
          continue;
        }
        textFiles += 1;
        if (await hasMixedLineEndings(full)) issues.push({ kind: 'mixed-eol', relPath: childRel });
      }
    }
  };

  await walk(root, '', 1);
  return { issues: sortIssues(issues), truncated };
}

async function hasMixedLineEndings(file: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    if (size > MAX_TEXT_FILE_BYTES) return false;
    const bytes = new Uint8Array(size);
    const { bytesRead } = await handle.read(bytes, 0, size, 0);
    const decoded = decodeText(bytes.subarray(0, bytesRead));
    return decoded.ok && decoded.mixedEol;
  } catch {
    return false; // unreadable or locked: nothing to report about its line endings
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
