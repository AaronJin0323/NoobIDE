import { useEffect, useRef } from 'react';
import type { AiSavedChange } from '../../shared/ipc/ai-history-contract';
import type { MessageKey } from '../i18n/index';
import { fill } from '../recovery/format';
import type { ChatHistoryState } from './chat-history';
import './ai-history.css';

/** `count` picks the singular form of a counted message (i18n/plural.ts). */
type Translate = (key: MessageKey, count?: number) => string;

export interface SavedChatsActions {
  reopen(chatId: string): Promise<void>;
  askDelete(chatId: string): void;
  cancelDelete(): void;
  confirmDelete(): Promise<void>;
  closeList(): void;
}

/**
 * "Past chats" of the open project (S39.1): title, date and size of each saved chat, newest first; Open reopens it,
 * Delete asks for confirmation first — Cancel, then the destructive verb, in the order every confirmation uses
 * (S49.1). Everything is a button (keyboard reachable) and every state is said in words.
 */
export function SavedChatsList({
  state,
  actions,
  activeId,
  locale,
  t,
}: {
  readonly state: ChatHistoryState;
  readonly actions: SavedChatsActions;
  /** The saved id of the conversation shown in the panel, if any. */
  readonly activeId: string | null;
  readonly locale: string;
  readonly t: Translate;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    if (state.confirmDelete) confirmButton.current?.focus();
  }, [state.confirmDelete]);

  const dateText = (ms: number) => {
    try {
      return new Date(ms).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return new Date(ms).toISOString();
    }
  };

  return (
    <div className="ai-history" data-testid="ai-history">
      <div className="ai-history-head">
        <h3 className="ai-history-title" tabIndex={-1} ref={heading}>
          {t('ai.history.title')}
        </h3>
        <button
          type="button"
          className="quiet-button"
          data-testid="ai-history-back"
          onClick={() => actions.closeList()}
        >
          {t('ai.history.back')}
        </button>
      </div>
      <p className="ai-hint">{t('ai.history.where')}</p>
      {state.skipped > 0 && (
        <p className="ai-hint" role="status" data-testid="ai-history-skipped">
          {fill(t('ai.history.skipped', state.skipped), { n: state.skipped })}
        </p>
      )}
      {state.chats === null ? (
        <p className="ai-hint" role="status">
          {t('ai.history.loading')}
        </p>
      ) : state.chats.length === 0 ? (
        <p className="ai-empty" data-testid="ai-history-empty">
          {t('ai.history.empty')}
        </p>
      ) : (
        <ul className="ai-history-list" data-testid="ai-history-list">
          {state.chats.map((chat) => {
            const title = chat.title || t('ai.history.untitled');
            const confirming = state.confirmDelete === chat.id;
            return (
              <li key={chat.id} className="ai-history-item" data-testid="ai-history-item" data-chat-id={chat.id}>
                <span className="ai-history-text">
                  <span className="ai-history-name">
                    {title}
                    {activeId === chat.id ? ` ${t('ai.history.current')}` : ''}
                  </span>
                  <small className="ai-hint">
                    {fill(t('ai.history.updated'), { date: dateText(chat.updatedAt) })}
                    {t('ai.chat.separator')}
                    {fill(t('ai.history.turns'), { n: chat.turnCount })}
                  </small>
                </span>
                {confirming ? (
                  <span
                    className="ai-history-confirm"
                    role="group"
                    aria-label={fill(t('ai.history.confirmDelete'), { title })}
                  >
                    <span className="ai-history-confirm-text">{fill(t('ai.history.confirmDelete'), { title })}</span>
                    <button
                      type="button"
                      className="quiet-button"
                      data-testid="ai-history-cancel-delete"
                      onClick={() => actions.cancelDelete()}
                    >
                      {t('ai.history.cancel')}
                    </button>
                    <button
                      type="button"
                      className="secondary-button danger-button"
                      ref={confirmButton}
                      data-testid="ai-history-confirm-delete"
                      onClick={() => void actions.confirmDelete()}
                    >
                      {t('ai.history.confirmYes')}
                    </button>
                  </span>
                ) : (
                  <span className="ai-history-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      aria-label={fill(t('ai.history.openLabel'), { title })}
                      data-testid="ai-history-open"
                      onClick={() => void actions.reopen(chat.id)}
                    >
                      {t('ai.history.open')}
                    </button>
                    <button
                      type="button"
                      className="quiet-button"
                      aria-label={fill(t('ai.history.deleteLabel'), { title })}
                      data-testid="ai-history-delete"
                      onClick={() => actions.askDelete(chat.id)}
                    >
                      {t('ai.history.delete')}
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A proposal of a reopened chat: what was proposed, in words. */
export function savedProposalText(t: Translate, changes: readonly AiSavedChange[]): string {
  const list = changes
    .map((c) => fill(t(`ai.history.change.${c.kind}`), { path: c.relPath, to: c.to ?? '' }))
    .join(t('ai.chat.separator'));
  return fill(t('ai.history.savedProposal'), { changes: list });
}

export function SavedProposal({
  part,
  t,
}: {
  readonly part: { readonly reason: string; readonly changes: readonly AiSavedChange[] };
  readonly t: Translate;
}) {
  return (
    <div className="ai-proposal ai-saved-proposal" data-testid="ai-saved-proposal">
      {part.reason && <p>{part.reason}</p>}
      <p className="ai-hint">{savedProposalText(t, part.changes)}</p>
    </div>
  );
}
