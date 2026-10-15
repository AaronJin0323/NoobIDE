import { useEffect, useRef } from 'react';
import { monaco } from '../editor/monaco-setup';
import { languageForPath } from '../editor/language';

interface ProposalDiffProps {
  readonly relPath: string;
  /** Current text ('' for a new file). */
  readonly original: string;
  readonly modified: string;
  readonly ariaLabel: string;
}

let counter = 0;

/**
 * Read-only Monaco diff of one proposed change (S34.2): current text on the left, proposed text on the right. Both
 * models are temporary in-memory models (never the file's own editor model) and are disposed with the view, so the
 * review can never edit or save anything by itself.
 */
export function ProposalDiff({ relPath, original, modified, ariaLabel }: ProposalDiffProps) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return undefined;
    counter += 1;
    const language = languageForPath(relPath);
    const left = monaco.editor.createModel(
      original,
      language,
      monaco.Uri.parse(`inmemory://noobide/agent/${counter}/current`),
    );
    const right = monaco.editor.createModel(
      modified,
      language,
      monaco.Uri.parse(`inmemory://noobide/agent/${counter}/proposed`),
    );
    const editor = monaco.editor.createDiffEditor(host.current, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      ariaLabel,
    });
    editor.setModel({ original: left, modified: right });
    return () => {
      editor.setModel(null);
      editor.dispose();
      left.dispose();
      right.dispose();
    };
  }, [relPath, original, modified, ariaLabel]);
  return <div ref={host} className="code-editor agent-diff-editor" data-testid="agent-diff" />;
}
