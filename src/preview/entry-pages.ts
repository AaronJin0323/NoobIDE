import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { isEntryPath } from '../shared/project-config';
import { isIgnoredName } from '../workspace/ignore';

/**
 * S14.3: the pages the entry picker offers — every `.html` / `.htm` file of the project as a portable relative path
 * (`/` separators, names as they are: Chinese characters and spaces kept), sorted with `index.html` first, then by
 * depth and name. Dot folders, node_modules and OS litter are skipped like in the file tree; symbolic links are not
 * followed (a link could point outside the project). Bounded, so a huge folder cannot stall main.
 */
export interface EntryPagesOptions {
  readonly maxPages?: number;
  readonly maxDepth?: number;
  readonly maxEntries?: number;
}

export interface EntryPages {
  readonly pages: readonly string[];
  /** The listing stopped at a limit; more pages may exist. */
  readonly truncated: boolean;
}

export async function listEntryPages(root: string, options: EntryPagesOptions = {}): Promise<EntryPages> {
  const maxPages = options.maxPages ?? 200;
  const maxDepth = options.maxDepth ?? 8;
  let budget = options.maxEntries ?? 20_000;
  const pages: string[] = [];
  let truncated = false;
  const queue: { dir: string; rel: string[] }[] = [{ dir: root, rel: [] }];
  // Breadth-first: shallow pages (the likely entries) are found before deep ones.
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    let entries;
    try {
      entries = await readdir(next.dir, { withFileTypes: true });
    } catch {
      continue; // unreadable folder: skip it
    }
    for (const entry of entries) {
      if (budget-- <= 0) {
        truncated = true;
        break;
      }
      if (isIgnoredName(entry.name)) continue;
      const rel = [...next.rel, entry.name];
      if (entry.isDirectory()) {
        if (rel.length < maxDepth) queue.push({ dir: path.join(next.dir, entry.name), rel });
        else truncated = true;
      } else if (entry.isFile()) {
        const relPath = rel.join('/');
        if (!isEntryPath(relPath)) continue;
        if (pages.length >= maxPages) {
          truncated = true;
          continue;
        }
        pages.push(relPath);
      }
    }
    if (budget <= 0) {
      truncated = true;
      break;
    }
  }
  return { pages: sortPages(pages), truncated };
}

export function sortPages(pages: readonly string[]): string[] {
  const rank = (p: string) => (p.toLowerCase() === 'index.html' ? 0 : 1);
  const depth = (p: string) => p.split('/').length;
  return [...pages].sort(
    (a, b) => rank(a) - rank(b) || depth(a) - depth(b) || a.localeCompare(b, 'zh-CN', { numeric: true }),
  );
}

/**
 * The page the preview opens when `.noobide/project.json` names no entry: '' (the server's `index.html` for `/`) when
 * the project has a root `index.html`, otherwise the first page in picker order — a folder whose only page is
 * `hello.html` or `主页.html` previews that page instead of answering 404. Still '' when the project has no page at
 * all. Returned URL-encoded per segment, like the configured entry.
 */
export async function defaultEntryPath(root: string): Promise<string> {
  const { pages } = await listEntryPages(root);
  const first = pages[0];
  if (first === undefined || first === 'index.html') return '';
  return first.split('/').map(encodeURIComponent).join('/');
}
