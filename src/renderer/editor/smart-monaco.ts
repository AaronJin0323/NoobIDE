/**
 * Smarter indentation and context-aware suggestions in Monaco (S43, decision 0032). The rules are pure modules —
 * indent-detect.ts, completion-context.ts, project-symbols.ts, path-suggest.ts, project-index.ts — and this file only
 * connects them to Monaco:
 *
 * - Indentation: the model on screen gets the resolved tab size / spaces (override > detected > project > default);
 *   pasted text is re-indented into the file's style; the status bar reads the result through indent-state.ts.
 * - Completion: one provider for HTML, CSS and JavaScript adds the project's ids, classes and files where the context
 *   asks for them, and a few beginner snippets. Every item names its origin; the language services' items are left
 *   alone. Everything is local: no network, no AI.
 */
import { monaco } from './monaco-setup';
import { DEFAULT_LOCALE, isLocale, translate, type MessageKey } from '../i18n/index';
import { detectIndentation, reindentPasted, resolveIndentation, type IndentGuess } from './indent-detect';
import { indentOverride, publishIndent, registerIndentCommands } from './indent-state';
import { completionContextAt, type CompletionContext } from './completion-context';
import { suggestPaths } from './path-suggest';
import { indexedLanguage, symbolsOf, type ProjectIndex, type SymbolTable } from './project-index';
import type { FileSymbols } from './project-symbols';

const LANGUAGES = ['html', 'css', 'javascript'] as const;
/** Text before the cursor the context engine looks at. */
const CONTEXT_WINDOW = 2_000;
/** Re-detection of a file whose indentation had too little evidence waits for a pause in typing. */
const REDETECT_DELAY_MS = 800;

function t(key: MessageKey): string {
  const lang = document.documentElement.lang;
  return translate(isLocale(lang) ? lang : DEFAULT_LOCALE, key);
}

// ── Project ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Windows drive letters arrive in either case; everything else is compared as is (paths are case-sensitive). */
const normalPath = (path: string) => path.replace(/^\/([A-Za-z]):/, (_m, drive: string) => `/${drive.toLowerCase()}:`);

let project: { readonly index: ProjectIndex; readonly root: string } | null = null;
const projectListeners = new Set<() => void>();

/** The open project's index and root folder (absolute OS path), or null when no project is open. */
export function setSmartProject(next: { index: ProjectIndex; rootPath: string } | null): void {
  project = next ? { index: next.index, root: normalPath(monaco.Uri.file(next.rootPath).path) } : null;
  for (const listener of projectListeners) listener();
}

const liveSymbolCache = new WeakMap<monaco.editor.ITextModel, { version: number; symbols: FileSymbols }>();

function liveSymbols(model: monaco.editor.ITextModel, relPath: string): FileSymbols | null {
  const language = indexedLanguage(relPath);
  if (!language) return null;
  const cached = liveSymbolCache.get(model);
  if (cached && cached.version === model.getVersionId()) return cached.symbols;
  const symbols = symbolsOf(language, model.getValue());
  liveSymbolCache.set(model, { version: model.getVersionId(), symbols });
  return symbols;
}

