import { useEffect, useRef } from 'react';
import { monaco } from './monaco-setup';
import { models } from './editor-models';
import { forwardsEdits } from './model-registry';
import { MONACO_THEME_NAME } from '../theme/monaco-theme';
import { useColorScheme } from '../theme/ThemeProvider';
import { editorMotionOptions, useReducedMotion } from '../theme/motion';
// S17.2 / S18.3: Monaco-free handle for the workbench (format, go to code).
import {
  registerEditor,
  subscribeEditorContextActions,
  takePendingReveal,
  type CodeInsertMode,
  type CodeInsertOutcome,
  type EditorSelection,
  type RevealTarget,
} from './editor-handle';
// Memory (decision 0024): the caret stops blinking after a pause, so an idle focused editor produces no frames.
import { CaretRest } from './caret-rest';
// S32.1: AI ghost-text suggestions for the file on screen (rules in src/renderer/ai/inline-*.ts).
import { attachInlineAi } from '../ai/inline-monaco';
import type { InlineTarget } from '../ai/inline-context';
// S35: inline edit zone (Ctrl/Cmd+I, Fix with AI).
import { createEditZone } from '../ai/edit-zone-monaco';
// S43: detected indentation and context-aware suggestions (decision 0032).
import { attachSmartEditing } from './smart-monaco';
// S42.3: inline `/ai` prompt lines (hint, warning, Enter / Ctrl+Enter / context menu).
import { attachAiPrompts, refreshAiPromptMarkers } from '../ai/ai-prompt-monaco';
// S53.1: Emmet abbreviations on Tab (decision 0039).
import { attachEmmet } from './emmet-monaco';
// S53.2: linked tag editing and "Wrap with tag".
import { attachAuthoring, replaceColorAtCursor } from './authoring-monaco';
import { onFormatOutcome } from './format-hook';
import type { FormatOutcome } from '../workbench/format-on-save';
// S57: JavaScript navigation and rename through the language service.
import { nameAt, navigate, renamePlanAt } from './js-navigation-monaco';

export interface EditorFile {
  /** Stable model URI: the real file's `file://` URI (S03.3), or an `inmemory://` URI for the sample. */
  readonly uri: string;
  readonly language: string;
  /** Text for a new model. Ignored when the URI already has a model: the live buffer (and its undo stack) wins. */
  readonly initialValue: string;
  /** Line ending of the file on disk, kept when saving (PLAN §7). */
  readonly eol?: '\n' | '\r\n' | undefined;
  /** S07.4: a file in another encoding is shown but cannot be edited (saving would re-encode it). */
  readonly readOnly?: boolean | undefined;
  /** S32.1: the project file this is (absent for the welcome sample), for AI suggestions. */
  readonly projectId?: string | undefined;
  readonly relPath?: string | undefined;
  /** S07.4: label of a non-UTF-8 encoding; such files get no AI suggestions. */
  readonly encoding?: string | undefined;
}

interface CodeEditorProps {
  /** The visible file. Switching it swaps the model in the same editor; nothing is re-created. */
  file: EditorFile;
  ariaLabel: string;
  fontSize: number;
  onChange?: ((uri: string, text: string) => void) | undefined;
  /** Ctrl+S on Windows, ⌘S on macOS — Monaco's CtrlCmd maps to each platform's convention. */
  onSave?: (() => void) | undefined;
  onBlur?: ((uri: string) => void) | undefined;
  /** IME composition (Pinyin etc.) started or ended; autosave waits while it is open (S09.4, S09.5). */
  onComposition?: ((uri: string, composing: boolean) => void) | undefined;
  onCursor?: ((line: number, column: number) => void) | undefined;
}

const CODE_FONT = "'Cascadia Mono', 'SF Mono', Menlo, Consolas, 'Microsoft YaHei UI', 'PingFang SC', monospace";

export const lineHeightFor = (fontSize: number) => Math.round(fontSize * 1.625);

/** S17.2: puts the cursor on the reported line/column (clamped to the text) and scrolls it to the middle. */
function revealIn(editor: monaco.editor.IStandaloneCodeEditor, target: RevealTarget): void {
  const model = editor.getModel();
  if (!model) return;
  const position = model.validatePosition({ lineNumber: target.line, column: target.column ?? 1 });
  editor.setPosition(position);
  editor.revealPositionInCenter(position);
  if (target.focus) editor.focus();
}

