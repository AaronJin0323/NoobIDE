/**
 * Monaco, bundled locally (S02.4). Only the editor core plus the HTML / CSS / JavaScript / JSON languages that
 * NoobIDE v1 supports. Workers are emitted by Vite as separate files and loaded from the app origin — never a CDN.
 */
import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/features/register.all';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/languages/features/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker';
import { javascriptDefaults } from 'monaco-editor/languages/features/typescript/register';
import { cssDefaults } from 'monaco-editor/languages/features/css/register';
import { htmlDefaults } from 'monaco-editor/languages/features/html/register';
import { MONACO_THEME_NAME, buildMonacoTheme } from '../theme/monaco-theme';
import { configureLanguages } from './language-config';
import { installFormatHook, onBeforeFormat, type FormattingRegistry } from './format-hook';
import { WorkerSupervisor, type WorkerKind } from './worker-supervisor';
import { ignoreMonacoCancellations } from './monaco-cancellation';
// S19.2: NoobIDE's own unclosed-element check for HTML files (Monaco's HTML service reports no problems).
import './html-check-monaco';

/** Labels of the workers Monaco has started — read by the worker probe (self-test / e2e). */
export const startedWorkers: string[] = [];

// S37.1: Monaco's own cancellations ("Canceled") are not errors; see monaco-cancellation.ts.
ignoreMonacoCancellations(window);

export function workerKind(label: string): WorkerKind {
  if (label === 'css' || label === 'scss' || label === 'less') return 'css';
  if (label === 'html' || label === 'handlebars' || label === 'razor') return 'html';
  if (label === 'json') return 'json';
  if (label === 'typescript' || label === 'javascript') return 'ts';
  return 'editor';
}

// S18.4: every worker is supervised; a killed, crashed or stuck worker is replaced (worker-supervisor.ts).
const restartLanguage: Record<WorkerKind, () => void> = {
  // Re-applying the same options makes Monaco drop the worker client and start a new worker on the next request;
  // the diagnostics adapters re-check every open model when their options change.
  ts: () => javascriptDefaults.setCompilerOptions(javascriptDefaults.getCompilerOptions()),
  css: () => cssDefaults.setOptions(cssDefaults.options),
  html: () => htmlDefaults.setOptions(htmlDefaults.options),
  json: () => undefined,
  editor: () => undefined,
};
export const workerSupervisor = new WorkerSupervisor({ restart: (kind) => restartLanguage[kind]() });

function createWorker(kind: WorkerKind): Worker {
  switch (kind) {
    case 'css':
      return new CssWorker();
    case 'html':
      return new HtmlWorker();
    case 'json':
      return new JsonWorker();
    case 'ts':
      return new TsWorker();
    default:
      return new EditorWorker();
  }
}

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    const kind = workerKind(label);
    startedWorkers.push(kind);
    return workerSupervisor.watch(kind, createWorker(kind));
  },
};

// Editor themes built from the shell tokens (S30.2); CodeEditor selects one per system colour scheme.
for (const scheme of ['dark', 'light'] as const) {
  monaco.editor.defineTheme(MONACO_THEME_NAME[scheme], buildMonacoTheme(scheme));
}

// S18.1 / S19.2: HTML, CSS and JavaScript services with beginner-tuned diagnostics (language-config.ts).
export const languageDefaults = { javascript: javascriptDefaults, css: cssDefaults, html: htmlDefaults };
configureLanguages(languageDefaults);

// S18.3: every formatting path (button, shortcut, context menu, command palette) emits the pre-format hook first.
// Installed before any language registers its formatter (they register lazily, on the first model of the language).
installFormatHook(monaco.languages as unknown as FormattingRegistry<unknown>);

/**
 * Read-only facts for the e2e suite (like main's __noobideTestHooks): metadata only, never file contents.
 * S18.3: which documents fired the pre-format hook. S18.4: worker kill switch and restart count.
 */
export const editorTestHooks = {
  preFormat: [] as { uri: string; languageId: string }[],
  /** S18.4: kills the live workers of a kind the way a crash would (no goodbye), to prove recovery. */
  killWorkers: (kind: WorkerKind): number => {
    const live = workerSupervisor.live(kind);
    for (const worker of live) worker.terminate();
    return live.length;
  },
  restartCount: () => workerSupervisor.restartCount,
  /** Current diagnostics (language-service messages name identifiers; they hold no file contents). */
  markers: () =>
    monaco.editor.getModelMarkers({}).map((m) => ({
      resource: m.resource.toString(true),
      owner: m.owner,
      code: typeof m.code === 'string' ? m.code : m.code?.value,
      message: m.message,
      line: m.startLineNumber,
    })),
};
onBeforeFormat(({ uri, languageId }) => {
  if (editorTestHooks.preFormat.length < 100) editorTestHooks.preFormat.push({ uri, languageId });
});
Object.defineProperty(window, '__noobideEditorTestHooks', { value: editorTestHooks });

export { monaco };
