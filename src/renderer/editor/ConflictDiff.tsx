import { useEffect, useMemo, useRef } from 'react';
import { monaco } from './monaco-setup';
import { models } from './editor-models';
import { diffLines } from '../recovery/line-diff';

interface ConflictDiffProps {
  /** The open file: its live model is the right-hand ("mine") side. */
  uri: string;
  language: string;
  /** The version on disk (left-hand side). */
  diskText: string;
  ariaLabel: string;
  /** Text summary for screen readers and narrow windows, from the line diff of S12. */
  summary(diff: { identical: boolean; added: number; removed: number }): string;
}

let counter = 0;

/**
 * Monaco diff of a conflict (S11.2): the disk version on the left, the editor's buffer (its live model, read-only in
 * this view) on the right. Both sides stay untouched; the choice is made with the banner's buttons. The temporary
 * disk model is disposed with the view, the file's own model is never disposed here.
 */
export function ConflictDiff({ uri, language, diskText, ariaLabel, summary }: ConflictDiffProps) {
  const host = useRef<HTMLDivElement>(null);
  const counts = useMemo(() => {
    const mine = models.get(uri)?.getValue();
    return mine === undefined ? null : diffLines(diskText, mine);
  }, [uri, diskText]);

  useEffect(() => {
    const modified = models.get(uri);
    if (!host.current || !modified) return undefined;
    counter += 1;
    const original = monaco.editor.createModel(
      diskText,
      language,
      monaco.Uri.parse(`inmemory://noobide/conflict/${counter}/disk`),
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
    editor.setModel({ original, modified });
    return () => {
      editor.setModel(null);
      editor.dispose();
      original.dispose();
    };
  }, [uri, language, diskText, ariaLabel]);

  return (
    <div className="conflict-diff" data-testid="conflict-diff">
      {counts && (
        <p className="alert-detail" data-testid="conflict-summary">
          {summary(counts)}
        </p>
      )}
      <div ref={host} className="code-editor" />
    </div>
  );
}
