import { monaco } from '../editor/monaco-setup';
import { getAiPromptHooks, subscribeAiPromptHooks } from '../editor/editor-handle';
import {
  AI_PROMPT_MARKER_OWNER,
  AI_PROMPT_PENDING_CODE,
  enterRuns,
  isPromptLanguage,
  linesAfterChanges,
  parsePromptLine,
  promptMarkersWanted,
} from './ai-prompt-model';
import './ai-prompt.css';

/**
 * S42.3 inline `/ai` prompts in the code editor (decision 0031; rules in ai-prompt-model.ts).
 *
 * Per model (every model, shown or not):
 * - **arming** (decided by the editor below, stored on the model): a line the user typed, pasted, composed (IME) or
 *   undid/redid text on becomes armed when it reads as an `/ai` line (an invisible decoration that moves with the
 *   line). Only that input arms: text loaded or reloaded from disk, a local-history or recovery restore and
 *   NoobIDE's own fixes never do.
 * - **warning markers** (owner `noobide-ai-prompt`) on every `/ai` line of a project file while AI is shown, so a
 *   pending prompt is underlined, explained in the hover and listed in Problems.
 *
 * Per editor (`attachAiPrompts`): the end-of-line hint in words, the context keys, plain Enter on an armed line,
 * Ctrl/Cmd+Enter and the context-menu item on any prompt line. Running hands the line to the workbench
 * (`AiPromptHooks.run`), which opens the inline edit zone over it.
 */

const ENTER_KEY = 'noobide.aiPromptEnter';
const LINE_KEY = 'noobide.aiPromptLine';
/**
 * Only while the code itself has focus (not the find widget or the rename box), and Monaco's own Enter users win:
 * suggestions, inline suggestions, snippets, several cursors or a selection.
 */
const ENTER_WHEN =
  `${ENTER_KEY} && editorTextFocus && !suggestWidgetVisible && !inlineSuggestionVisible && !inSnippetMode && ` +
  '!renameInputVisible && !editorHasMultipleSelections && !editorHasSelection';
const LINE_WHEN = `${LINE_KEY} && editorTextFocus`;
const MARKER_DELAY_MS = 200;

const armedIds = new WeakMap<monaco.editor.ITextModel, Set<string>>();

function armedSet(model: monaco.editor.ITextModel): Set<string> {
  let ids = armedIds.get(model);
  if (!ids) {
    ids = new Set();
    armedIds.set(model, ids);
  }
  return ids;
}

/** The line was changed by the user in this editor and still reads as an `/ai` line. */
export function isArmed(model: monaco.editor.ITextModel, line: number): boolean {
  const ids = armedIds.get(model);
  if (!ids || ids.size === 0) return false;
  // A decoration collapsed by deleting its line (now empty, on a neighbour) does not count.
  return model
    .getLineDecorations(line)
    .some((d) => ids.has(d.id) && !d.range.isEmpty() && d.range.startLineNumber === line);
}

