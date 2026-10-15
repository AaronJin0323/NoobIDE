import { isSameOrBelow } from './file-tree-model';

/**
 * Whether an open file's text may be changed by an AI edit right now: not when its tab is read-only (another encoding,
 * a read-only file), and not while the file — or a folder holding it — is being renamed, moved or trashed (S08: the
 * tab's edits were saved first and the operation is running; a change applied now would land in a file that is about
 * to move or go to the trash).
 */
export function editBlocked(
  relPath: string,
  tab: { readonly content: { readonly readOnly?: boolean | undefined } } | undefined,
  lockedPaths: readonly string[],
): boolean {
  if (tab?.content.readOnly) return true;
  return lockedPaths.some((locked) => isSameOrBelow(relPath, locked));
}
