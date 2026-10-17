import { useEffect, useState, type ReactNode } from 'react';
import type { CodeInsertMode, CodeInsertOutcome } from '../editor/editor-handle';
import type { ColorScheme } from '../theme/tokens';
import { parseMarkdown, type MdBlock, type MdInline } from './md-parse';
import { copyText } from './clipboard';
import {
  cachedTokens,
  languageIdOf,
  MAX_HIGHLIGHT_CHARS,
  rememberTokens,
  tokenStyle,
  type CodeToken,
} from './code-highlight';

export interface MarkdownLabels {
  /** "Copy code" button. */
  readonly copy: string;
  readonly copied: string;
  readonly copyFailed: string;
  /** The code block's caption, given its lowercase language ('' when none). */
  readonly codeCaption: (lang: string) => string;
  /** S48.5: the file name next to the caption, for assistive technology ("File: {file}"). */
  readonly codeFile?: (file: string) => string;
  /** S48.5: Insert at cursor / Replace selection, and what came of them. */
  readonly insert?: string;
  readonly replace?: string;
  readonly outcome?: (outcome: CodeInsertOutcome, mode: CodeInsertMode) => string;
}

/** S48.5: where a code block's Insert at cursor / Replace selection go (the code editor on screen). */
export interface CodeEditTarget {
  /** A file is open in the code editor; otherwise both actions explain that a file must be opened first. */
  readonly available: boolean;
  apply(text: string, mode: CodeInsertMode): CodeInsertOutcome;
}

/** S48.5: the chat's code blocks: the colour scheme they are coloured in, and the editor target of their actions. */
export interface MarkdownCode {
  readonly scheme: ColorScheme;
  readonly edit?: CodeEditTarget | undefined;
}

function renderInline(nodes: readonly MdInline[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return node.text;
      case 'code':
        return (
          <code key={i} className="md-inline-code">
            {node.text}
          </code>
        );
      case 'strong':
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case 'em':
        return <em key={i}>{renderInline(node.children)}</em>;
      case 'link': {
        // Never a live link: the text, then the address as plain text (decision 0025: model output is data).
        const text = renderInline(node.children);
        const only = node.children.length === 1 ? node.children[0] : undefined;
        const sameAsUrl = only?.type === 'text' && only.text === node.url;
        return (
          <span key={i} className="md-link" data-testid="md-link">
            {text}
            {!sameAsUrl && node.url && <span className="md-link-url">{` (${node.url})`}</span>}
          </span>
        );
      }
    }
  });
}

/** S48.5: tokens from the bundled Monaco tokenizer (loaded lazily with the editor chunk); null until they arrive. */
function useCodeTokens(text: string, languageId: string | null): CodeToken[][] | null {
  const [found, setFound] = useState<{ readonly text: string; readonly lines: CodeToken[][] } | null>(null);
  const cached = languageId ? cachedTokens(languageId, text) : null;
  useEffect(() => {
    if (!languageId || cached || text.length > MAX_HIGHLIGHT_CHARS) return undefined;
    let cancelled = false;
    // A block that is still streaming changes often: tokenize once it has been quiet for a moment.
    const timer = setTimeout(() => {
      void import('./code-highlight-monaco')
        .then(({ tokenizeCode }) => tokenizeCode(text, languageId))
        .then((lines) => {
          rememberTokens(languageId, text, lines);
          if (!cancelled) setFound({ text, lines });
        })
        .catch(() => undefined); // Uncoloured code is still correct code.
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, languageId, cached]);
  return cached ?? (found?.text === text ? found.lines : null);
}

/** The code as coloured spans (the text content stays exactly the code: line breaks are text, not elements). */
function CodeText({ text, lines, scheme }: { text: string; lines: CodeToken[][] | null; scheme: ColorScheme }) {
  if (!lines) return <>{text}</>;
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          {line.map((token, j) => {
            const style = tokenStyle(scheme, token.type);
            return (
              <span
                key={j}
                data-token={token.type || undefined}
                style={style.italic ? { color: style.color, fontStyle: 'italic' } : { color: style.color }}
              >
                {token.text}
              </span>
            );
          })}
          {i < lines.length - 1 ? '\n' : ''}
        </span>
      ))}
    </>
  );
}

type Note = { readonly text: string; readonly problem: boolean } | null;

