/**
 * Facts the explanation rules need about one problem location, read from the open file's editor model and the
 * JavaScript language service (S22.4/S22.5). Loaded with a dynamic import (Monaco stays in its own chunk).
 *
 * The line text is source code: it stays in memory for the rule and is never logged or put in a record.
 */
import { getJavaScriptWorker } from 'monaco-editor/languages/features/typescript/register';
import { monaco } from '../editor/monaco-setup';
import type { RuleContext } from '../../diagnostics/rules';
import { locateIdentifier } from '../../diagnostics/text';
import {
  declaredFromCompletions,
  soleDeclarationOffset,
  toDeclaredNames,
  type CompletionEntryLike,
  type NavigationItemLike,
} from './declared-names';
import { holdsText } from './fix-model';

/** The language service must answer within this time, or the card is shown without did-you-mean names. */
const WORKER_TIMEOUT_MS = 4000;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);

const modelOf = (uri: string) => monaco.editor.getModel(monaco.Uri.parse(uri));

/**
 * The rule context for a problem at `line`/`column` of the open file `uri` (project-relative `file`). `name` is the
 * undefined name the problem reports, when it is one: then the names declared in scope there are looked up.
 * Returns an empty context when the file has no model (not open) or the line no longer exists.
 */
export async function gatherRuleContext(
  uri: string,
  file: string,
  line: number,
  column: number | undefined,
  name: string | null,
): Promise<RuleContext> {
  const model = modelOf(uri);
  if (!model || line < 1 || line > model.getLineCount()) return {};
  const lineText = model.getLineContent(line);
  if (!name || model.getLanguageId() !== 'javascript') return { lineText };
  const at = locateIdentifier(lineText, name, column) ?? column ?? 1;
  try {
    const declared = await withTimeout(
      (async () => {
        const getClient = await getJavaScriptWorker();
        const client = await getClient(model.uri);
        const fileName = model.uri.toString();
        const offset = model.getOffsetAt({ lineNumber: line, column: at });
        const completions = (await client.getCompletionsAtPosition(fileName, offset)) as
          { entries?: CompletionEntryLike[] } | undefined;
        const tree = (await client.getNavigationTree(fileName)) as NavigationItemLike | undefined;
        if (model.isDisposed()) return undefined;
        const names = declaredFromCompletions(completions?.entries ?? []);
        return toDeclaredNames(names, file, (n) => {
          const offsetOf = soleDeclarationOffset(tree, n);
          return offsetOf === undefined ? undefined : model.getPositionAt(offsetOf).lineNumber;
        });
      })(),
      WORKER_TIMEOUT_MS,
    );
    return declared ? { lineText, declaredNames: declared } : { lineText };
  } catch {
    return { lineText }; // the language service is restarting (S18.4): the card works without the names
  }
}

/** The result of putting a fix into the editor model. */
export type SpanEditResult =
  | { readonly ok: true; readonly text: string; readonly version: number }
  | { readonly ok: false; readonly reason: 'no-model' | 'changed' };

/**
 * S22.5: replaces exactly `span` (1-based line, UTF-16 columns, end exclusive) of the open file `uri`, which must
 * currently read `from` (as a whole identifier, or — S55.3 `exact` — exactly that text), with `to` — one undo step on the model's own undo stack, so Ctrl/Cmd+Z in the editor takes
 * it back like any typed edit. Nothing else in the file changes. `version` identifies the model state right after
 * the edit (for the card's Undo).
 */
export function replaceSpan(
  uri: string,
  span: { line: number; column: number; endColumn: number },
  from: string,
  to: string,
  match: 'identifier' | 'exact' = 'identifier',
): SpanEditResult {
  const model = modelOf(uri);
  if (!model) return { ok: false, reason: 'no-model' };
  if (span.line > model.getLineCount()) return { ok: false, reason: 'changed' };
  // The span must still hold exactly the misspelled name as a whole identifier (not part of `usrNameList`).
  if (
    span.endColumn !== span.column + from.length ||
    !holdsText(model.getLineContent(span.line), span.column, from, match)
  ) {
    return { ok: false, reason: 'changed' };
  }
  const range = new monaco.Range(span.line, span.column, span.line, span.endColumn);
  model.pushStackElement();
  model.pushEditOperations([], [{ range, text: to }], () => null);
  model.pushStackElement();
  return { ok: true, text: model.getValue(), version: model.getAlternativeVersionId() };
}

