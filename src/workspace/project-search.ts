import type { Dirent } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_SEARCH_FILES,
  MAX_SEARCH_FILE_BYTES,
  MAX_SEARCH_MATCHES,
  SEARCH_PREVIEW_CHARS,
  type OpenBuffer,
  type SearchError,
  type SearchFileResult,
  type SearchMatch,
  type SearchResults,
} from '../shared/ipc/search-contract';
import { buildQueryRegex, lineMatches, splitLines, textFingerprint, type SearchQuery } from '../shared/search';
import { err, ok, type Result } from '../shared/result';
import { isIgnoredName } from './ignore';
import { isInside } from './paths';
import { decodeText } from './text-codec';
import { runWithTimeLimit } from './time-limit';

/**
 * Project-wide text search (S51.2), main process only. Bounded and streaming-friendly:
 *
 * - The walk starts at the project's realpath root and never leaves it: links are followed only when their real target
 *   is inside the root (and each real folder is visited once). Names ignored by the tree (ignore.ts: dotfiles,
 *   node_modules, OS litter, NoobIDE temporaries) are skipped.
 * - Files over MAX_SEARCH_FILE_BYTES, binary files (a NUL byte) and files that are not UTF-8 are skipped and counted.
 * - Open editor buffers are searched instead of the disk copy (they hold what the user sees).
 * - Files are read a few at a time in path order and the results are cut deterministically at MAX_SEARCH_MATCHES.
 *   Between batches the event loop gets a turn (setImmediate), so main keeps answering while a big project is scanned.
 * - An AbortSignal stops the search between files; it then answers `cancelled`.
 * - The user's regular expression runs under a time limit (S51.6, time-limit.ts): at most REGEX_FILE_BUDGET_MS per
 *   file and REGEX_TOTAL_BUDGET_MS per search, else the search answers `regex-too-slow`. A backtracking pattern such
 *   as `(a+)+$` blocks main for a fraction of a second instead of hanging the IDE. After any slow file the event loop
 *   gets a turn as well.
 *
 * Nothing about the files' contents is logged.
 */

/** Files read at the same time. */
const BATCH = 16;

/** Longest one file's matching may take (ms): main is blocked at most this long by a bad pattern. */
export const REGEX_FILE_BUDGET_MS = 200;
/** Longest all matching of one search may take (ms), for a pattern that is slow on every file. */
export const REGEX_TOTAL_BUDGET_MS = 10_000;
/** Matching a file for longer than this (ms) gives the event loop a turn before the next file. */
const YIELD_AFTER_MS = 16;

export interface ProjectSearchOptions {
  readonly signal?: AbortSignal;
  /** Limits (tests use smaller ones). */
  readonly maxMatches?: number;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly regexFileBudgetMs?: number;
  readonly regexTotalBudgetMs?: number;
  readonly yieldAfterMs?: number;
}

interface Candidate {
  readonly relPath: string;
  readonly absPath: string;
}

const CANCELLED = 'search cancelled';
const TOO_SLOW = 'regular expression too slow';