/** Arms those of `lines` (1-based, in the current text) that read as `/ai` lines. */
function arm(model: monaco.editor.ITextModel, lines: Iterable<number>): void {
  const lineCount = model.getLineCount();
  const add: monaco.editor.IModelDeltaDecoration[] = [];
  for (const line of new Set(lines)) {
    if (line < 1 || line > lineCount) continue;
    if (!parsePromptLine(model.getLineContent(line)) || isArmed(model, line)) continue;
    add.push({
      range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
      options: {
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    });
  }
  if (add.length === 0) return;
  const ids = armedSet(model);
  for (const id of model.deltaDecorations([], add)) ids.add(id);
}

/** Forgets armed decorations whose line no longer reads as an `/ai` line. */
function prune(model: monaco.editor.ITextModel): void {
  const ids = armedIds.get(model);
  if (!ids || ids.size === 0) return;
  const gone: string[] = [];
  for (const id of ids) {
    const range = model.getDecorationRange(id);
    if (!range || range.isEmpty() || !parsePromptLine(model.getLineContent(range.startLineNumber))) gone.push(id);
  }
  if (gone.length === 0) return;
  model.deltaDecorations(gone, []);
  for (const id of gone) ids.delete(id);
}

/** Every `/ai` line of the model (1-based) with its parsed prompt. */
function promptLines(model: monaco.editor.ITextModel): { line: number; prompt: string; indent: string }[] {
  const out: { line: number; prompt: string; indent: string }[] = [];
  for (let line = 1; line <= model.getLineCount(); line += 1) {
    const text = model.getLineContent(line);
    if (!text.includes('/ai')) continue;
    const parsed = parsePromptLine(text);
    if (parsed) out.push({ line, ...parsed });
  }
  return out;
}

const promptsShown = (model: monaco.editor.ITextModel): boolean =>
  Boolean(getAiPromptHooks()?.enabled) && isPromptLanguage(model.getLanguageId());

function refreshMarkers(model: monaco.editor.ITextModel): void {
  if (model.isDisposed()) return;
  const hooks = getAiPromptHooks();
  // Project files only (the welcome sample and probes are in-memory models), and only where the prompt can run.
  if (
    !hooks ||
    !promptMarkersWanted({
      enabled: hooks.enabled,
      languageId: model.getLanguageId(),
      scheme: model.uri.scheme,
      editable: !hooks.readOnlyUris().some((uri) => monaco.Uri.parse(uri).toString() === model.uri.toString()),
    })
  ) {
    monaco.editor.setModelMarkers(model, AI_PROMPT_MARKER_OWNER, []);
    return;
  }
  monaco.editor.setModelMarkers(
    model,
    AI_PROMPT_MARKER_OWNER,
    promptLines(model).map(({ line, indent }) => ({
      severity: monaco.MarkerSeverity.Warning,
      code: AI_PROMPT_PENDING_CODE,
      message: hooks.texts.marker,
      startLineNumber: line,
      startColumn: indent.length + 1,
      endLineNumber: line,
      endColumn: model.getLineMaxColumn(line),
    })),
  );
}

function watchModel(model: monaco.editor.ITextModel): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      prune(model);
      refreshMarkers(model);
    }, MARKER_DELAY_MS);
  };
  const changes = model.onDidChangeContent(schedule);
  const language = model.onDidChangeLanguage(() => refreshMarkers(model));
  model.onWillDispose(() => {
    if (timer) clearTimeout(timer);
    changes.dispose();
    language.dispose();
    monaco.editor.setModelMarkers(model, AI_PROMPT_MARKER_OWNER, []);
  });
  refreshMarkers(model);
}

/** Every model's markers follow again (e.g. a tab became read-only or editable). */
export function refreshAiPromptMarkers(): void {
  for (const model of monaco.editor.getModels()) refreshMarkers(model);
}

let installed = false;
function installModelWatch(): void {
  if (installed) return;
  installed = true;
  for (const model of monaco.editor.getModels()) watchModel(model);
  monaco.editor.onDidCreateModel(watchModel);
  // AI switched on/off, or the locale changed: every model's markers follow.
  subscribeAiPromptHooks(refreshAiPromptMarkers);
}

/**
 * Attaches the `/ai` prompt support to the code editor. `target` is the workbench URI of the file on screen when it
 * is a project file that can be edited, else null (no hints, Enter as usual).
 */
