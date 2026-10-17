/**
 * Applying a cross-file rename (S57.2) through the save pipeline. Pure orchestration over a host, so the order and
 * every failure path are integration- and fault-tested with real savers on a real folder.
 *
 * 1. Every file is opened in a tab (a closed one is read from disk) and checked first: if any file is not exactly the
 *    text the preview was computed from (changed on disk or edited since), or cannot be changed (a conflict, a deleted
 *    or read-only file), nothing is changed at all and the outcome says which file and why. A half-renamed name would
 *    break the page.
 * 2. Each file's new text goes in as one undoable edit of its tab (so Ctrl/Cmd+Z in that tab undoes it there), then
 *    through the file's own saver (atomic write, "changed on disk" check). A save that fails keeps the edit in the tab,
 *    with the tab's own explanation; the other files are still saved.
 */
export interface RenameFile {
  readonly relPath: string;
  /** The text the preview was computed from, and the text after the rename. */
  readonly before: string;
  readonly after: string;
}

export interface OpenedFile {
  /** The tab's current text. */
  readonly text: string;
  /** A conflict with the disk, a deleted file, a read-only (other encoding) or locked file. */
  readonly blocked: boolean;
}

export interface RenameHost {
  /** Opens the file's tab (in the background when it was closed); null when it cannot be opened. */
  open(relPath: string): Promise<OpenedFile | null>;
  /** Replaces the tab's text as one undoable edit, if it is still `before`; false otherwise (also used to revert). */
  replace(relPath: string, before: string, after: string): Promise<boolean>;
  /** The tab's saver: true once the new text is on disk. */
  save(relPath: string): Promise<boolean>;
}

export type FileStatus =
  /** Renamed and saved. */
  | 'renamed'
  /** Renamed in the tab; the save failed, so the edit is kept there (the tab says why). */
  | 'save-failed'
  /** Not touched: the file changed since the preview (on disk or in the editor). */
  | 'changed'
  /** Not touched: the file cannot be changed now (conflict, deleted, read-only). */
  | 'blocked'
  /** Not touched: the file could not be opened. */
  | 'unreadable'
  /** Not touched because another file was refused. */
  | 'skipped';

export interface RenameOutcome {
  /** True when every file was renamed (saves may still have failed: see `files`). */
  readonly applied: boolean;
  readonly files: readonly { readonly relPath: string; readonly status: FileStatus }[];
}

const sameText = (a: string, b: string) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

export async function applyRename(files: readonly RenameFile[], host: RenameHost): Promise<RenameOutcome> {
  // 1. Check every file before changing any.
  const refused = new Map<string, FileStatus>();
  for (const file of files) {
    const opened = await host.open(file.relPath);
    if (!opened) refused.set(file.relPath, 'unreadable');
    else if (opened.blocked) refused.set(file.relPath, 'blocked');
    else if (!sameText(opened.text, file.before)) refused.set(file.relPath, 'changed');
  }
  if (refused.size > 0) {
    return {
      applied: false,
      files: files.map((f) => ({ relPath: f.relPath, status: refused.get(f.relPath) ?? 'skipped' })),
    };
  }
  // 2. Replace all (one undo step per tab). A file that changed meanwhile (typed into, reloaded from disk) stops the
  // rename: the files replaced so far get their text back, and nothing has been saved yet.
  const replaced: RenameFile[] = [];
  for (const file of files) {
    if (await host.replace(file.relPath, file.before, file.after)) {
      replaced.push(file);
      continue;
    }
    for (const done of replaced) await host.replace(done.relPath, done.after, done.before);
    return {
      applied: false,
      files: files.map((f) => ({ relPath: f.relPath, status: f === file ? 'changed' : 'skipped' })),
    };
  }
  // 3. Save each through its own saver.
  const outcomes: { relPath: string; status: FileStatus }[] = [];
  for (const file of files) {
    const status = refused.get(file.relPath);
    if (status) outcomes.push({ relPath: file.relPath, status });
    else outcomes.push({ relPath: file.relPath, status: (await host.save(file.relPath)) ? 'renamed' : 'save-failed' });
  }
  return { applied: true, files: outcomes };
}