interface Scope {
  /** The file's path relative to its project (or its folder, for files outside the open project). */
  readonly relPath: string;
  readonly files: () => string[];
  readonly symbols: () => SymbolTable;
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'));

/**
 * What the suggestions of `model` may know. Inside the open project: the project index, with open models winning.
 * Elsewhere (the welcome sample, the capability probe): the other open models in the same folder.
 */
function scopeOf(model: monaco.editor.ITextModel): Scope {
  const path = normalPath(model.uri.path);
  const fileModels = () => monaco.editor.getModels().filter((m) => m.uri.scheme === model.uri.scheme);
  const current = project;
  if (current && model.uri.scheme === 'file' && path.startsWith(`${current.root}/`)) {
    const prefix = `${current.root}/`;
    return {
      relPath: path.slice(prefix.length),
      files: () => current.index.files(),
      symbols: () => {
        const open = new Map<string, monaco.editor.ITextModel>();
        for (const m of fileModels()) {
          const p = normalPath(m.uri.path);
          if (p.startsWith(prefix)) open.set(p.slice(prefix.length), m);
        }
        const extra = new Map<string, FileSymbols>();
        for (const [relPath, m] of open) {
          const symbols = liveSymbols(m, relPath);
          if (symbols) extra.set(relPath, symbols);
        }
        return current.index.symbols((relPath) => {
          const m = open.get(relPath);
          return m ? liveSymbols(m, relPath) : null;
        }, extra);
      },
    };
  }
  const dir = dirOf(path);
  // Every open model in this folder or below it (the probe puts a case and its files under one folder).
  const siblings = () =>
    fileModels()
      .filter((m) => normalPath(m.uri.path).startsWith(`${dir}/`))
      .map((m) => ({ model: m, name: normalPath(m.uri.path).slice(dir.length + 1) }));
  return {
    relPath: path.slice(dir.length + 1),
    files: () => siblings().map((s) => s.name),
    symbols: () => {
      const ids = new Map<string, string[]>();
      const classes = new Map<string, string[]>();
      for (const { model: m, name } of siblings()) {
        const symbols = liveSymbols(m, name);
        if (!symbols) continue;
        for (const id of symbols.ids) ids.set(id, [...(ids.get(id) ?? []), name]);
        for (const c of symbols.classes) classes.set(c, [...(classes.get(c) ?? []), name]);
      }
      return { ids, classes };
    },
  };
}

// ── Completion ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Sorts NoobIDE's items before the generic DOM / CSS names when the context asks for project names. */
const FIRST = '!0';
const MAX_SNIPPET_CHOICES = 8;

const timings: number[] = [];

function nameItems(
  names: ReadonlyMap<string, readonly string[]>,
  insert: (name: string) => string,
  kind: monaco.languages.CompletionItemKind,
  detailKey: MessageKey,
  range: monaco.IRange,
  ownFile: string,
): monaco.languages.CompletionItem[] {
  const items: monaco.languages.CompletionItem[] = [];
  for (const [name, files] of names) {
    const text = insert(name);
    // Names defined in the current file come first (e.g. href="#…" links inside the page).
    const own = files.includes(ownFile) ? '0' : '1';
    items.push({
      label: { label: text, description: files.join(', ') },
      kind,
      detail: t(detailKey),
      insertText: text,
      filterText: text,
      sortText: `${FIRST}${own}${text}`,
      range,
    });
  }
  return items;
}

function contextItems(
  context: CompletionContext,
  scope: Scope,
  range: monaco.IRange,
): monaco.languages.CompletionItem[] {
  const Kind = monaco.languages.CompletionItemKind;
  switch (context.kind) {
    case 'id':
    case 'css-id': {
      const insert = context.kind === 'css-id' ? (id: string) => `#${id}` : (id: string) => id;
      return nameItems(scope.symbols().ids, insert, Kind.Value, 'smartEdit.complete.id', range, scope.relPath);
    }
    case 'class': {
      const insert = (name: string) => name;
      return nameItems(scope.symbols().classes, insert, Kind.Class, 'smartEdit.complete.class', range, scope.relPath);
    }
    case 'selector': {
      const symbols = scope.symbols();
      return [
        ...nameItems(symbols.ids, (id) => `#${id}`, Kind.Value, 'smartEdit.complete.id', range, scope.relPath),
        ...nameItems(symbols.classes, (c) => `.${c}`, Kind.Class, 'smartEdit.complete.class', range, scope.relPath),
      ];
    }
    case 'path':
      return suggestPaths({
        files: scope.files(),
        fromRelPath: scope.relPath,
        prefix: context.prefix,
        accept: context.accept,
        js: context.js,
      }).map((s) => ({
        label: { label: s.label, description: s.insertText },
        kind: s.isDirectory ? Kind.Folder : Kind.File,
        detail: t(s.isDirectory ? 'smartEdit.complete.folder' : 'smartEdit.complete.file'),
        insertText: s.insertText,
        filterText: s.insertText,
        sortText: `${FIRST}${s.isDirectory ? '1' : '0'}${s.insertText}`,
        range,
        // Choosing a folder goes on with the files inside it.
        ...(s.isDirectory ? { command: { id: 'editor.action.triggerSuggest', title: '' } } : {}),
      }));
  }
}

/** Snippet choice list `${n|a,b|}` of real names, or a plain placeholder when there are none. */
function choice(n: number, names: readonly string[]): string {
  const safe = names.filter((name) => /^[\w#.-]+$/.test(name)).slice(0, MAX_SNIPPET_CHOICES);
  return safe.length ? `\${${n}|${safe.join(',')}|}` : `\${${n}}`;
}

/** Beginner patterns (decision 0032): DOM updates and event listeners with the project's own ids and classes. */
function snippetItems(scope: Scope, range: monaco.IRange): monaco.languages.CompletionItem[] {
  const symbols = scope.symbols();
  const targets = [
    ...[...symbols.ids.keys()].map((id) => `#${id}`),
    ...[...symbols.classes.keys()].map((c) => `.${c}`),
  ];
  const el = `document.querySelector('${choice(1, targets)}')`;
  const snippets: { label: string; key: MessageKey; body: string }[] = [
    { label: 'click', key: 'smartEdit.snippet.click', body: `${el}.addEventListener('click', () => {\n\t$0\n});` },
    { label: 'textContent', key: 'smartEdit.snippet.text', body: `${el}.textContent = '$2';` },
    {
      label: 'classList.toggle',
      key: 'smartEdit.snippet.toggle',
      body: `${el}.classList.toggle('${choice(2, [...symbols.classes.keys()])}');`,
    },
    { label: 'hidden', key: 'smartEdit.snippet.hide', body: `${el}.hidden = \${2|true,false|};` },
  ];
  return snippets.map((s) => ({
    label: { label: s.label, detail: ` ${t(s.key)}`, description: t('smartEdit.complete.snippet') },
    kind: monaco.languages.CompletionItemKind.Snippet,
    detail: t('smartEdit.complete.snippet'),
    documentation: t(s.key),
    insertText: s.body,
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    range,
  }));
}

/** True at the start of a statement in JavaScript (where a snippet makes sense, unlike after `obj.`). */
function atStatementStart(before: string, word: string): boolean {
  const rest = before.slice(0, before.length - word.length);
  const trimmed = rest.trimEnd();
  if (trimmed === '' || /[;{})]$/.test(trimmed)) return true;
  // A new line, unless the previous one ends in the middle of an expression (`a =`, `foo(`, `x &&` …).
  return /\n[ \t]*$/.test(rest) && !/[.=(,[+\-*/&|?:!<>]$/.test(trimmed);
}

function jsRegion(languageId: string, before: string): boolean {
  if (languageId === 'javascript') return true;
  if (languageId !== 'html') return false;
  const open = before.lastIndexOf('<script');
  return open >= 0 && before.lastIndexOf('</script') < open && before.indexOf('>', open) >= 0;
}

const provider: monaco.languages.CompletionItemProvider = {
  triggerCharacters: ['#', '.', '"', "'", '`', '/', '(', ' '],
  provideCompletionItems(model, position) {
    const started = performance.now();
    try {
      const offset = model.getOffsetAt(position);
      const from = model.getPositionAt(Math.max(0, offset - CONTEXT_WINDOW));
      const before = model.getValueInRange(
        monaco.Range.fromPositions(from, position),
        monaco.editor.EndOfLinePreference.LF,
      );
      const languageId = model.getLanguageId();
      const context = completionContextAt(languageId, before);
      if (context) {
        const range = new monaco.Range(
          position.lineNumber,
          Math.max(1, position.column - context.prefix.length),
          position.lineNumber,
          position.column,
        );
        return { suggestions: contextItems(context, scopeOf(model), range) };
      }
      const word = /[A-Za-z_$][\w$.]*$/.exec(before)?.[0] ?? '';
      if (!word || word.includes('.') || !jsRegion(languageId, before) || !atStatementStart(before, word)) {
        return { suggestions: [] };
      }
      const range = new monaco.Range(
        position.lineNumber,
        position.column - word.length,
        position.lineNumber,
        position.column,
      );
      return { suggestions: snippetItems(scopeOf(model), range) };
    } finally {
      if (timings.length >= 500) timings.shift();
      timings.push(performance.now() - started);
    }
  },
};

let providersRegistered = false;
function ensureProviders(): void {
  if (providersRegistered) return;
  providersRegistered = true;
  for (const language of LANGUAGES) monaco.languages.registerCompletionItemProvider(language, provider);
}

// ── Indentation ─────────────────────────────────────────────────────────────────────────────────────────────────

const guesses = new WeakMap<monaco.editor.ITextModel, IndentGuess>();

function guessOf(model: monaco.editor.ITextModel): IndentGuess {
  let guess = guesses.get(model);
  if (!guess) {
    guess = detectIndentation(model.getValue(), model.getLanguageId());
    guesses.set(model, guess);
  }
  return guess;
}

function applyIndentation(model: monaco.editor.ITextModel, publish: boolean): void {
  const uri = model.uri.toString();
  const indent = resolveIndentation({
    guess: guessOf(model),
    override: indentOverride(uri),
    project: project?.index.convention() ?? null,
  });
  const options = model.getOptions();
  if (
    options.insertSpaces !== indent.insertSpaces ||
    options.tabSize !== indent.tabSize ||
    options.indentSize !== indent.tabSize
  ) {
    model.updateOptions({ insertSpaces: indent.insertSpaces, tabSize: indent.tabSize, indentSize: indent.tabSize });
  }
  if (publish) publishIndent({ uri, indent });
}

/**
 * Applies the indentation rules to everything `editor` shows: on every model switch, after a paste, when the project
 * convention changes and — for files that had too little evidence — after a pause in typing.
 */
export function attachSmartEditing(editor: monaco.editor.ICodeEditor): monaco.IDisposable {
  ensureProviders();
  let redetect: ReturnType<typeof setTimeout> | undefined;
  const shown = () => editor.getModel();
  const apply = () => {
    const model = shown();
    if (model) applyIndentation(model, true);
    else publishIndent(null);
  };
  registerIndentCommands({
    reapply: (uri) => {
      const model = shown();
      if (model && model.uri.toString() === uri) {
        guesses.delete(model);
        applyIndentation(model, true);
      }
    },
    convert: (uri) => {
      const model = shown();
      if (!model || model.uri.toString() !== uri) return;
      const id = model.getOptions().insertSpaces
        ? 'editor.action.indentationToSpaces'
        : 'editor.action.indentationToTabs';
      editor.focus();
      void editor.getAction(id)?.run();
    },
  });
  let unsubscribeIndex: (() => void) | null = null;
  const watchIndex = () => {
    unsubscribeIndex?.();
    unsubscribeIndex = project?.index.subscribe(apply) ?? null;
    apply();
  };
  projectListeners.add(watchIndex);
  watchIndex();
  const subscriptions = [
    editor.onDidChangeModel(() => {
      clearTimeout(redetect);
      apply();
    }),
    editor.onDidChangeModelLanguage(() => {
      const model = shown();
      if (model) guesses.delete(model);
      apply();
    }),
    editor.onDidChangeModelContent(() => {
      const model = shown();
      if (!model || guesses.get(model)?.confidence === 'high') return;
      clearTimeout(redetect);
      redetect = setTimeout(() => {
        if (shown() !== model || model.isDisposed()) return;
        const next = detectIndentation(model.getValue(), model.getLanguageId());
        // Only a confident guess replaces the fallback while the user types; a weak one would flip back and forth.
        if (next.confidence !== 'high') return;
        guesses.set(model, next);
        applyIndentation(model, true);
      }, REDETECT_DELAY_MS);
    }),
    editor.onDidPaste((event) => {
      const model = shown();
      if (!model || event.range.isEmpty()) return;
      const { insertSpaces, tabSize } = model.getOptions();
      const pasted = model.getValueInRange(event.range);
      const fixed = reindentPasted(pasted, { insertSpaces, tabSize });
      if (fixed === null || fixed === pasted) return;
      // Its own undo step after the paste (Ctrl+Z first brings the pasted text back as it was).
      model.pushStackElement();
      editor.executeEdits('noobide-indent', [{ range: event.range, text: fixed }]);
      model.pushStackElement();
    }),
  ];
  return {
    dispose: () => {
      clearTimeout(redetect);
      projectListeners.delete(watchIndex);
      unsubscribeIndex?.();
      registerIndentCommands(null);
      publishIndent(null);
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}

/** Read-only facts for the e2e suite: indentation options of the shown model and completion timings (numbers only). */
const smartTestHooks = {
  completionTimings: () => [...timings],
  modelIndent: (uri: string) => {
    const model = monaco.editor.getModels().find((m) => m.uri.toString() === monaco.Uri.parse(uri).toString());
    if (!model) return null;
    const { insertSpaces, tabSize, indentSize } = model.getOptions();
    return { insertSpaces, tabSize, indentSize };
  },
};
Object.defineProperty(window, '__noobideSmartEditTestHooks', { value: smartTestHooks });
