import * as monaco from 'monaco-editor/editor';
import { checkHtml } from '../../diagnostics/html-check';

/**
 * S19.2: runs NoobIDE's unclosed-element check (src/diagnostics/html-check.ts) on every HTML model and shows the
 * findings as warning markers (owner `noobide-html`), so they appear as squiggles and flow into Problems like the
 * language services' own markers. Re-checked after a short pause in typing.
 */
export const HTML_CHECK_OWNER = 'noobide-html';
const DELAY_MS = 500;

function check(model: monaco.editor.ITextModel): void {
  if (model.isDisposed() || model.getLanguageId() !== 'html') return;
  const markers = checkHtml(model.getValue()).map((f) => ({
    severity: monaco.MarkerSeverity.Warning,
    code: f.code,
    message: f.message,
    startLineNumber: f.line,
    startColumn: f.column,
    endLineNumber: f.line,
    endColumn: f.endColumn,
  }));
  monaco.editor.setModelMarkers(model, HTML_CHECK_OWNER, markers);
}

function watch(model: monaco.editor.ITextModel): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    timer = null;
    check(model);
  };
  const changes = model.onDidChangeContent(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, DELAY_MS);
  });
  const language = model.onDidChangeLanguage(() => {
    if (model.getLanguageId() === 'html') check(model);
    else monaco.editor.setModelMarkers(model, HTML_CHECK_OWNER, []);
  });
  model.onWillDispose(() => {
    if (timer) clearTimeout(timer);
    changes.dispose();
    language.dispose();
    monaco.editor.setModelMarkers(model, HTML_CHECK_OWNER, []);
  });
  check(model);
}

for (const model of monaco.editor.getModels()) watch(model);
monaco.editor.onDidCreateModel(watch);