export async function searchProject(
  root: string,
  searchId: number,
  query: SearchQuery,
  openBuffers: readonly OpenBuffer[],
  options: ProjectSearchOptions = {},
): Promise<Result<SearchResults, SearchError>> {
  const started = performance.now();
  const built = buildQueryRegex(query);
  if (!built.ok) return err('invalid-regex', built.message);
  const regex = built.regex;
  const maxMatches = options.maxMatches ?? MAX_SEARCH_MATCHES;
  const maxFiles = options.maxFiles ?? MAX_SEARCH_FILES;
  const maxFileBytes = options.maxFileBytes ?? MAX_SEARCH_FILE_BYTES;
  const signal = options.signal;
  const fileBudget = options.regexFileBudgetMs ?? REGEX_FILE_BUDGET_MS;
  let totalBudget = options.regexTotalBudgetMs ?? REGEX_TOTAL_BUDGET_MS;
  const yieldAfter = options.yieldAfterMs ?? YIELD_AFTER_MS;
  const buffers = new Map(openBuffers.map((b) => [b.relPath, b.text]));

  try {
    const walk = await listFiles(root, maxFiles, signal);
    // Open buffers of files that are not on disk (deleted or not listed) are what the user sees: searched too.
    const listed = new Set(walk.files.map((f) => f.relPath));
    const candidates: Candidate[] = [...walk.files];
    for (const relPath of buffers.keys()) {
      if (!listed.has(relPath) && !relPath.split('/').some(isIgnoredName)) {
        candidates.push({ relPath, absPath: '' });
      }
    }
    candidates.sort((a, b) => compareRelPaths(a.relPath, b.relPath));

    const files: SearchFileResult[] = [];
    let totalMatches = 0;
    let truncated = walk.truncated;
    let skippedBinary = 0;
    let skippedLarge = 0;
    let filesSearched = 0;
    for (let i = 0; i < candidates.length && !truncated; i += BATCH) {
      if (signal?.aborted) return err('cancelled', CANCELLED);
      const batch = candidates.slice(i, i + BATCH);
      const texts = await Promise.all(batch.map((c) => textOf(c, buffers, maxFileBytes)));
      for (let j = 0; j < batch.length; j += 1) {
        const loaded = texts[j];
        const candidate = batch[j] as Candidate;
        if (loaded === undefined || loaded.kind !== 'text') {
          if (loaded?.kind === 'binary') skippedBinary += 1;
          if (loaded?.kind === 'large') skippedLarge += 1;
          continue;
        }
        filesSearched += 1;
        if (totalBudget <= 0) return err('regex-too-slow', TOO_SLOW);
        const matchStart = performance.now();
        const limited = runWithTimeLimit(
          () => matchesIn(loaded.text, regex, maxMatches - totalMatches),
          Math.min(fileBudget, totalBudget),
        );
        const matchMs = performance.now() - matchStart;
        totalBudget -= matchMs;
        if (!limited.ok) return err('regex-too-slow', TOO_SLOW);
        const matches = limited.value;
        if (matches.list.length > 0) {
          files.push({
            relPath: candidate.relPath,
            source: loaded.source,
            fingerprint: textFingerprint(loaded.text),
            matches: matches.list,
          });
          totalMatches += matches.list.length;
        }
        if (matches.more) {
          truncated = true;
          break;
        }
        if (matchMs > yieldAfter) {
          await new Promise((resolve) => setImmediate(resolve));
          if (signal?.aborted) return err('cancelled', CANCELLED);
        }
      }
      // Give the event loop a turn between batches (IPC, window events, other timers).
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (signal?.aborted) return err('cancelled', CANCELLED);
    return ok({
      searchId,
      files,
      totalMatches,
      truncated,
      filesSearched,
      skippedBinary,
      skippedLarge,
      durationMs: Math.round(performance.now() - started),
    });
  } catch (e) {
    if (signal?.aborted) return err('cancelled', CANCELLED);
    return err('search-failed', e instanceof Error ? ((e as NodeJS.ErrnoException).code ?? 'error') : 'error', e);
  }
}

/** Folders before files is the tree's order; here plain code-unit order of the path keeps results stable. */
function compareRelPaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type Loaded =
  | { readonly kind: 'text'; readonly text: string; readonly source: 'buffer' | 'disk' }
  | { readonly kind: 'binary' | 'large' | 'gone' };

async function textOf(candidate: Candidate, buffers: ReadonlyMap<string, string>, maxBytes: number): Promise<Loaded> {
  const buffer = buffers.get(candidate.relPath);
  if (buffer !== undefined) return { kind: 'text', text: buffer, source: 'buffer' };
  try {
    const info = await stat(candidate.absPath);
    if (!info.isFile()) return { kind: 'gone' };
    if (info.size > maxBytes) return { kind: 'large' };
    const decoded = decodeText(await readFile(candidate.absPath));
    return decoded.ok ? { kind: 'text', text: decoded.text, source: 'disk' } : { kind: 'binary' };
  } catch {
    return { kind: 'gone' }; // removed or unreadable since the walk: nothing to show
  }
}

function matchesIn(text: string, regex: RegExp, room: number): { list: SearchMatch[]; more: boolean } {
  const list: SearchMatch[] = [];
  const { lines } = splitLines(text);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    for (const match of lineMatches(line, regex)) {
      if (list.length >= room) return { list, more: true };
      list.push({
        line: i + 1,
        column: match.index + 1,
        length: match.length,
        ...previewOf(line, match.index, match.length),
      });
    }
  }
  return { list, more: false };
}

/**
 * The line around a match: up to a third of the preview before it (leading whitespace trimmed), the whole match
 * however long, and some context after it — so the replace preview can always re-run the match on it (S51.4).
 */
function previewOf(line: string, index: number, length: number): { preview: string; previewStart: number } {
  const lead = line.length - line.trimStart().length;
  const from = Math.max(lead, index - Math.floor(SEARCH_PREVIEW_CHARS / 3));
  const start = Math.min(from, index);
  const end = Math.max(start + SEARCH_PREVIEW_CHARS * 2, index + length + SEARCH_PREVIEW_CHARS);
  return { preview: line.slice(start, end), previewStart: index - start };
}

/** Text files of the project in no particular order, inside the root only; truncated at `maxFiles`. */
async function listFiles(
  root: string,
  maxFiles: number,
  signal: AbortSignal | undefined,
): Promise<{ files: Candidate[]; truncated: boolean }> {
  const files: Candidate[] = [];
  const visited = new Set<string>([root]);
  const queue: { abs: string; rel: string }[] = [{ abs: root, rel: '' }];
  while (queue.length > 0) {
    if (signal?.aborted) throw new Error(CANCELLED);
    const dir = queue.shift() as { abs: string; rel: string };
    let entries: Dirent[];
    try {
      entries = await readdir(dir.abs, { withFileTypes: true });
    } catch {
      continue; // an unreadable folder is skipped, like in the tree
    }
    for (const entry of entries) {
      if (isIgnoredName(entry.name)) continue;
      const abs = path.join(dir.abs, entry.name);
      const rel = dir.rel === '' ? entry.name : `${dir.rel}/${entry.name}`;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      let real = abs;
      if (entry.isSymbolicLink()) {
        // Followed only when the real target is inside the project (realpath check), never outside it.
        try {
          real = await realpath(abs);
          if (!isInside(root, real)) continue;
          const info = await stat(real);
          isDir = info.isDirectory();
          isFile = info.isFile();
        } catch {
          continue; // broken link
        }
      }
      if (isDir) {
        if (!visited.has(real)) {
          visited.add(real);
          queue.push({ abs: real, rel });
        }
      } else if (isFile) {
        if (files.length >= maxFiles) return { files, truncated: true };
        files.push({ relPath: rel, absPath: real });
      }
    }
  }
  return { files, truncated: false };
}
