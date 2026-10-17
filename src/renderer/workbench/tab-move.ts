import type { FileContent } from '../../shared/ipc/contract';
import type { JournalBuffer, JournalScheduler } from '../recovery/journal-scheduler';
import type { DocumentSaver } from './save-controller';
import { isUnsaved } from './save-machine';

/**
 * S52.1: an open file was renamed or moved (by NoobIDE, or outside it with the same content): its tab follows to the
 * new path. Pure orchestration over injected workbench parts, so the rules are unit-tested with the real saver and
 * journal scheduler:
 *
 * - The tab keeps its place and stays visible; the editor model gets the new uri (its undo history starts afresh).
 * - A new saver starts from the disk version at the new path; unsaved text moves with it as unsaved edits, so the
 *   dirty state follows and autosave writes it to the new path, never to the old one.
 * - The journal continues the same buffer record (main moved it for a NoobIDE move) with a higher revision. After a
 *   move made outside NoobIDE the old record is removed only once the copy under the new path is written.
 * - If the new path cannot be read, nothing is re-keyed: the old tab is checked against the disk (kept with its
 *   text and marked deleted if its file is gone).
 */
export interface TabMoveDeps {
  saverOf(relPath: string): DocumentSaver | undefined;
  journalOf(relPath: string): Pick<JournalScheduler, 'current'> | undefined;
  /** The tab's model uri, or undefined when no tab is open at that path. */
  uriOf(relPath: string): string | undefined;
  read(relPath: string): Promise<FileContent | null>;
  /** Disposes the old saver and releases its journal scheduler (the journal record itself stays). */
  forget(relPath: string): void;
  /** Creates (and registers) the saver and journal scheduler of the moved tab. */
  create(
    relPath: string,
    disk: FileContent,
    journal: { bufferId: string; baseRevision: number } | undefined,
  ): {
    saver: DocumentSaver;
    journal: Pick<JournalScheduler, 'edited' | 'flush'> | undefined;
  };
  /** The tab moved: `content.text` is what its editor model starts with. */
  moved(from: string, to: string, content: FileContent, saver: DocumentSaver): void;
  releaseModel(uri: string): void;
  /** Re-checks a tab against the disk (S11). */
  check(relPath: string): void;
  /** Removes the old path's crash copy of `buffer` up to `revision`. */
  discardOld(from: string, buffer: JournalBuffer, revision: number): Promise<void>;
  /** False once the project changed meanwhile. */
  stillCurrent(): boolean;
}

export type TabMoveOutcome = 'moved' | 'not-open' | 'unreadable' | 'superseded';

/**
 * `content` is the disk version at `to` when the caller already read it (the watcher replay); otherwise it is read.
 * `external`: the move was made outside NoobIDE, so the buffer's crash copy is still under the old path.
 */
export async function moveTab(
  deps: TabMoveDeps,
  from: string,
  to: string,
  options: { readonly content?: FileContent; readonly external?: boolean } = {},
): Promise<TabMoveOutcome> {
  const saver = deps.saverOf(from);
  const uri = deps.uriOf(from);
  if (!saver || uri === undefined || from === to) return 'not-open';
  const disk = options.content ?? (await deps.read(to));
  if (deps.saverOf(from) !== saver || !deps.stillCurrent()) return 'superseded';
  if (!disk || deps.saverOf(to)) {
    // Unreadable, or another tab is open at the new path already: the old tab is checked (kept, marked if gone).
    deps.check(from);
    return disk ? 'superseded' : 'unreadable';
  }
  const text = saver.text;
  const carry = (isUnsaved(saver.state) || saver.state.deleted) && text !== disk.text;
  const buffer = deps.journalOf(from)?.current ?? null;
  const revision = saver.state.revision;
  deps.forget(from);
  const next = deps.create(
    to,
    disk,
    buffer ? { bufferId: buffer.bufferId, baseRevision: buffer.baseRevision + revision } : undefined,
  );
  deps.moved(from, to, carry ? { ...disk, text } : disk, next.saver);
  deps.releaseModel(uri);
  if (!carry) return 'moved';
  next.saver.edit(text);
  next.journal?.edited(next.saver.state.revision, () => next.saver.text);
  if (options.external && buffer && next.journal) {
    // Never before the copy under the new name is in the journal: a failed write keeps the old copy.
    if (await next.journal.flush()) await deps.discardOld(from, buffer, buffer.baseRevision + revision);
  }
  return 'moved';
}
