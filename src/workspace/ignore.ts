/**
 * Names the file tree and the watcher skip (S07.2). Dotfiles are hidden from beginners (and denied by the preview
 * server); dependency folders are huge and not part of a hand-written page; OS litter and NoobIDE's own atomic-save
 * temporaries are never the user's work.
 */
const IGNORED_NAMES = new Set(['node_modules', 'Thumbs.db', 'desktop.ini', '$RECYCLE.BIN']);

export function isIgnoredName(name: string): boolean {
  return name.startsWith('.') || IGNORED_NAMES.has(name) || name.endsWith('.noobide-tmp');
}

/** True when any segment of a portable relative path is ignored (watcher events inside node_modules, .git…). */
export function isIgnoredRelPath(relPath: string): boolean {
  return relPath.split('/').some(isIgnoredName);
}