/** S33.2: the first non-empty selection of the file on screen, with its 1-based line range. */
function selectionIn(editor: monaco.editor.IStandaloneCodeEditor, uri: string | null): EditorSelection | null {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!uri || !model || !selection || selection.isEmpty()) return null;
  const text = model.getValueInRange(selection);
  if (!text.trim()) return null;
  // A selection that ends at the start of a line does not include that line.
  const endLine =
    selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
      ? selection.endLineNumber - 1
      : selection.endLineNumber;
  return { uri, startLine: selection.startLineNumber, endLine, text };
}

/** S48.5: chat code at the cursor or over the selection, as one undo step (an ordinary edit for the saver). */
function insertCodeIn(
  editor: monaco.editor.IStandaloneCodeEditor,
  uri: string | null,
  text: string,
  mode: CodeInsertMode,
): CodeInsertOutcome {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!uri || !model || !selection) return 'no-editor';
  if (editor.getOption(monaco.editor.EditorOption.readOnly)) return 'read-only';
  if (mode === 'replace' && selection.isEmpty()) return 'no-selection';
  const position = selection.getPosition();
  const range = mode === 'replace' ? selection : monaco.Range.fromPositions(position, position);
  const start = model.getOffsetAt(range.getStartPosition());
  editor.pushUndoStop();
  editor.executeEdits('noobide.chatCode', [{ range, text, forceMoveMarkers: true }]);
  editor.pushUndoStop();
  // The model normalises line endings; place the cursor after what actually went in.
  const end = model.getPositionAt(start + text.replace(/\r?\n/g, model.getEOL()).length);
  editor.setSelection(monaco.Range.fromPositions(end, end));
  editor.revealPositionInCenterIfOutsideViewport(end);
  editor.focus();
  return 'ok';
}

/** S53.4: formats the model on screen with its language's formatter; the outcome comes from the format hook. */
async function formatForSave(editor: monaco.editor.IStandaloneCodeEditor): Promise<FormatOutcome> {
  const model = editor.getModel();
  const action = editor.getAction('editor.action.formatDocument');
  const formattable = model && ['html', 'css', 'javascript'].includes(model.getLanguageId());
  if (!model || !formattable || !action?.isSupported() || editor.getOption(monaco.editor.EditorOption.readOnly)) {
    return { ok: false, reason: 'unsupported' };
  }
  const uri = model.uri.toString();
  let ok: boolean | null = null;
  const off = onFormatOutcome((event) => {
    if (event.uri === uri) ok = event.ok;
  });
  try {
    await action.run();
  } catch {
    return { ok: false, reason: 'failed' };
  } finally {
    off();
  }
  // No answer from the formatter at all (it was never asked) is not a success either.
  return ok === true ? { ok: true } : { ok: false, reason: 'failed' };
}

/**
 * One Monaco editor for all tabs. A tab switch stores the outgoing view state (cursor, selections, scroll, folding),
 * shows the incoming file's existing model and restores its view state — so undo history, cursor and folds survive.
 */
