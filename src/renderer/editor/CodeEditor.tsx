import { useEffect, useRef } from 'react';
import { monaco } from './monaco-setup';

interface CodeEditorProps {
  /** Stable model URI (S09 switches to one model per real file URI). */
  uri: string;
  language: string;
  initialValue: string;
  ariaLabel: string;
}

/** Thin React wrapper around one Monaco editor instance. */
export function CodeEditor({ uri, language, initialValue, ariaLabel }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const modelUri = monaco.Uri.parse(uri);
    const model = monaco.editor.getModel(modelUri) ?? monaco.editor.createModel(initialValue, language, modelUri);
    const editor = monaco.editor.create(host.current, {
      model,
      ariaLabel,
      automaticLayout: true,
      fontSize: 16, // PLAN §3: start at about 16px
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 2,
    });
    return () => {
      editor.dispose();
      model.dispose();
    };
  }, [uri, language, initialValue, ariaLabel]);

  return <div ref={host} className="code-editor" data-testid="code-editor" />;
}
