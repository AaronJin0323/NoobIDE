import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileOpError } from '../shared/ipc/contract';
import { sameName } from '../shared/file-names';
import { importRefusal, type ImportKind, type ImportRefusal } from '../shared/import-rules';
import { err, ok, type Result } from '../shared/result';
import { COPY_LIMITS, checkName, copyNew, opErrorCode, realCopyFs, type CopyFs } from './file-ops';
import { errorCode, relativeToRoot, resolveExisting } from './paths';

/**
 * S52.4/S52.5: adding files and folders from outside the project (the native "Add files…"/"Add image…" dialog, a
 * drop from Explorer/Finder). Main process only. The outside entries are only ever read; they are copied (never
 * linked or moved) into a folder of the project that is realpath-checked inside the root, under a name that passes
 * the Windows and macOS rules and is not taken (ignoring case): an existing entry is never overwritten — the user
 * renames or skips instead.
 */
export interface ImportSource {
  /** Absolute path of the entry outside the project, as the OS dialog or the drop gave it. */
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'other';
  /** File size, or the total of a folder's files (counting stops past the copy limits). */
  readonly bytes: number;
  readonly refusal: ImportRefusal | null;
  /** For `contains-refused` / `contains-too-large`: the path inside the folder that causes it. */
  readonly detail?: string;
}

/**
 * A folder's files, counted without following links; stops at the copy limits or at the first program, script or
 * shortcut, or file over the per-file cap (a folder is added whole or not at all).
 */
async function scanFolder(
  dir: string,
): Promise<{ entries: number; bytes: number; refusal: ImportRefusal | null; detail?: string }> {
  const total = { entries: 0, bytes: 0 };
  let found: { refusal: ImportRefusal; detail: string } | null = null;
  const walk = async (p: string, rel: string): Promise<void> => {
    if (found || total.entries > COPY_LIMITS.maxEntries || total.bytes > COPY_LIMITS.maxBytes) return;
    const info = await lstat(p);
    if (info.isSymbolicLink()) return; // not copied (copyNew skips links)
    total.entries += 1;
    if (info.isDirectory()) {
      for (const child of await readdir(p)) await walk(path.join(p, child), rel === '' ? child : `${rel}/${child}`);
      return;
    }
    if (!info.isFile()) return;
    total.bytes += info.size;
    const inner = importRefusal({ name: path.basename(p), kind: 'file', bytes: info.size }, 'files');
    if (inner === 'refused-type') found = { refusal: 'contains-refused', detail: rel };
    else if (inner === 'too-large') found = { refusal: 'contains-too-large', detail: rel };
  };
  await walk(dir, '');
  const over = total.entries > COPY_LIMITS.maxEntries || total.bytes > COPY_LIMITS.maxBytes;
  const result: { entries: number; bytes: number; refusal: ImportRefusal | null; detail?: string } = {
    ...total,
    refusal: over ? 'too-large' : ((found as { refusal: ImportRefusal } | null)?.refusal ?? null),
  };
  if (!over && found) result.detail = (found as { detail: string }).detail;
  return result;
}

/** Looks at the chosen or dropped entries without following links; nothing is read beyond their sizes. */
export async function inspectSources(paths: readonly string[], kind: ImportKind): Promise<ImportSource[]> {
  const out: ImportSource[] = [];
  for (const p of paths) {
    const name = path.basename(p);
    let entryKind: ImportSource['kind'] = 'other';
    let bytes = 0;
    try {
      const info = await lstat(p);
      if (info.isFile()) {
        entryKind = 'file';
        bytes = info.size;
      } else if (info.isDirectory()) {
        entryKind = 'directory';
        const own = importRefusal({ name, kind: entryKind, bytes: 0 }, kind);
        if (own === null) {
          const scan = await scanFolder(p);
          bytes = scan.bytes;
          if (scan.refusal !== null) {
            out.push({
              path: p,
              name,
              kind: entryKind,
              bytes,
              refusal: scan.refusal,
              ...(scan.detail ? { detail: scan.detail } : {}),
            });
            continue;
          }
        }
      }
    } catch {
      entryKind = 'other';
    }
    out.push({ path: p, name, kind: entryKind, bytes, refusal: importRefusal({ name, kind: entryKind, bytes }, kind) });
  }
  return out;
}

/**
 * Copies one outside entry into `toFolder` (`''` is the project root) as `name`. Refused (with the existing name)
 * when the folder already has that name or one differing only in case; the outside entry is checked again (it may
 * have changed since it was chosen).
 */
export async function importEntry(
  root: string,
  source: string,
  toFolder: string,
  name: string,
  kind: ImportKind,
  fs: CopyFs = realCopyFs,
): Promise<Result<{ relPath: string; skippedLinks: number }, FileOpError | ImportRefusal>> {
  const named = checkName(name);
  if (!named.ok) return named;
  const now = (await inspectSources([source], kind))[0];
  if (!now) return err('not-a-file', '');
  if (now.refusal !== null) return err(now.refusal, now.name);
  // A new name is checked by the same rules (a `.png` renamed for "Add image…" must still be an image).
  const renamed = importRefusal({ name, kind: now.kind, bytes: now.bytes }, kind);
  if (renamed !== null) return err(renamed, name);
  const dest = await resolveExisting(root, toFolder);
  if (!dest.ok) return err(dest.code, dest.message);
  const real = relativeToRoot(root, dest.path);
  if (real === null) return err('outside-project', 'destination leaves the project');
  let names: string[];
  try {
    if (!(await stat(dest.path)).isDirectory()) return err('not-a-folder', toFolder);
    names = await readdir(dest.path);
  } catch (e) {
    return err(opErrorCode(e), errorCode(e), e);
  }
  const taken = names.find((n) => sameName(n, name, false));
  if (taken !== undefined) {
    return taken.normalize('NFC') === name.normalize('NFC') ? err('exists', taken) : err('case-conflict', taken);
  }
  // The project folder itself must not be copied into itself (a drop of the project folder or one of its parents).
  const sourceReal = await realpath(source).catch(() => source);
  if (sourceReal === dest.path || isAncestor(sourceReal, dest.path)) return err('into-itself', name);
  const target = path.join(dest.path, name);
  const copied = await copyNew(source, target, fs);
  if (!copied.ok) return copied;
  // The source became a link after it was checked: copyNew skipped it, so nothing was added.
  const made = await lstat(target).catch(() => null);
  if (!made) return err('not-a-file', name);
  return ok({ relPath: real === '' ? name : `${real}/${name}`, skippedLinks: copied.value.skippedLinks });
}

function isAncestor(ancestor: string, p: string): boolean {
  const rel = path.relative(ancestor, p);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
