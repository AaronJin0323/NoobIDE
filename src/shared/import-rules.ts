import { IMAGE_EXTENSIONS, isImagePath } from './image-files';

/**
 * S52.4/S52.5: what may be added to a project from outside it ("Add files…", "Add image…", a drop from Explorer or
 * Finder). Pure, used by main (which decides) and by the renderer (which explains). Files are always copied, never
 * linked or moved, and never over an existing entry.
 */

/** Largest single file that is added (bytes). Folders are bounded by the copy limits (file-ops COPY_LIMITS). */
export const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Programs, scripts that run on the computer and shortcuts: a web project never needs them, and a beginner should
 * not end up with one inside a page folder by mistake.
 */
export const REFUSED_IMPORT_EXTENSIONS = [
  '.exe',
  '.msi',
  '.bat',
  '.cmd',
  '.com',
  '.scr',
  '.ps1',
  '.vbs',
  '.lnk',
  '.url',
  '.dll',
  '.sys',
  '.app',
  '.dmg',
  '.pkg',
  '.command',
] as const;

export type ImportKind = 'files' | 'image';

export type ImportRefusal =
  /** Over MAX_IMPORT_FILE_BYTES (a file) or the copy limits (a folder). */
  | 'too-large'
  /** A program, script or shortcut (REFUSED_IMPORT_EXTENSIONS). */
  | 'refused-type'
  /** "Add image…" takes images only. */
  | 'not-an-image'
  /** A link, a device or anything that is neither a regular file nor a folder. */
  | 'not-a-file'
  /** A folder holding a program, script or shortcut (named in the candidate's `detail`). */
  | 'contains-refused'
  /** A folder holding a file over MAX_IMPORT_FILE_BYTES (named in `detail`). */
  | 'contains-too-large';

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** Why an entry from outside cannot be added; null when it can (its name may still need a rename). */
export function importRefusal(
  entry: { readonly name: string; readonly kind: 'file' | 'directory' | 'other'; readonly bytes: number },
  kind: ImportKind,
): ImportRefusal | null {
  if (entry.kind === 'other') return 'not-a-file';
  if (kind === 'image' && (entry.kind !== 'file' || !isImagePath(entry.name))) return 'not-an-image';
  // Folders too: on macOS an `.app` or `.pkg` is a folder (a bundle) that the open dialog lets the user pick.
  if ((REFUSED_IMPORT_EXTENSIONS as readonly string[]).includes(extensionOf(entry.name))) return 'refused-type';
  if (entry.kind === 'file' && entry.bytes > MAX_IMPORT_FILE_BYTES) return 'too-large';
  return null;
}

/** The image endings "Add image…" offers in the native dialog (without the dot). */
export const IMAGE_DIALOG_EXTENSIONS: readonly string[] = IMAGE_EXTENSIONS.map((e) => e.slice(1));
