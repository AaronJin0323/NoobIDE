import { useEffect, useRef } from 'react';
import { monaco } from './monaco-setup';
import { models } from './editor-models';
import { MONACO_THEME_NAME } from '../theme/monaco-theme';
import { useColorScheme } from '../theme/ThemeProvider';
// S17.2 / S18.3: Monaco-free handle for the workbench (format, go to code).
import {
  registerEditor,
  subscribeEditorContextActions,
  takePendingReveal,
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
  // Monaco's `theme` option is global; a newly mounted editor must use the current theme, not the first one.
  const currentTheme = useRef(themeName);
  // Callbacks change every render; the editor reads the latest ones without being re-created.
  const callbacks = useRef({ onChange, onSave, onBlur, onComposition, onCursor });
  callbacks.current = { onChange, onSave, onBlur, onComposition, onCursor };
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // Label and font size are read once at creation; later values go through updateOptions, never a re-creation
  // (re-creating would lose the view state; a language switch must not touch the buffer).
  const initial = useRef({ ariaLabel, fontSize });
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
        if (uri && model) callbacks.current.onChange?.(uri, model.getValue());
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
    currentTheme.current = themeName;
    monaco.editor.setTheme(themeName);
  }, [themeName]);

  return <div ref={host} className="code-editor" data-testid="code-editor" data-font-size={fontSize} />;
}