/**
 * The card's Undo: when the model is still exactly as the fix left it, the editor's own undo is used (the fix
 * comes off the undo stack and Redo still works). If the user has edited since but the fixed span still reads `to`,
 * only that span is put back to `from` (as a new undo step); anything else is left alone ('changed').
 */
export function undoSpan(
  uri: string,
  span: { line: number; column: number },
  from: string,
  to: string,
  version: number,
  match: 'identifier' | 'exact' = 'identifier',
): SpanEditResult {
  const model = modelOf(uri);
  if (!model) return { ok: false, reason: 'no-model' };
  if (model.getAlternativeVersionId() === version) {
    model.undo();
  } else {
    if (span.line > model.getLineCount() || !holdsText(model.getLineContent(span.line), span.column, to, match)) {
      return { ok: false, reason: 'changed' };
    }
    const range = new monaco.Range(span.line, span.column, span.line, span.column + to.length);
    model.pushStackElement();
    model.pushEditOperations([], [{ range, text: from }], () => null);
    model.pushStackElement();
  }
  return { ok: true, text: model.getValue(), version: model.getAlternativeVersionId() };
}

/**
 * S55.3: the template of a just-created file goes into its model as one undo step — only while the model is still
 * empty (the file was created empty a moment ago; anything else means it is not the new file).
 */
export function fillEmpty(uri: string, text: string): SpanEditResult {
  const model = modelOf(uri);
  if (!model) return { ok: false, reason: 'no-model' };
  if (model.getValueLength() !== 0) return { ok: false, reason: 'changed' };
  model.pushStackElement();
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
  model.pushStackElement();
  return { ok: true, text: model.getValue(), version: model.getAlternativeVersionId() };
}

/**
 * S55.3 card Undo of a created file: the editor's own undo while the model is as the fix left it; otherwise the
 * template is taken out only if the file still holds exactly it. The file itself stays (deleting is the user's call).
 */
export function emptyAgain(uri: string, text: string, version: number): SpanEditResult {
  const model = modelOf(uri);
  if (!model) return { ok: false, reason: 'no-model' };
  if (model.getAlternativeVersionId() === version) model.undo();
  else if (model.getValue() === text) {
    model.pushStackElement();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: '' }], () => null);
    model.pushStackElement();
  } else return { ok: false, reason: 'changed' };
  return { ok: true, text: model.getValue(), version: model.getAlternativeVersionId() };
}

/**
 * S22.5 re-check: asks the JavaScript language service for the file's current diagnostics (not the markers, which
 * lag behind an edit) and returns whether it still reports `name` as undefined on `line`. Null when it cannot tell.
 */
export async function stillReportsUndefinedName(uri: string, line: number, name: string): Promise<boolean | null> {
  const model = modelOf(uri);
  if (!model || model.getLanguageId() !== 'javascript') return null;
  try {
    const result = await withTimeout(
      (async () => {
        const getClient = await getJavaScriptWorker();
        const client = await getClient(model.uri);
        const fileName = model.uri.toString();
        const diagnostics = [
          ...(await client.getSyntacticDiagnostics(fileName)),
          ...(await client.getSemanticDiagnostics(fileName)),
        ];
        if (model.isDisposed()) return null;
        return diagnostics.some((d) => {
          if (d.code !== 2304 && d.code !== 2552) return false;
          if (d.start === undefined || model.getPositionAt(d.start).lineNumber !== line) return false;
          const text = typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText;
          return text.includes(`'${name}'`);
        });
      })(),
      WORKER_TIMEOUT_MS,
    );
    return result ?? null;
  } catch {
    return null;
  }
}
