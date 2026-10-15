/**
 * S22.5: how a one-click fix reaches the file — the same path as typing (AGENTS.md "user data is sacred"):
 * 1. the file is opened (or shown) through the workbench's normal editor path;
 * 2. the replacement goes into the file's editor model as one undo step, only if the span still reads the misspelled
 *    name (otherwise nothing changes);
 * 3. the new text goes to the file's own save pipeline (DocumentSaver: atomic temp file + rename in main). A failed
 *    save leaves the edit in the editor and in the saver, exactly like a failed save of typed text.
 *
 * Monaco is reached through `editor` (dynamically imported by default), so the sequence is unit-tested with fakes.
 */
import type { SaveSnapshot } from '../workbench/save-machine';
import type { SavedFileEvents } from '../workbench/saved-file-events';
import type { FixState, ReplaceTextAction } from './fix-model';
import type { SpanEditResult } from './rule-context-monaco';
import type { ApplyOutcome, FixHost, UndoOutcome } from './useProblemFix';

export interface FixSaver {
  readonly text: string;
  readonly state: SaveSnapshot;
  edit(text: string): void;
  save(): Promise<boolean>;
}

export interface FixEditor {
  waitForModel(uri: string): Promise<unknown>;
  replaceSpan(uri: string, span: ReplaceTextAction['span'], from: string, to: string): SpanEditResult;
  undoSpan(uri: string, span: ReplaceTextAction['span'], from: string, to: string, version: number): SpanEditResult;
  stillReportsUndefinedName(uri: string, line: number, name: string): Promise<boolean | null>;
}

export interface FixHostDeps {
  /** Opens the file in a tab (or shows its tab) and resolves with it once it is in the workbench state. */
  showFile(relPath: string): Promise<{ readonly uri: string; readonly readOnly: boolean } | null>;
  saverOf(relPath: string): FixSaver | undefined;
  uriOf(relPath: string): string | undefined;
  savedFiles: Pick<SavedFileEvents, 'subscribe'>;
  editor?: () => Promise<FixEditor>;
}

const defaultEditor = async (): Promise<FixEditor> => {
  const [models, edits] = await Promise.all([import('../editor/editor-models'), import('./rule-context-monaco')]);
  return {
    waitForModel: models.waitForModel,
    replaceSpan: edits.replaceSpan,
    undoSpan: edits.undoSpan,
    stillReportsUndefinedName: edits.stillReportsUndefinedName,
  };
};

const saveErrorOf = (saver: FixSaver): string =>
  saver.state.error?.code ?? (saver.state.conflict ? 'changed-on-disk' : saver.state.deleted ? 'not-found' : 'unknown');

export function createFixHost(deps: FixHostDeps): FixHost {
  const editor = deps.editor ?? defaultEditor;
  /** Hands the model's new text to the save pipeline and saves; the editor's change listener may already have. */
  const save = async (saver: FixSaver, text: string): Promise<boolean> => {
    if (saver.text !== text) saver.edit(text);
    return saver.save();
  };
  return {
    async apply(action): Promise<ApplyOutcome> {
      const { file } = action.span;
      const tab = await deps.showFile(file);
      const saver = deps.saverOf(file);
      if (!tab || !saver) return { kind: 'not-applied', reason: 'not-open' };
      if (tab.readOnly) return { kind: 'not-applied', reason: 'read-only' };
      const ed = await editor();
      if (!(await ed.waitForModel(tab.uri))) return { kind: 'not-applied', reason: 'not-open' };
      const result = ed.replaceSpan(tab.uri, action.span, action.from, action.to);
      if (!result.ok) return { kind: 'not-applied', reason: result.reason === 'changed' ? 'changed' : 'not-open' };
      if (await save(saver, result.text)) return { kind: 'applied', version: result.version };
      return { kind: 'save-failed', version: result.version, code: saveErrorOf(saver) };
    },
    async undo(fix: FixState): Promise<UndoOutcome> {
      const { span, from, to } = fix.action;
      const uri = deps.uriOf(span.file);
      const saver = deps.saverOf(span.file);
      if (!uri || !saver || fix.version === undefined) return { kind: 'changed' };
      const result = (await editor()).undoSpan(uri, span, from, to, fix.version);
      if (!result.ok) return { kind: 'changed' };
      return (await save(saver, result.text)) ? { kind: 'undone' } : { kind: 'save-failed', code: saveErrorOf(saver) };
    },
    async retrySave(relPath) {
      const saver = deps.saverOf(relPath);
      if (!saver) return { ok: false, code: 'not-found' };
      return (await saver.save()) ? { ok: true } : { ok: false, code: saveErrorOf(saver) };
    },
    async stillReported(fix) {
      const uri = deps.uriOf(fix.action.span.file);
      if (!uri) return null;
      return (await editor()).stillReportsUndefinedName(uri, fix.action.span.line, fix.action.from);
    },
    onSaved(listener) {
      return deps.savedFiles.subscribe((file) => listener(file.relPath));
    },
  };
}
