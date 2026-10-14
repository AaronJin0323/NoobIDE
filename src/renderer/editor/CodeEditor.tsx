import { useEffect, useRef } from 'react';
import { monaco } from './monaco-setup';
import { MONACO_THEME_NAME } from '../theme/monaco-theme';
import { useColorScheme } from '../theme/ThemeProvider';

interface CodeEditorProps {
  /** Stable model URI (S09 switches to one model per real file URI). */
  uri: string;
  language: string;
  initialValue: string;
  ariaLabel: string;
}

const CODE_FONT = "'Cascadia Mono', 'SF Mono', Menlo, Consolas, 'Microsoft YaHei UI', 'PingFang SC', monospace";

/** Thin React wrapper around one Monaco editor instance. */
export function CodeEditor({ uri, language, initialValue, ariaLabel }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const scheme = useColorScheme();
  const themeName = MONACO_THEME_NAME[scheme];
  // The theme is applied separately so a scheme change keeps the buffer. Monaco's `theme` option is global, so a
  // re-created editor (e.g. after a language switch) must use the current theme, not the one from first mount.
  const currentTheme = useRef(themeName);

  useEffect(() => {
    if (!host.current) return;
    const modelUri = monaco.Uri.parse(uri);
    const model = monaco.editor.getModel(modelUri) ?? monaco.editor.createModel(initialValue, language, modelUri);
    const editor = monaco.editor.create(host.current, {
      model,
      ariaLabel,
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
    return () => {
      editor.dispose();
      model.dispose();
    };
  }, [uri, language, initialValue, ariaLabel]);

  useEffect(() => {
    currentTheme.current = themeName;
    monaco.editor.setTheme(themeName);
  }, [themeName]);

  return <div ref={host} className="code-editor" data-testid="code-editor" />;
}
