import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isIgnoredName } from '../workspace/ignore';

/**
 * A project without any `.html` page previews as "404 Not Found". The usual beginner cause is a page saved without the
 * ending (`home` instead of `home.html`) or with a typo (`home.hmtl`). This finds such files — by their first bytes,
 * never by guessing from the name alone — so the preview can explain it and offer a rename the user confirms. Nothing
 * is renamed here. Bounded: a big folder cannot stall main, and only file heads are read.
 */
export interface MisnamedPage {
  /** Portable relative path of the file as it is. */
  readonly path: string;
  /** The same folder and name, ending in `.html`. */
  readonly suggested: string;
}

const TYPO_EXTENSIONS = new Set(['.hmtl', '.htlm', '.thml', '.hml', '.htmll', '.htmml', '.txt']);
const HEAD_BYTES = 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** `home` → `home.html`, `page.hmtl` → `page.html`, `page.html.txt` → `page.html`; null for real other types. */
export function suggestedPageName(name: string): string | null {
  if (name.startsWith('.')) return null;
  const ext = path.extname(name);
  if (ext === '') return `${name}.html`;
  if (!TYPO_EXTENSIONS.has(ext.toLowerCase())) return null;
  const base = name.slice(0, -ext.length);
  return /\.html?$/i.test(base) ? base : `${base}.html`;
}

/** Whether text starts like an HTML document (after a BOM, whitespace and comments). */
export function looksLikeHtml(head: string): boolean {
  let text = head.replace(/^\uFEFF/, '').trimStart();
  while (text.startsWith('<!--')) {
    const end = text.indexOf('-->');
    if (end < 0) return false;
    text = text.slice(end + 3).trimStart();
  }
  return /^<(!doctype\s+html|html)[\s>]/i.test(text);
}

export async function findMisnamedPages(
  root: string,
  options: { readonly max?: number; readonly maxDepth?: number; readonly maxEntries?: number } = {},
): Promise<MisnamedPage[]> {
  const max = options.max ?? 10;
  const maxDepth = options.maxDepth ?? 4;
  let budget = options.maxEntries ?? 5_000;
  const found: MisnamedPage[] = [];
  const queue: { dir: string; rel: string[] }[] = [{ dir: root, rel: [] }];
  while (queue.length > 0 && found.length < max && budget > 0) {
    const next = queue.shift();
    if (!next) break;
    let entries;
    try {
      entries = await readdir(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = new Set(entries.map((e) => e.name.toLowerCase()));
    for (const entry of entries) {
      if (budget-- <= 0 || found.length >= max) break;
      if (isIgnoredName(entry.name)) continue;
      const rel = [...next.rel, entry.name];
      if (entry.isDirectory()) {
        if (rel.length < maxDepth) queue.push({ dir: path.join(next.dir, entry.name), rel });
        continue;
      }
      if (!entry.isFile()) continue; // links are not followed
      const suggested = suggestedPageName(entry.name);
      // A rename never replaces anything: a suggestion whose name is taken is not offered.
      if (suggested === null || names.has(suggested.toLowerCase())) continue;
      if (!(await startsLikeHtml(path.join(next.dir, entry.name)))) continue;
      found.push({ path: rel.join('/'), suggested: [...next.rel, suggested].join('/') });
    }
  }
  return found;
}

async function startsLikeHtml(file: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return false;
    const buffer = Buffer.alloc(Math.min(HEAD_BYTES, info.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return looksLikeHtml(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
