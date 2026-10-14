import { useEffect, useRef } from 'react';
import { monaco } from './monaco-setup';
import { MONACO_THEME_NAME } from '../theme/monaco-theme';
import { useColorScheme } from '../theme/ThemeProvider';

interface CodeEditorProps {
  /** Stable model URI: the real file's `file://` URI (S03.3), or an `inmemory://` URI for the sample. */
  uri: string;
  language: string;
  initialValue: string;
  ariaLabel: string;
  /** Line ending of the file on disk, kept when saving (PLAN §7). */
  eol?: '\n' | '\r\n';
  onChange?: (text: string) => void;
  /** Ctrl+S on Windows, ⌘S on macOS — Monaco's CtrlCmd maps to each platform's convention. */
  onSave?: () => void;
}

const CODE_FONT = "'Cascadia Mono', 'SF Mono', Menlo, Consolas, 'Microsoft YaHei UI', 'PingFang SC', monospace";

/** Thin React wrapper around one Monaco editor instance. Tabs and model reuse across files: S09. */
export function CodeEditor({ uri, language, initialValue, ariaLabel, eol, onChange, onSave }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const scheme = useColorScheme();
  const themeName = MONACO_THEME_NAME[scheme];
  // The theme is applied separately so a scheme change keeps the buffer. Monaco's `theme` option is global, so a
  // re-created editor (e.g. when another file opens) must use the current theme, not the one from first mount.
  const currentTheme = useRef(themeName);
  // Callbacks change every render; the editor reads the latest ones without being re-created.
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const editorRef = useRef<ReturnType<typeof monaco.editor.create> | null>(null);
  // Changing the label (language switch) must not re-create the editor: that would dispose the model and drop
  // unsaved edits. The initial label is read once; later labels go through updateOptions below.
  const initialAriaLabel = useRef(ariaLabel);

  useEffect(() => {
    if (!host.current) return;
    const modelUri = monaco.Uri.parse(uri);
    const model = monaco.editor.getModel(modelUri) ?? monaco.editor.createModel(initialValue, language, modelUri);
    if (eol) model.setEOL(eol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    const editor = monaco.editor.create(host.current, {
      model,
      ariaLabel: initialAriaLabel.current,
      theme: currentTheme.current,
      automaticLayout: true,
      fontSize: 16, // PLAN §3: start at about 16px
      fontFamily: CODE_FONT,
      lineHeight: 26,
      padding: { top: 12 },
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      tabSize: 2,
    });
    const changes = model.onDidChangeContent(() => callbacks.current.onChange?.(model.getValue()));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave?.());
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
      changes.dispose();
      editor.dispose();
      model.dispose();
    };
  }, [uri, language, initialValue, eol]);

  useEffect(() => {
    initialAriaLabel.current = ariaLabel;
    editorRef.current?.updateOptions({ ariaLabel });
  }, [ariaLabel]);

  useEffect(() => {
    currentTheme.current = themeName;
    monaco.editor.setTheme(themeName);
  }, [themeName]);

  return <div ref={host} className="code-editor" data-testid="code-editor" />;
}