export function attachAiPrompts(
  editor: monaco.editor.IStandaloneCodeEditor,
  target: () => string | null,
): monaco.IDisposable {
  installModelWatch();
  const hints = editor.createDecorationsCollection();
  const enterKey = editor.createContextKey<boolean>(ENTER_KEY, false);
  const lineKey = editor.createContextKey<boolean>(LINE_KEY, false);
  let composing = false;

  const active = (): monaco.editor.ITextModel | null => {
    const model = editor.getModel();
    return model && target() !== null && promptsShown(model) ? model : null;
  };

  /**
   * While the cursor is on a prompt line, automatic suggestions (as-you-type and trigger characters such as `.` or
   * space, from the language services and S43) stay off: the request is prose, and an open suggestion list would take
   * the Enter that runs it. Ctrl+Space still asks for them explicitly. Leaving the line restores the options.
   */
  let savedSuggest: monaco.editor.IEditorOptions | null = null;
  const quietSuggestions = (on: boolean) => {
    if (on && !savedSuggest) {
      savedSuggest = {
        quickSuggestions: editor.getOption(monaco.editor.EditorOption.quickSuggestions),
        suggestOnTriggerCharacters: editor.getOption(monaco.editor.EditorOption.suggestOnTriggerCharacters),
      };
      editor.updateOptions({ quickSuggestions: false, suggestOnTriggerCharacters: false });
      // A list opened while `/ai` itself was typed closes now.
      editor.trigger('noobide.aiPrompt', 'hideSuggestWidget', null);
    } else if (!on && savedSuggest) {
      editor.updateOptions(savedSuggest);
      savedSuggest = null;
    }
  };

  const updateKeys = () => {
    const model = active();
    const position = editor.getPosition();
    if (!model || !position) {
      enterKey.set(false);
      lineKey.set(false);
      quietSuggestions(false);
      return;
    }
    const lineText = model.getLineContent(position.lineNumber);
    const parsed = parsePromptLine(lineText);
    quietSuggestions(Boolean(parsed));
    const selections = editor.getSelections() ?? [];
    lineKey.set(Boolean(parsed?.prompt));
    enterKey.set(
      enterRuns({
        lineText,
        column: position.column,
        armed: isArmed(model, position.lineNumber),
        quiet: !composing && selections.length === 1 && Boolean(selections[0]?.isEmpty()),
      }),
    );
  };

  const updateHints = () => {
    const model = active();
    const hooks = getAiPromptHooks();
    if (!model || !hooks) {
      hints.clear();
      return;
    }
    hints.set(
      promptLines(model).map(({ line, prompt }) => {
        const text = !prompt
          ? hooks.texts.hintBare
          : isArmed(model, line)
            ? hooks.texts.hintRun
            : hooks.texts.hintShortcut;
        const end = model.getLineMaxColumn(line);
        return {
          range: new monaco.Range(line, end, line, end),
          options: {
            isWholeLine: true,
            className: 'ai-prompt-line',
            linesDecorationsClassName: 'ai-prompt-gutter',
            after: { content: `  ${text}`, inlineClassName: 'ai-prompt-hint' },
            showIfCollapsed: true,
          },
        };
      }),
    );
  };

  const update = () => {
    updateHints();
    updateKeys();
  };
  // onDidType / onDidPaste arm lines right after the content event: read the result after them.
  const updateSoon = () => queueMicrotask(update);

  /** Runs the prompt on the cursor's line; false when nothing ran (the key then does what it usually does). */
  const run = (): boolean => {
    const model = active();
    const uri = target();
    const position = editor.getPosition();
    const hooks = getAiPromptHooks();
    if (composing || !model || !uri || !position || !hooks?.enabled) return false;
    if (!parsePromptLine(model.getLineContent(position.lineNumber))?.prompt) return false;
    return hooks.run(uri, position.lineNumber);
  };

  editor.addCommand(
    monaco.KeyCode.Enter,
    () => {
      if (!run()) editor.trigger('keyboard', 'type', { text: '\n' });
    },
    ENTER_WHEN,
  );
  editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
    () => {
      if (!run()) editor.trigger('keyboard', 'editor.action.insertLineAfter', null);
    },
    LINE_WHEN,
  );

  // Arming: only the user's own input in this editor.
  const armCursorLines = () => {
    const model = editor.getModel();
    if (model)
      arm(
        model,
        (editor.getSelections() ?? []).map((s) => s.positionLineNumber),
      );
  };

  let menu: monaco.IDisposable | null = null;
  let menuLabel = '';
  const registerMenu = () => {
    const label = getAiPromptHooks()?.texts.menu ?? '';
    if (label === menuLabel) return;
    menu?.dispose();
    menu = null;
    menuLabel = label;
    if (!label) return;
    menu = editor.addAction({
      id: 'noobide.aiPrompt.run',
      label,
      precondition: LINE_KEY,
      contextMenuGroupId: '1_noobide',
      contextMenuOrder: 0,
      run: () => void run(),
    });
  };

  const subscriptions: monaco.IDisposable[] = [
    editor.onDidChangeModelContent((event) => {
      const model = editor.getModel();
      if (model && (event.isUndoing || event.isRedoing)) arm(model, linesAfterChanges(event.changes));
      updateSoon();
    }),
    // Typed text (keys, and text an input method or the OS inserts). Monaco's editor widget has this event, but its
    // public typings do not declare it.
    (editor as unknown as { onDidType: monaco.IEvent<string> }).onDidType(armCursorLines),
    editor.onDidPaste((event) => {
      const model = editor.getModel();
      const { startLineNumber, endLineNumber } = event.range;
      if (model)
        arm(
          model,
          Array.from({ length: endLineNumber - startLineNumber + 1 }, (_, i) => startLineNumber + i),
        );
    }),
    editor.onDidChangeModel(update),
    editor.onDidChangeModelLanguage(update),
    editor.onDidChangeCursorPosition(updateKeys),
    editor.onDidChangeCursorSelection(updateKeys),
    editor.onDidCompositionStart(() => {
      composing = true;
      updateKeys();
    }),
    editor.onDidCompositionEnd(() => {
      composing = false;
      armCursorLines();
      updateSoon();
    }),
  ];
  const unsubscribe = subscribeAiPromptHooks(() => {
    registerMenu();
    update();
  });
  return {
    dispose: () => {
      unsubscribe();
      menu?.dispose();
      for (const subscription of subscriptions) subscription.dispose();
      quietSuggestions(false);
      hints.clear();
    },
  };
}
