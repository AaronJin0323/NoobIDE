/**
 * S22.5 / S55.3: how a fix reaches the file — the same path as typing (AGENTS.md "user data is sacred"):
 * 1. the file is opened (or shown) through the workbench's normal editor path;
 * 2. the change goes into the file's editor model as one undo step, only if the span still reads what the fix expects
 *    (otherwise nothing changes);
 * 3. the new text goes to the file's own save pipeline (DocumentSaver: atomic temp file + rename in main). A failed
 *    save leaves the edit in the editor and in the saver, exactly like a failed save of typed text.
 *
 * S55.3 "create the missing file": the file is created empty and exclusively (createEntry never replaces anything),
 * then the template goes into its empty editor model as an ordinary edit (step 2) and is saved (step 3). If anything
 * exists at that path, nothing is created or changed.
 *
 * Monaco is reached through `editor` (dynamically imported by default), so the sequence is unit-tested with fakes.
 */
import type { ProblemRecord } from '../../shared/problem';
import type { SaveSnapshot } from '../workbench/save-machine';
import type { SavedFileEvents } from '../workbench/saved-file-events';
import { newFileTemplate, type TemplateLocale } from './file-templates';
import { fixFile, isNameFix, problemSite, type FixAction, type FixState, type ReplaceTextAction } from './fix-model';
import type { SpanEditResult } from './rule-context-monaco';
import type { ApplyOutcome, FixHost, UndoOutcome } from './useProblemFix';

export interface FixSaver {
  readonly text: string;
  readonly state: SaveSnapshot;
  save(): Promise<boolean>;
}

type Match = 'identifier' | 'exact';

export interface FixEditor {
  waitForModel(uri: string): Promise<unknown>;
  replaceSpan(uri: string, span: ReplaceTextAction['span'], from: string, to: string, match?: Match): SpanEditResult;
  undoSpan(
    uri: string,
    span: ReplaceTextAction['span'],
    from: string,
    to: string,
    version: number,
    match?: Match,
  ): SpanEditResult;
  /** S55.3: puts `text` into the model of a just-created file — only while it is still empty. */
  fillEmpty(uri: string, text: string): SpanEditResult;
  /** S55.3: takes the template out again (the editor's undo while nothing changed since; else only if unchanged). */
  emptyAgain(uri: string, text: string, version: number): SpanEditResult;
  stillReportsUndefinedName(uri: string, line: number, name: string): Promise<boolean | null>;
  /** S55.3: runs the beginner checks on the open file again; `extraFiles` exist although the index may lag. */
  stillReportsBeginner(uri: string, record: ProblemRecord, extraFiles: readonly string[]): Promise<boolean | null>;
  /**
   * S55.3, right before a quick fix edits: do the beginner checks, run on the file's current text, still report
   * exactly this finding at exactly its column? (The markers lag behind typing, so the card or the lightbulb may
   * offer a fix for a problem the user has just removed.) Null when the file is not open in the project.
   */
  reportsNow(uri: string, record: ProblemRecord): boolean | null;
}

export type CreateFileResult = { readonly ok: true } | { readonly ok: false; readonly code: string };

export interface FixHostDeps {
  /** Opens the file in a tab (or shows its tab) and resolves with it once it is in the workbench state. */
  showFile(relPath: string): Promise<{ readonly uri: string; readonly readOnly: boolean } | null>;
  saverOf(relPath: string): FixSaver | undefined;
  /**
   * Records an edit of an open file like a typed one: save pipeline, recovery journal, disk-notice dismissal. Needed
   * because the editor reports changes only for the model it shows — a fix in a background tab is not seen by it.
   */
  recordEdit(relPath: string, text: string): void;
  uriOf(relPath: string): string | undefined;
  savedFiles: Pick<SavedFileEvents, 'subscribe'>;
  /** S55.3: creates an empty file, never replacing anything (workspace createEntry); `exists` when something is there. */
  createFile?(relPath: string): Promise<CreateFileResult>;
  /** S55.3: the UI locale, for the comment in a created file's template. */
  locale?(): TemplateLocale;
  editor?: () => Promise<FixEditor>;
}

const defaultEditor = async (): Promise<FixEditor> => {
  const [models, edits, beginner] = await Promise.all([
    import('../editor/editor-models'),
    import('./rule-context-monaco'),
    import('./beginner-checks-monaco'),
  ]);
  return {
    waitForModel: models.waitForModel,
    replaceSpan: edits.replaceSpan,
    undoSpan: edits.undoSpan,
    fillEmpty: edits.fillEmpty,
    emptyAgain: edits.emptyAgain,
    stillReportsUndefinedName: edits.stillReportsUndefinedName,
    stillReportsBeginner: beginner.stillReportsBeginner,
    reportsNow: beginner.reportsNow,
  };
};

const saveErrorOf = (saver: FixSaver): string =>
  saver.state.error?.code ?? (saver.state.conflict ? 'changed-on-disk' : saver.state.deleted ? 'not-found' : 'unknown');

