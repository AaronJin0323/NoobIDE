import { monaco } from './monaco-setup';
import { ModelRegistry, type ModelSpec } from './model-registry';
import { changedRegion } from './changed-region';

/**
 * The Monaco text models of open files (S09.1): one per URI, shared by every editor mount, released when its tab
 * closes. Loaded with the editor chunk; the workbench reaches it with a dynamic import so Monaco stays lazy.
 */
export const models = new ModelRegistry<monaco.editor.ITextModel, monaco.editor.ICodeEditorViewState>({
  find: (uri) => monaco.editor.getModel(monaco.Uri.parse(uri)),
  create: (spec: ModelSpec) => {
    // The text arrives in the file's own line ending, so creating the model is not an edit and nothing about the
    // loaded buffer is on the undo stack.
    const text = spec.eol ? spec.text.replace(/\r?\n/g, spec.eol) : spec.text;
    const model = monaco.editor.createModel(text, spec.language, monaco.Uri.parse(spec.uri));
    const eol = spec.eol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF;
    // Only a text without line breaks can come out with the other line ending (Monaco then uses the OS default).
    if (spec.eol && model.getEOL() !== spec.eol) model.setEOL(eol);
    model.pushStackElement();
    return model;
  },
  discard: (model) => {
    // Monaco keeps the undo stack of a disposed `file:` model and restores it when a model with the same text is
    // created again. A closed tab must start fresh (S09.1), so the stack is cleared before disposal.
    model.setValue('');
    model.dispose();
  },
});

/** A tab closed: its model, undo stack and view state go. */
export function releaseModel(uri: string): void {
  models.release(uri);
}

/** The project closed: release every file model (the sample keeps its in-memory model). */
export function releaseFileModels(): void {
  models.retainOnly(models.uris().filter((uri) => !uri.startsWith('file:')));
}

// ── S11: a file changed outside NoobIDE ──
/**
 * Puts `text` (the new disk version) into the open model of `uri` as one undoable edit that replaces only the lines
 * that differ, so the cursor, selections and scroll position stay where they are whenever they lie outside the
 * changed region (S11.1). Returns the model's new value, or `null` when the file has no model (not shown yet).
 */
export function replaceModelText(uri: string, text: string, eol: '\n' | '\r\n'): string | null {
  const model = models.get(uri);
  if (!model) return null;
  const wanted = eol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF;
  if (model.getEOL() !== eol) model.pushEOL(wanted);
  const next = text.replace(/\r?\n/g, eol);
  const current = model.getValue();
  if (current === next) return current;
  const { start, endCurrent, endNext } = changedRegion(current, next);
  const range = monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(endCurrent));
  model.pushStackElement();
  model.pushEditOperations([], [{ range, text: next.slice(start, endNext) }], () => null);
  model.pushStackElement();
  return model.getValue();
}
