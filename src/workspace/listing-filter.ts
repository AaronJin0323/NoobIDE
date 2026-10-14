/**
 * Which directory entries belong to a beginner's page: shared by the project listing and by local history's
 * before-delete snapshots (S21.2), so history never copies what the listing hides.
 *
 * - Dotfiles and dot-folders (`.git`, `.noobide`, `.env`, editor temp files) are not part of the page and may hold
 *   secrets.
 * - Dependency folders are huge and not part of a beginner's page.
 */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules']);

export function isListedEntry(name: string, isDirectory: boolean): boolean {
  if (name.startsWith('.')) return false;
  return !(isDirectory && SKIPPED_DIRS.has(name));
}