export function CodeEditor({
  file,
  ariaLabel,
  fontSize,
  onChange,
  onSave,
  onBlur,
  onComposition,
  onCursor,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const scheme = useColorScheme();
  const themeName = MONACO_THEME_NAME[scheme];
  const reducedMotion = useReducedMotion();
  // Monaco's `theme` option is global; a newly mounted editor must use the current theme, not the first one.
  const currentTheme = useRef(themeName);
  // Callbacks change every render; the editor reads the latest ones without being re-created.
  const callbacks = useRef({ onChange, onSave, onBlur, onComposition, onCursor });
  callbacks.current = { onChange, onSave, onBlur, onComposition, onCursor };
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // Label and font size are read once at creation; later values go through updateOptions, never a re-creation
  // (re-creating would lose the view state; a language switch must not touch the buffer).
  const initial = useRef({ ariaLabel, fontSize, reducedMotion });
  // The registry key of the model on screen. Monaco's Uri.toString() re-encodes file URIs (e.g. `c%3A` for `C:`),
  // so the workbench's own URI string is kept instead of being read back from the model.
  const shown = useRef<{ uri: string; model: monaco.editor.ITextModel } | null>(null);
  // S32.1: what the AI suggestions may know about the file on screen (null: not a project file).
  const inlineTarget = useRef<InlineTarget | null>(null);
  inlineTarget.current =
    file.projectId !== undefined && file.relPath !== undefined
      ? { projectId: file.projectId, relPath: file.relPath, readOnly: file.readOnly ?? false, encoding: file.encoding }
      : null;

  useEffect(() => {
    if (!host.current) return;
    const editor = monaco.editor.create(host.current, {
      model: null,
      ariaLabel: initial.current.ariaLabel,
      theme: currentTheme.current,
      automaticLayout: true,
      fontSize: initial.current.fontSize, // PLAN §3: start at about 16px
      lineHeight: lineHeightFor(initial.current.fontSize),
      fontFamily: CODE_FONT,
      padding: { top: 12 },
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      tabSize: 2,
      // S43.2: NoobIDE resolves each file's indentation itself (smart-monaco.ts); Monaco's own guess would disagree.
      detectIndentation: false,
      folding: true,
      showFoldingControls: 'always',
      // S32.1: Monaco's hover toolbar has untranslated labels; Tab / Esc / Ctrl+→ (⌘→) work without it.
      inlineSuggest: { enabled: true, showToolbar: 'never' },
      // S53.2: renaming an opening tag renames its closing tag (pairs from tag-match.ts).
      linkedEditing: true,
      ...editorMotionOptions(initial.current.reducedMotion), // S47.1
    });
    const caret = new CaretRest({
      setBlinking: (blinking) => editor.updateOptions({ cursorBlinking: blinking ? 'blink' : 'solid' }),
    });
    const uriOf = () => {
      const current = shown.current;
      return current && editor.getModel() === current.model ? current.uri : null;
    };
    const subscriptions = [
      editor.onDidChangeModelContent(() => {
        const uri = uriOf();
        const model = editor.getModel();
        // A released model is cleared before disposal (editor-models discard): that is not the user's edit, and it
        // must never reach the saver or the journal. Only the registry's current model for the URI reports edits.
        if (uri && model && forwardsEdits(models.get(uri), model)) callbacks.current.onChange?.(uri, model.getValue());
      }),
      editor.onDidBlurEditorText(() => {
        const uri = uriOf();
        if (uri) callbacks.current.onBlur?.(uri);
      }),
      editor.onDidCompositionStart(() => {
        const uri = uriOf();
        if (uri) callbacks.current.onComposition?.(uri, true);
      }),
      editor.onDidCompositionEnd(() => {
        const uri = uriOf();
        if (uri) callbacks.current.onComposition?.(uri, false);
      }),
      editor.onDidChangeCursorPosition((event) => {
        caret.activity();
        callbacks.current.onCursor?.(event.position.lineNumber, event.position.column);
      }),
      editor.onKeyDown(() => caret.activity()),
      editor.onMouseDown(() => caret.activity()),
      editor.onDidFocusEditorText(() => caret.activity()),
      { dispose: () => caret.dispose() },
      attachInlineAi(editor, () => (uriOf() ? inlineTarget.current : null)),
      attachSmartEditing(editor),
      attachEmmet(editor),
      attachAuthoring(editor),
      attachAiPrompts(editor, () => {
        const uri = uriOf();
        return uri && inlineTarget.current && !inlineTarget.current.readOnly ? uri : null;
      }),
    ];
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave?.());
    editorRef.current = editor;
    // --- S17.2 / S18.3: the workbench reaches this editor through editor-handle (no Monaco import there) ---
    registerEditor({
      shownUri: uriOf,
      formatDocument: async () => {
        await editor.getAction('editor.action.formatDocument')?.run();
      },
      reveal: (target) => revealIn(editor, target),
      selection: () => selectionIn(editor, uriOf()),
      openEditZone: (lines) => {
        const uri = uriOf();
        return uri ? createEditZone(editor, uri, lines ?? null) : null; // S35
      },
      // S51.1: the command registry's find / replace (menus, palette, shortcuts) open Monaco's own widget.
      openFind: (mode) => {
        editor.focus();
        void editor.getAction(mode === 'find' ? 'actions.find' : 'editor.action.startFindReplaceAction')?.run();
      },
      runAction: async (id) => {
        editor.focus();
        await editor.getAction(id)?.run();
      },
      setColor: (rgba) => {
        editor.focus();
        return replaceColorAtCursor(editor, rgba); // S53.3
      },
      focus: () => editor.focus(),
      insertCode: (text, mode) => insertCodeIn(editor, uriOf(), text, mode), // S48.5
      formatForSave: () => formatForSave(editor), // S53.4
      navigate: async (query) => {
        const model = editor.getModel();
        const position = editor.getPosition();
        return model && position ? navigate(query, model, position) : null;
      },
      nameAtCursor: () => {
        const model = editor.getModel();
        const position = editor.getPosition();
        return model && position ? nameAt(model, position) : null;
      },
      renamePlan: async (newName, htmlPages) => {
        const model = editor.getModel();
        const position = editor.getPosition();
        return model && position ? renamePlanAt(model, position, newName, htmlPages) : null;
      },
    });
    // --- end S17.2 / S18.3 ---
    // S33.2: context-menu actions of the workbench ("Ask AI to explain this code").
    let registered: monaco.IDisposable[] = [];
    const unsubscribeActions = subscribeEditorContextActions((actions) => {
      for (const action of registered) action.dispose();
      registered = actions.map((action, i) =>
        editor.addAction({
          id: `noobide.${action.id}`,
          label: action.label,
          contextMenuGroupId: '1_noobide',
          contextMenuOrder: i + 1,
          ...(action.needsSelection ? { precondition: 'editorHasSelection' } : {}),
          run: () => action.run(selectionIn(editor, uriOf())),
        }),
      );
    });
    subscriptions.push({
      dispose: () => {
        unsubscribeActions();
        for (const action of registered) action.dispose();
      },
    });
    return () => {
      registerEditor(null);
      editorRef.current = null;
      const uri = uriOf();
      if (uri && !shown.current?.model.isDisposed()) models.saveViewState(uri, editor.saveViewState());
      shown.current = null;
      for (const subscription of subscriptions) subscription.dispose();
      // Models belong to the open tabs, not to this mount: they outlive the editor widget.
      editor.setModel(null);
      editor.dispose();
    };
  }, []);

  const { uri, language, initialValue, eol } = file;
  const readOnly = file.readOnly ?? false;
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
    refreshAiPromptMarkers(); // S42.3: no pending /ai warning on a read-only tab
  }, [readOnly, uri]);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const previous = shown.current;
    if (previous && previous.uri === uri && editor.getModel() === previous.model && !previous.model.isDisposed()) {
      return;
    }
    if (previous && editor.getModel() === previous.model && !previous.model.isDisposed()) {
      models.saveViewState(previous.uri, editor.saveViewState());
    }
    const model = models.acquire({ uri, language, text: initialValue, eol });
    shown.current = { uri, model };
    editor.setModel(model);
    const view = models.viewState(uri);
    if (view) editor.restoreViewState(view);
    // S17.2: Go to code opened this file; move to the reported place now that it is on screen.
    const reveal = takePendingReveal(uri);
    if (reveal) revealIn(editor, reveal);
    const position = editor.getPosition();
    if (position) callbacks.current.onCursor?.(position.lineNumber, position.column);
  }, [uri, language, initialValue, eol]);

  useEffect(() => {
    initial.current.ariaLabel = ariaLabel;
    editorRef.current?.updateOptions({ ariaLabel });
  }, [ariaLabel]);

  useEffect(() => {
    initial.current.fontSize = fontSize;
    editorRef.current?.updateOptions({ fontSize, lineHeight: lineHeightFor(fontSize) });
  }, [fontSize]);

  useEffect(() => {
    initial.current.reducedMotion = reducedMotion;
    editorRef.current?.updateOptions(editorMotionOptions(reducedMotion));
  }, [reducedMotion]);

  useEffect(() => {
    currentTheme.current = themeName;
    monaco.editor.setTheme(themeName);
  }, [themeName]);

  return (
    <div
      ref={host}
      className="code-editor"
      data-testid="code-editor"
      data-font-size={fontSize}
      data-smooth-scrolling={String(!reducedMotion)}
    />
  );
}
