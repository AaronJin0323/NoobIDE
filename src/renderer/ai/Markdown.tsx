import { useState, type ReactNode } from 'react';
import { parseMarkdown, type MdBlock, type MdInline } from './md-parse';
import { copyText } from './clipboard';

export interface MarkdownLabels {
  /** "Copy code" button. */
  readonly copy: string;
  readonly copied: string;
  readonly copyFailed: string;
  /** The code block's caption, given its language ('' when none). */
  readonly codeCaption: (lang: string) => string;
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

function CodeBlock({ block, labels }: { block: Extract<MdBlock, { type: 'code' }>; labels: MarkdownLabels }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <figure className="md-code" data-testid="md-code" data-lang={block.lang || undefined}>
      <figcaption className="md-code-head">
        <span className="md-code-lang">{labels.codeCaption(block.lang)}</span>
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
        <span className="sr-only" role="status">
          {copied === 'copied' ? labels.copied : copied === 'failed' ? labels.copyFailed : ''}
        </span>
      </figcaption>
      <pre tabIndex={0}>
        <code>{block.text}</code>
      </pre>
      {copied === 'failed' && <p className="md-copy-failed">{labels.copyFailed}</p>}
    </figure>
  );
}

function renderBlock(block: MdBlock, i: number, labels: MarkdownLabels): ReactNode {
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
      return <CodeBlock key={i} block={block} labels={labels} />;
  }
}

/**
 * Renders untrusted Markdown (an AI answer) as React elements: no `dangerouslySetInnerHTML`, no raw HTML, no live links.
 */
export function Markdown({ source, labels }: { source: string; labels: MarkdownLabels }) {
  const blocks = parseMarkdown(source);
  return <div className="md">{blocks.map((block, i) => renderBlock(block, i, labels))}</div>;
}
