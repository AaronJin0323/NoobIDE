/**
 * S35.2 re-check after an AI fix was saved: does the code check still report the fixed problem in the file? Loaded
 * with a dynamic import (Monaco stays in its own chunk). Null when it cannot tell — never a clean answer.
 *
 * - JavaScript: the language service's current diagnostics (not the markers, which lag behind an edit): the same
 *   undefined name anywhere in the file, or — for a code-check problem — the same message.
 * - A problem only the running page reported, of another kind: the code check has nothing to say (false); the
 *   preview's reload decides (fix-model `judge`).
 * - Other code-check problems (HTML, CSS): the file's markers once the language service has updated them.
 */
import { getJavaScriptWorker } from 'monaco-editor/languages/features/typescript/register';
import { monaco } from '../editor/monaco-setup';
import type { ProblemRecord } from '../../shared/problem';
import { undefinedName } from '../../diagnostics/rules';

const WORKER_TIMEOUT_MS = 4000;
const MARKERS_SETTLE_MS = 1500;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);

const firstLine = (text: string) => text.split('\n')[0] ?? '';

export async function stillReportsProblem(uri: string, record: ProblemRecord): Promise<boolean | null> {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (!model) return null;
  const name = undefinedName(record)?.name;
  if (model.getLanguageId() === 'javascript' && (name !== undefined || record.source === 'static')) {
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
            const text = typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText;
            if (name !== undefined) return (d.code === 2304 || d.code === 2552) && text.includes(`'${name}'`);
            return text === firstLine(record.originalMessage);
          });
        })(),
        WORKER_TIMEOUT_MS,
      );
      return result ?? null;
    } catch {
      return null;
    }
  }
  if (record.source !== 'static') return false;
  await new Promise<void>((resolve) => {
    const key = model.uri.toString();
    const timer = setTimeout(done, MARKERS_SETTLE_MS);
    const subscription = monaco.editor.onDidChangeMarkers((uris) => {
      if (uris.some((u) => u.toString() === key)) done();
    });
    function done() {
      clearTimeout(timer);
      subscription.dispose();
      resolve();
    }
  });
  if (model.isDisposed()) return null;
  return monaco.editor
    .getModelMarkers({ resource: model.uri })
    .some((m) => firstLine(m.message) === firstLine(record.originalMessage));
}