function CodeBlock({
  block,
  labels,
  code,
}: {
  block: Extract<MdBlock, { type: 'code' }>;
  labels: MarkdownLabels;
  code: MarkdownCode | undefined;
}) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [note, setNote] = useState<Note>(null);
  const lines = useCodeTokens(block.text, code ? languageIdOf(block.lang) : null);
  const lineCount = block.text.split('\n').length;
  const caption = labels.codeCaption(block.lang);
  const edit = code?.edit;

  useEffect(() => {
    if (!note || note.problem) return undefined;
    const timer = setTimeout(() => setNote(null), 2500);
    return () => clearTimeout(timer);
  }, [note]);

  const apply = (mode: CodeInsertMode) => {
    if (!edit) return;
    const outcome = edit.available ? edit.apply(block.text, mode) : 'no-editor';
    const text = labels.outcome?.(outcome, mode) ?? '';
    setNote(text ? { text, problem: outcome !== 'ok' } : null);
  };

  const editButton = (mode: CodeInsertMode, label: string | undefined) =>
    edit && label ? (
      <button
        type="button"
        className="quiet-button"
        data-testid={mode === 'insert' ? 'md-insert' : 'md-replace'}
        // Still focusable while no file is open: activating it says what to do instead.
        aria-disabled={edit.available ? undefined : true}
        onClick={() => apply(mode)}
      >
        {label}
      </button>
    ) : null;

  return (
    <figure className="md-code" data-testid="md-code" data-lang={block.lang || undefined} data-scheme={code?.scheme}>
      <figcaption className="md-code-head">
        <span className="md-code-title">
          <span className="md-code-lang">{caption}</span>
          {block.file && (
            <span className="md-code-file" data-testid="md-code-file" title={block.file}>
              <span className="sr-only">{labels.codeFile?.(block.file) ?? block.file}</span>
              <span aria-hidden="true">{block.file}</span>
            </span>
          )}
        </span>
        <span className="md-code-actions" role="group" aria-label={caption}>
          <button
            type="button"
            className="quiet-button md-copy"
            data-testid="md-copy"
            onClick={() =>
              void copyText(block.text).then((ok) => {
                setCopied(ok ? 'copied' : 'failed');
                setTimeout(() => setCopied('idle'), 2500);
              })
            }
          >
            {copied === 'copied' ? labels.copied : labels.copy}
          </button>
          {editButton('insert', labels.insert)}
          {editButton('replace', labels.replace)}
        </span>
        <span className="sr-only" role="status">
          {copied === 'copied' ? labels.copied : copied === 'failed' ? labels.copyFailed : (note?.text ?? '')}
        </span>
      </figcaption>
      <div className="md-code-body">
        <span className="md-code-gutter" aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
        </span>
        <pre tabIndex={0}>
          <code>{code ? <CodeText text={block.text} lines={lines} scheme={code.scheme} /> : block.text}</code>
        </pre>
      </div>
      {copied === 'failed' && <p className="md-copy-failed">{labels.copyFailed}</p>}
      {note && (
        <p className="md-code-note" data-testid="md-code-note" data-problem={note.problem || undefined}>
          {note.text}
        </p>
      )}
    </figure>
  );
}

function renderBlock(block: MdBlock, i: number, labels: MarkdownLabels, code: MarkdownCode | undefined): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return <p key={i}>{renderInline(block.children)}</p>;
    case 'heading': {
      // Headings inside an answer stay below the panel's own heading level.
      const Tag = block.level <= 2 ? 'h4' : block.level === 3 ? 'h5' : 'h6';
      return (
        <Tag key={i} className="md-heading">
          {renderInline(block.children)}
        </Tag>
      );
    }
    case 'list':
      return block.ordered ? (
        <ol key={i} start={block.start}>
          {block.items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </ol>
      ) : (
        <ul key={i}>
          {block.items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case 'quote':
      return <blockquote key={i}>{renderInline(block.children)}</blockquote>;
    case 'rule':
      return <hr key={i} />;
    case 'code':
      return <CodeBlock key={i} block={block} labels={labels} code={code} />;
  }
}

/**
 * Renders untrusted Markdown (an AI answer) as React elements: no `dangerouslySetInnerHTML`, no raw HTML, no live links.
 */
export function Markdown({
  source,
  labels,
  code,
}: {
  source: string;
  labels: MarkdownLabels;
  /** S48.5: syntax colours and editor actions for code blocks (absent: plain code with Copy only). */
  code?: MarkdownCode | undefined;
}) {
  const blocks = parseMarkdown(source);
  return <div className="md">{blocks.map((block, i) => renderBlock(block, i, labels, code))}</div>;
}
