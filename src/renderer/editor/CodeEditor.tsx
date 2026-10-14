import { useEffect, useRef } from 'react';
import { monaco } from './monaco-setup';
import { models } from './editor-models';
import { MONACO_THEME_NAME } from '../theme/monaco-theme';
import { useColorScheme } from '../theme/ThemeProvider';

export interface EditorFile {
  /** Stable model URI: the real file's `file://` URI (S03.3), or an `inmemory://` URI for the sample. */
  readonly uri: string;
  readonly language: string;
  /** Text for a new model. Ignored when the URI already has a model: the live buffer (and its undo stack) wins. */
  readonly initialValue: string;
  /** Line ending of the file on disk, kept when saving (PLAN §7). */
  readonly eol?: '\n' | '\r\n' | undefined;
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
      folding: true,
      showFoldingControls: 'always',
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
      editor.onDidChangeCursorPosition((event) =>
        callbacks.current.onCursor?.(event.position.lineNumber, event.position.column),
      ),
    ];
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave?.());
    editorRef.current = editor;
    return () => {
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
