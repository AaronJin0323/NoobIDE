import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { MessageKey } from '../i18n/index';
import { CopyIcon, MoreIcon, ReaskIcon } from './ai-icons';
import { copyText } from './clipboard';

type Translate = (key: MessageKey, count?: number) => string;

/** S48.6: a user message taller than this collapses behind a fade. */
export const COLLAPSE_PX = 300;

export type CollapseState = 'short' | 'collapsed' | 'expanded';

/** Pure: whether a message of this (full) height is short, or collapsed / expanded by the reader. */
export function collapseState(height: number | null, expanded: boolean): CollapseState {
  if (height === null || height <= COLLAPSE_PX) return 'short';
  return expanded ? 'expanded' : 'collapsed';
}

/**
 * S48.6: the text of a user message. Over {@link COLLAPSE_PX} it is cut behind a 3rem fade with a Show-more control
 * (a word and a chevron, aria-expanded), so a pasted file never pushes the answer out of sight.
 */
export function UserPrompt({ text, t }: { readonly text: string; readonly t: Translate }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const id = useId();
  const [height, setHeight] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setHeight(el.scrollHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  const state = collapseState(height, expanded);
  return (
    <>
      <p ref={ref} id={id} className="ai-prompt" data-testid="ai-prompt" data-collapse={state}>
        {text}
      </p>
      {state !== 'short' && (
        <button
          type="button"
          className="ai-more"
          aria-expanded={state === 'expanded'}
          aria-controls={id}
          data-testid="ai-show-more"
          onClick={() => setExpanded((open) => !open)}
        >
          <MoreIcon />
          {t(state === 'expanded' ? 'ai.message.showLess' : 'ai.message.showMore')}
        </button>
      )}
    </>
  );
}

/**
 * S48.6: a message's quiet action row (copy, ask again). Out of sight until the message is hovered, and shown as
 * soon as the keyboard is inside it (focus-within), so the buttons are always reachable with Tab.
 */
export function MessageActions({ actions, t }: { readonly actions: readonly ReactNode[]; readonly t: Translate }) {
  return (
    <div className="ai-msg-actions" role="group" aria-label={t('ai.message.actions')} data-testid="ai-msg-actions">
      {actions}
    </div>
  );
}

/** Copy a message's text; the button says Copied (or that it failed) for a moment. */
export function CopyMessageButton({ text, t }: { readonly text: string; readonly t: Translate }) {
  const [result, setResult] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (result === 'idle') return undefined;
    const timer = setTimeout(() => setResult('idle'), 1500);
    return () => clearTimeout(timer);
  }, [result]);
  const label = t('ai.message.copy');
  return (
    <button
      type="button"
      className="icon-button ai-msg-action"
      aria-label={label}
      title={label}
      data-testid="ai-msg-copy"
      data-result={result}
      onClick={() => void copyText(text).then((ok) => setResult(ok ? 'copied' : 'failed'))}
    >
      <CopyIcon />
      <span className="ai-msg-action-status" role="status">
        {result === 'copied' ? t('ai.chat.copied') : result === 'failed' ? t('ai.chat.copyFailed') : ''}
      </span>
    </button>
  );
}

/** Puts a question back in the composer to ask it again (the user may change it and the context first). */
export function ReaskButton({ onReask, t }: { readonly onReask: () => void; readonly t: Translate }) {
  const label = t('ai.message.reask');
  return (
    <button
      type="button"
      className="icon-button ai-msg-action"
      aria-label={label}
      title={t('ai.message.reaskHint')}
      data-testid="ai-msg-reask"
      onClick={onReask}
    >
      <ReaskIcon />
    </button>
  );
}