export function createFixHost(deps: FixHostDeps): FixHost {
  const editor = deps.editor ?? defaultEditor;
  /**
   * Records the model's new text (unless the editor's change listener already did, for the file it shows) and saves
   * it through the file's own pipeline. False when the tab's saver is no longer `saver` (closed, project reopened).
   */
  const save = async (relPath: string, saver: FixSaver, text: string): Promise<boolean> => {
    if (deps.saverOf(relPath) !== saver) return false;
    if (saver.text !== text) deps.recordEdit(relPath, text);
    return saver.save();
  };
  const templateOf = (action: Extract<FixAction, { kind: 'create-file' }>) =>
    newFileTemplate(action, deps.locale?.() ?? 'zh-CN');
  /** The quick fix's problem is no longer reported exactly where the rule saw it: nothing may change. */
  const stale = (ed: FixEditor, record: ProblemRecord | undefined, file: string): boolean => {
    const uri = deps.uriOf(file);
    return Boolean(record && uri && ed.reportsNow(uri, record) === false);
  };
  return {
    async apply(action, record): Promise<ApplyOutcome> {
      const file = fixFile(action);
      if (action.kind === 'create-file') {
        if (!deps.createFile) return { kind: 'not-applied', reason: 'not-open' };
        if (stale(await editor(), record, action.problemFile)) return { kind: 'not-applied', reason: 'changed' };
        const created = await deps.createFile(file);
        if (!created.ok) {
          return created.code === 'exists'
            ? { kind: 'not-applied', reason: 'exists' }
            : { kind: 'not-applied', reason: 'create-failed', code: created.code };
        }
      }
      // After creating, "could not open" means an empty new file exists: the card says so.
      const notOpen = action.kind === 'create-file' ? 'created-empty' : 'not-open';
      const tab = await deps.showFile(file);
      const saver = deps.saverOf(file);
      if (!tab || !saver) return { kind: 'not-applied', reason: notOpen };
      if (tab.readOnly) return { kind: 'not-applied', reason: action.kind === 'create-file' ? notOpen : 'read-only' };
      const ed = await editor();
      if (!(await ed.waitForModel(tab.uri))) return { kind: 'not-applied', reason: notOpen };
      // Every await above may have let the tab close or the project change: the edit goes only into the same buffer.
      if (deps.saverOf(file) !== saver || deps.uriOf(file) !== tab.uri) return { kind: 'not-applied', reason: notOpen };
      if (action.kind === 'replace-text' && !isNameFix(action) && stale(ed, record, file)) {
        return { kind: 'not-applied', reason: 'changed' };
      }
      const result =
        action.kind === 'create-file'
          ? ed.fillEmpty(tab.uri, templateOf(action))
          : ed.replaceSpan(tab.uri, action.span, action.from, action.to, action.match);
      if (!result.ok) {
        if (action.kind === 'create-file') return { kind: 'not-applied', reason: 'created-empty' };
        return { kind: 'not-applied', reason: result.reason === 'changed' ? 'changed' : 'not-open' };
      }
      if (await save(file, saver, result.text)) return { kind: 'applied', version: result.version };
      return { kind: 'save-failed', version: result.version, code: saveErrorOf(saver) };
    },
    async undo(fix: FixState): Promise<UndoOutcome> {
      const { action } = fix;
      const file = fixFile(action);
      const uri = deps.uriOf(file);
      const saver = deps.saverOf(file);
      if (!uri || !saver || fix.version === undefined) return { kind: 'changed' };
      const ed = await editor();
      if (deps.saverOf(file) !== saver || deps.uriOf(file) !== uri) return { kind: 'changed' };
      const result =
        action.kind === 'create-file'
          ? ed.emptyAgain(uri, templateOf(action), fix.version)
          : ed.undoSpan(uri, action.span, action.from, action.to, fix.version, action.match);
      if (!result.ok) return { kind: 'changed' };
      return (await save(file, saver, result.text))
        ? { kind: 'undone' }
        : { kind: 'save-failed', code: saveErrorOf(saver) };
    },
    async retrySave(relPath) {
      const saver = deps.saverOf(relPath);
      if (!saver) return { ok: false, code: 'not-found' };
      return (await saver.save()) ? { ok: true } : { ok: false, code: saveErrorOf(saver) };
    },
    async stillReported(fix) {
      const { action } = fix;
      if (isNameFix(action)) {
        const uri = deps.uriOf(action.span.file);
        if (!uri) return null;
        return (await editor()).stillReportsUndefinedName(uri, action.span.line, action.from);
      }
      // A quick fix: the beginner checks look at the file that reports the problem (for a created file: the page
      // that refers to it, with the new file counted even if the project's file list has not caught up yet).
      const uri = deps.uriOf(problemSite(action).file);
      if (!uri) return null;
      const extra = action.kind === 'create-file' ? [action.path] : [];
      return (await editor()).stillReportsBeginner(uri, fix.record, extra);
    },
    onSaved(listener) {
      return deps.savedFiles.subscribe((file) => listener(file.relPath));
    },
  };
}
