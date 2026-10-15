import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { fill } from '../recovery/format';
import { trapTab } from '../workbench/focus-trap';
import { WarningIcon } from '../workbench/icons';
import type { AgentController } from './useAgent';
import type { AgentItem } from './agent-session';
import { ProposalReview, failureText } from './ProposalReview';
import './agent.css';

interface AgentPanelProps {
  readonly agent: AgentController;
  /** False when AI is not set up (no bridge.ai): the panel explains instead of offering a prompt. */
  readonly available: boolean;
  readonly open: boolean;
  onClose(): void;
}

/**
 * Minimal standalone agent panel (S34.2) until the S33 chat panel hosts agent turns: a prompt, the agent's streamed
 * text and steps, proposals reviewed as diffs (ProposalReview), Stop, and "undo this turn". The conversation lives in
 * {@link AgentController} (useAgent), so swapping this panel for the chat panel keeps the behaviour. Modal while
 * open (focus stays inside, Escape closes); it stays mounted while closed so a running turn keeps its state.
 */
export function AgentPanel({ agent, available, open, onClose }: AgentPanelProps) {
  const { t } = useI18n();
  const titleId = useId();
  const promptId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState('');
  const running = agent.state.running !== null;

  useEffect(() => {
    if (!open) return undefined;
    input.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === 'Tab') trapTab(event, ref.current);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  const send = () => {
    const text = prompt.trim();
    if (text === '' || running) return;
    setPrompt('');
    void agent.send(text);
  };

  return (
    <div className="dialog-backdrop agent-backdrop" hidden={!open}>
      <div
        ref={ref}
        className="dialog agent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="agent-panel"
      >
        <div className="agent-head">
          <h2 className="dialog-title" id={titleId}>
            {t('agent.title')}
          </h2>
          <button type="button" className="quiet-button" data-testid="agent-close" onClick={onClose}>
            {t('agent.close')}
          </button>
        </div>
        <p className="dialog-hint">{t('agent.intro')}</p>
        <ol className="agent-log" role="log" aria-live="polite" data-testid="agent-log">
          {agent.state.items.map((item) => (
            <li key={item.id} className={`agent-item agent-${item.kind}`} data-kind={item.kind}>
              <Item item={item} agent={agent} />
            </li>
          ))}
        </ol>
        {running && (
          <p className="agent-running" role="status" data-testid="agent-running">
            {t('agent.running')}
          </p>
        )}
        {!available && (
          <p className="inline-alert" role="alert" data-testid="agent-unavailable">
            <WarningIcon />
            {t('agent.unavailable')}
          </p>
        )}
        {agent.startError && (
          <p className="inline-alert" role="alert" data-testid="agent-start-error">
            <WarningIcon />
            {fill(t('agent.startFailed'), { code: agent.startError })}
          </p>
        )}
        <div className="agent-compose">
          <label htmlFor={promptId}>{t('agent.prompt.label')}</label>
          <textarea
            id={promptId}
            ref={input}
            rows={3}
            value={prompt}
            disabled={!available}
            placeholder={t('agent.prompt.placeholder')}
            data-testid="agent-prompt"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                send();
              }
            }}
          />
          <div className="agent-compose-actions">
            {running ? (
              <button type="button" className="quiet-button" data-testid="agent-stop" onClick={agent.stop}>
                {t('agent.stop')}
              </button>
            ) : (
              <button
                type="button"
                className="primary-button"
                data-testid="agent-send"
                disabled={!available || prompt.trim() === ''}
                onClick={send}
              >
                {t('agent.send')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Item({ item, agent }: { item: AgentItem; agent: AgentController }) {
  const { t } = useI18n();
  switch (item.kind) {
    case 'prompt':
      return (
        <p data-testid="agent-prompt-item">
          <strong>{t('agent.you')}: </strong>
          {item.text}
        </p>
      );
    case 'text':
      return (
        <p className="agent-text" data-testid="agent-text">
          <strong>{t('agent.assistant')}: </strong>
          {item.text}
        </p>
      );
    case 'step':
      return (
        <p className="agent-step" data-testid="agent-step">
          <span className="sr-only">{t('agent.stepLabel')}: </span>
          {item.summary}
        </p>
      );
    case 'proposal':
      return (
        <>
          <ProposalReview
            proposalId={item.proposalId}
            changes={item.changes}
            reason={item.reason}
            views={item.views}
            busy={agent.busy}
            onAccept={(index) => void agent.accept(item.proposalId, index)}
            onReject={(index) => agent.reject(item.proposalId, index)}
            onAcceptAll={() => void agent.acceptAll(item.proposalId)}
            onRejectAll={() => agent.rejectAll(item.proposalId)}
          />
          {item.reportFailed && (
            <p className="inline-alert" role="alert">
              <WarningIcon />
              {t('agent.decisionFailed')}
            </p>
          )}
        </>
      );
    case 'end': {
      const result = agent.undone.get(item.requestId);
      return (
        <div data-testid="agent-end" data-error={item.error?.code ?? ''}>
          {item.error ? (
            <p className="inline-alert" role="alert" data-testid="agent-error">
              <WarningIcon />
              {item.error.message}
            </p>
          ) : (
            <p className="dialog-hint">
              {t('agent.done')}
              {item.usage &&
                ` ${fill(t('agent.usage'), { input: item.usage.inputTokens, output: item.usage.outputTokens })}`}
            </p>
          )}
          {agent.canUndo(item.requestId) && (
            <p>
              <button
                type="button"
                className="quiet-button"
                data-testid="agent-undo"
                disabled={agent.busy}
                onClick={() => void agent.undo(item.requestId)}
              >
                {t('agent.undo')}
              </button>{' '}
              <span className="dialog-hint">{t('agent.undo.hint')}</span>
            </p>
          )}
          {result && (
            <p role="status" data-testid="agent-undo-result">
              {result.failures.length === 0
                ? fill(t('agent.undo.done'), { n: result.undone })
                : fill(t('agent.undo.partial'), {
                    n: result.undone,
                    m: result.failures.length,
                    reasons: result.failures.map((f) => failureText(t, f.failure)).join(' '),
                  })}
            </p>
          )}
        </div>
      );
    }
  }
}
