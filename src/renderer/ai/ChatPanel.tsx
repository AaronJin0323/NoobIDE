import { isImeKey } from '../workbench/ime';
import { useEffect, useRef, type ReactNode } from 'react';
import type { MessageKey } from '../i18n/index';
import { useI18n } from '../i18n/I18nProvider';
import { fill } from '../recovery/format';
import {
  activeConversation,
  answerText,
  conversationsOf,
  draftOf,
  projectKeyOf,
  runningTurn,
  type ChatState,
  type ChatTurn,
  type TurnKind,
  type TurnPart,
} from './chat-model';
import type { AiChatExtensions, AiConsentRenderer } from './chat-extensions';
import { contextLabel, errorExplanation, providerName } from './chat-text';
import { withKeyStore } from './ai-status';
import { Markdown, type MarkdownCode, type MarkdownLabels } from './Markdown';
import { AiIcon, CloseIcon, JumpLatestIcon, NewChatIcon, PastChatsIcon } from './ai-icons';
import { SavedProposal } from './SavedChatsList';
import { useScrollLatch } from './useScrollLatch';
import { StepsFold, groupAnswer } from './StepsFold';
import { staggerStyle } from '../theme/stagger';
import { StatusDot } from '../theme/StatusDot';
import './ai-chat.css';

/** `count` picks the singular form of a counted message (i18n/plural.ts). */
type Translate = (key: MessageKey, count?: number) => string;

/** What the panel can ask the controller to do (AiChatController implements it). */
export interface ChatPanelActions {
  close(): void;
  newConversation(): void;
  selectConversation(id: string): void;
  setPrompt(prompt: string): void;
  setKind(kind: TurnKind): void;
  removeChip(id: string): void;
  addCurrentFile(): boolean;
  addSelection(): boolean;
  /** S38.2: adds a Preview chip (snapshot of the running preview). */
  addPreview(): Promise<boolean>;
  send(): Promise<void>;
  stop(): Promise<void>;
  consentGiven(): Promise<void>;
  consentDeclined(): void;
}

export interface ChatPanelProps {
  readonly state: ChatState;
  readonly projectId: string | null;
  readonly actions: ChatPanelActions;
  readonly consent: AiConsentRenderer;
  /** Opens Settings → AI; absent while nothing can open it (the panel then says where the settings are). */
  readonly onOpenSettings?: (() => void) | undefined;
  readonly extensions?: AiChatExtensions | undefined;
  /** S39.1: saved chats of the open project (absent without a project or a history bridge). */
  readonly pastChats?: PastChatsSlot | undefined;
  /** S48.5: code blocks coloured in the current scheme, with Insert at cursor / Replace selection into the editor. */
  readonly codeBlocks?: MarkdownCode | undefined;
}

/** S39.1: the "Past chats" button, the list shown in place of the conversation, and the history notice. */
export interface PastChatsSlot {
  readonly listOpen: boolean;
  readonly onToggle: () => void;
  readonly list: ReactNode;
  readonly notice: MessageKey | null;
}

export function ChatPanel(props: ChatPanelProps) {
  const { t } = useI18n();
  return <ChatPanelView {...props} t={t} />;
}

const STATE_TEXT: Partial<Record<ChatState['availability']['kind'], MessageKey>> = {
  loading: 'ai.state.loading',
  unavailable: 'ai.state.unavailable',
  disabled: 'ai.state.disabled',
  'no-key': 'ai.state.noKey',
  'no-secure-storage': 'ai.state.noSecureStorage',
};

/** S48.5: what Insert at cursor / Replace selection say afterwards. */
const CODE_OUTCOME_TEXT: Record<'insert' | 'replace' | 'no-editor' | 'read-only' | 'no-selection', MessageKey> = {
  insert: 'ai.chat.code.inserted',
  replace: 'ai.chat.code.replaced',
  'no-editor': 'ai.chat.code.noEditor',
  'read-only': 'ai.chat.code.readOnly',
  'no-selection': 'ai.chat.code.noSelection',
};

function turnStatusKey(turn: ChatTurn): MessageKey | null {
  if (turn.stopping && (turn.status === 'sending' || turn.status === 'streaming')) return 'ai.chat.state.stopping';
  switch (turn.status) {
    case 'sending':
      return 'ai.chat.state.sending';
    case 'streaming':
      return 'ai.chat.state.streaming';
    case 'done':
      return 'ai.chat.state.done';
    case 'cancelled':
      return 'ai.chat.state.cancelled';
    case 'error':
      return null;
  }
}

/**
 * S38.2: what a Preview chip will send — the exact text (as plain text: page content is never rendered as HTML) and
 * the screenshot thumbnail. A native disclosure, so it opens with the keyboard (Tab, then Enter or Space).
 */
function PreviewChipDetails({
  text,
  thumbnail,
  imageSent,
  t,
}: {
  readonly text: string;
  readonly thumbnail: string | null;
  readonly imageSent: boolean;
  readonly t: Translate;
}) {
  return (
    <details className="ai-chip-preview" data-testid="ai-preview-details">
      <summary>{t('ai.chat.context.previewShow')}</summary>
      <p className="ai-hint">{t('ai.chat.context.previewTextLabel')}</p>
      <pre className="ai-preview-text" data-testid="ai-preview-text" tabIndex={0}>
        {text}
      </pre>
      {thumbnail ? (
        <>
          <img
            className="ai-preview-thumbnail"
            data-testid="ai-preview-thumbnail"
            src={thumbnail}
            alt={t('ai.chat.context.previewImageAlt')}
          />
          <p className="ai-hint" data-testid="ai-preview-image-note" data-sent={imageSent}>
            {t(imageSent ? 'ai.chat.context.previewImageSent' : 'ai.chat.context.previewImageNotSent')}
          </p>
        </>
      ) : (
        <p className="ai-hint" data-testid="ai-preview-image-note" data-sent={false}>
          {t('ai.chat.context.previewNoImage')}
        </p>
      )}
    </details>
  );
}

/** S48.2: whether the engine sizes the composer to its content itself (Chromium 123+); otherwise a mirror does. */
function growByCss(): boolean {
  return typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content') === true;
}

/** The panel with its translation passed in (unit-tested with renderToStaticMarkup). */
export function ChatPanelView({
  state,
  projectId,
  actions,
  consent,
  onOpenSettings,
  extensions,
  pastChats,
  codeBlocks,
  t,
}: ChatPanelProps & { t: Translate }) {
  const key = projectKeyOf(projectId);
  const draft = draftOf(state, key);
  const conversation = activeConversation(state, key);
  const conversations = conversationsOf(state, key);
  const running = runningTurn(conversation);
  const availability = state.availability;
  const ready = availability.kind === 'ready';
  const grow = growByCss() ? 'css' : 'mirror';
  const input = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.focusSeq === 0) return;
    const area = input.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }, [state.focusSeq]);

  // S48.1: follow the answer while it streams, unless the reader moved the log (scroll-latch.ts).
  const lastTurn = conversation?.turns.at(-1);
  const latch = useScrollLatch(
    body,
    [
      conversation?.turns.length ?? 0,
      lastTurn ? answerText(lastTurn).length : 0,
      lastTurn?.parts.length ?? 0,
      lastTurn?.status ?? '',
      pastChats?.listOpen === true,
    ].join(':'),
    lastTurn?.id ?? null,
    `${key}/${conversation?.id ?? ''}`,
  );

  const labels: MarkdownLabels = {
    copy: t('ai.chat.copyCode'),
    copied: t('ai.chat.copied'),
    copyFailed: t('ai.chat.copyFailed'),
    // S48.5: the language as the fence names it, in lowercase; a localised word when it names none.
    codeCaption: (lang) => lang || t('ai.chat.code'),
    codeFile: (file) => fill(t('ai.chat.codeFile'), { file }),
    insert: t('ai.chat.insertCode'),
    replace: t('ai.chat.replaceCode'),
    outcome: (outcome, mode) => t(CODE_OUTCOME_TEXT[outcome === 'ok' ? mode : outcome]),
  };

  const settingsHelp = onOpenSettings ? (
    <button type="button" className="secondary-button" data-testid="ai-open-settings" onClick={onOpenSettings}>
      {t('ai.openSettings')}
    </button>
  ) : (
    <p className="ai-hint">{t('ai.settingsWhere')}</p>
  );

  const stateKey = STATE_TEXT[availability.kind];
  const showConsent = ready && projectId !== null && state.consentFor === key;
  const canSend = ready && draft.prompt.trim() !== '' && !running && !showConsent;

  const renderPart = (part: TurnPart, turn: ChatTurn, i: number): ReactNode => {
    switch (part.kind) {
      case 'text':
        return <Markdown key={i} source={part.text} labels={labels} code={codeBlocks} />;
      case 'step':
        return (
          // The summary is a sentence in the user's language; the tool id is for tests and styling only.
          <div key={i} className="ai-step" data-testid="ai-step" data-tool={part.tool}>
            {extensions?.renderStep?.(part, turn) ?? part.summary}
          </div>
        );
      case 'proposal':
        return (
          <div key={i} className="ai-proposal" data-testid="ai-proposal">
            {extensions?.renderProposal?.(part, turn) ?? (
              <p>{fill(t('ai.chat.proposal.unsupported', part.changes.length), { n: part.changes.length })}</p>
            )}
          </div>
        );
      case 'saved-proposal':
        return <SavedProposal key={i} part={part} t={t} />;
    }
  };

  return (
    <section className="ai-chat panel region" id="region-ai" data-testid="region-ai" aria-labelledby="ai-chat-title">
      <div className="panel-header">
        <h2 className="region-title" id="ai-chat-title">
          {t('ai.chat.title')}
        </h2>
        <span className="spacer" />
        {conversations.length > 0 && (
          <select
            className="text-field ai-conversations"
            aria-label={t('ai.chat.conversations')}
            data-testid="ai-conversations"
            value={conversation?.id ?? ''}
            onChange={(event) =>
              event.target.value === '' ? actions.newConversation() : actions.selectConversation(event.target.value)
            }
          >
            <option value="">{t('ai.chat.conversationNew')}</option>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        )}
        {pastChats && (
          <button
            type="button"
            className="icon-button ai-header-button"
            aria-pressed={pastChats.listOpen}
            aria-label={t('ai.history.button')}
            title={t('ai.history.button')}
            data-testid="ai-history-toggle"
            onClick={pastChats.onToggle}
          >
            <PastChatsIcon />
          </button>
        )}
        {/* Icons with names and tooltips, so Close and New chat always fit a narrow panel's header. */}
        <button
          type="button"
          className="icon-button ai-header-button"
          aria-label={t('ai.chat.new')}
          title={t('ai.chat.new')}
          data-testid="ai-new"
          onClick={() => actions.newConversation()}
        >
          <NewChatIcon />
        </button>
        <button
          type="button"
          className="icon-button ai-close"
          aria-label={t('ai.chat.close')}
          title={t('ai.chat.close')}
          data-testid="ai-close"
          onClick={() => actions.close()}
        >
          <CloseIcon />
        </button>
      </div>

      <div className="ai-body-wrap">
        <div className="ai-body" ref={body} data-testid="ai-body">
          {pastChats?.listOpen ? (
            pastChats.list
          ) : stateKey && availability.kind !== 'loading' ? (
            <div className="ai-state" role="status" data-testid="ai-state" data-state={availability.kind}>
              <p>{withKeyStore(t(stateKey), t)}</p>
              {availability.kind !== 'unavailable' && settingsHelp}
            </div>
          ) : (
            <div className="ai-log" role="log" aria-label={t('ai.chat.title')} data-testid="ai-log">
              {availability.kind === 'loading' && <p className="ai-hint">{t('ai.state.loading')}</p>}
              {!conversation && availability.kind !== 'loading' && <p className="ai-empty">{t('ai.chat.empty')}</p>}
              {conversation?.turns.map((turn) => {
                const statusKey = turnStatusKey(turn);
                const isRunning = turn.status === 'sending' || turn.status === 'streaming';
                return (
                  <article key={turn.id} className="ai-turn" data-testid="ai-turn" data-status={turn.status}>
                    <div className="ai-msg ai-msg-user">
                      <p className="ai-who">{t('ai.chat.you')}</p>
                      <p className="ai-prompt" data-testid="ai-prompt">
                        {turn.prompt}
                      </p>
                      <p className="ai-sent-with" data-testid="ai-sent-with">
                        {turn.context.length > 0
                          ? fill(t('ai.chat.sentWith'), {
                              items: turn.context.map((item) => contextLabel(t, item)).join(t('ai.chat.separator')),
                            })
                          : t('ai.chat.sentNothing')}
                      </p>
                    </div>
                    <div className="ai-msg ai-msg-answer" aria-busy={isRunning} data-testid="ai-answer">
                      <p className="ai-who">{t('ai.chat.assistant')}</p>
                      {groupAnswer(turn.parts).map((item) =>
                        item.kind === 'part' ? (
                          renderPart(item.part, turn, item.index)
                        ) : (
                          // S47.2: consecutive steps fold into one group, held open while the answer streams.
                          <StepsFold
                            key={`steps-${item.start}`}
                            count={item.steps.length}
                            live={isRunning}
                            label={t('ai.chat.steps')}
                            heldLabel={t('ai.chat.stepsHeld')}
                          >
                            {item.steps.map((step, j) => renderPart(step, turn, item.start + j))}
                          </StepsFold>
                        ),
                      )}
                      {turn.error && (
                        <div className="ai-error" role="alert" data-testid="ai-error" data-code={turn.error.code}>
                          <p>{errorExplanation(t, turn.error.code)}</p>
                          {turn.error.message && (
                            <p className="ai-hint">{fill(t('ai.error.details'), { message: turn.error.message })}</p>
                          )}
                          {(turn.error.code === 'unauthorized' ||
                            turn.error.code === 'no-key' ||
                            turn.error.code === 'disabled') &&
                            settingsHelp}
                        </div>
                      )}
                      {statusKey && (
                        <p className="ai-turn-status" data-testid="ai-turn-status">
                          {isRunning && <StatusDot pulse /> /* S47.4: thinking, next to the word */}
                          {t(statusKey)}
                        </p>
                      )}
                      {turn.usage && (
                        <p className="ai-usage" data-testid="ai-usage">
                          {fill(t('ai.chat.usage'), {
                            input: turn.usage.inputTokens.toLocaleString(),
                            output: turn.usage.outputTokens.toLocaleString(),
                          })}
                        </p>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
        {latch.show && (
          <button type="button" className="ai-jump" data-testid="ai-jump" onClick={latch.jump}>
            <JumpLatestIcon />
            {t('ai.chat.jumpLatest')}
            {latch.pending > 0 && (
              <span className="ai-jump-count" role="status" data-testid="ai-jump-count">
                {fill(t('ai.chat.jumpPending', latch.pending), { n: latch.pending })}
              </span>
            )}
          </button>
        )}
      </div>
      {pastChats?.notice && (
        <p className="ai-notice" role="status" data-testid="ai-history-notice">
          {t(pastChats.notice)}
        </p>
      )}

      {showConsent &&
        projectId !== null &&
        consent({
          projectId,
          providerName: providerName(t, availability.provider),
          onAllowed: () => void actions.consentGiven(),
          onDeclined: () => actions.consentDeclined(),
        })}

      {availability.kind !== 'unavailable' && availability.kind !== 'disabled' && (
        <form
          className="ai-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSend) void actions.send();
          }}
        >
          <div className="ai-context" role="group" aria-labelledby="ai-context-heading">
            <p className="ai-context-heading" id="ai-context-heading">
              {t('ai.chat.context.heading')}
            </p>
            {draft.chips.length > 0 ? (
              <ul className="ai-chips" data-testid="ai-chips">
                {draft.chips.map((chip, index) => {
                  const label = contextLabel(t, chip.item);
                  return (
                    <li
                      key={chip.id}
                      className="ai-chip"
                      data-testid="ai-chip"
                      data-kind={chip.item.kind}
                      style={staggerStyle(index)} // S47.2: chips enter one after another
                    >
                      <span className="ai-chip-label">{label}</span>
                      {chip.item.kind === 'annotation' && (
                        <details className="ai-chip-preview" data-testid="ai-annotation-details">
                          <summary>{t('ai.chat.context.previewShow')}</summary>
                          <p className="ai-hint">{t('ai.chat.context.annotationTextLabel')}</p>
                          <pre className="ai-preview-text" data-testid="ai-annotation-text" tabIndex={0}>
                            {chip.item.text ?? ''}
                          </pre>
                        </details>
                      )}
                      {chip.preview && (
                        <PreviewChipDetails
                          text={chip.item.text ?? ''}
                          thumbnail={chip.preview.thumbnail}
                          imageSent={chip.preview.imagesAccepted[draft.kind]}
                          t={t}
                        />
                      )}
                      <button
                        type="button"
                        className="ai-chip-remove"
                        aria-label={fill(t('ai.chat.context.remove'), { label })}
                        title={fill(t('ai.chat.context.remove'), { label })}
                        data-testid="ai-chip-remove"
                        onClick={() => actions.removeChip(chip.id)}
                      >
                        <CloseIcon />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="ai-hint" data-testid="ai-no-context">
                {t('ai.chat.context.none')}
              </p>
            )}
            {projectId !== null && (
              <div className="ai-context-add">
                <button
                  type="button"
                  className="quiet-button"
                  data-testid="ai-add-file"
                  onClick={() => void actions.addCurrentFile()}
                >
                  {t('ai.chat.context.addFile')}
                </button>
                <button
                  type="button"
                  className="quiet-button"
                  data-testid="ai-add-selection"
                  onClick={() => void actions.addSelection()}
                >
                  {t('ai.chat.context.addSelection')}
                </button>
                <button
                  type="button"
                  className="quiet-button"
                  data-testid="ai-add-preview"
                  onClick={() => void actions.addPreview()}
                >
                  {t('ai.chat.context.addPreview')}
                </button>
              </div>
            )}
          </div>
          <p className="ai-notice" role="status" data-testid="ai-notice">
            {state.notice ? t(state.notice as MessageKey) : ''}
          </p>
          {extensions?.agent && projectId !== null && (
            <fieldset className="ai-kind" data-testid="ai-kind">
              <legend>{t('ai.chat.kind.label')}</legend>
              {(['chat', 'agent'] as const).map((kind) => (
                <label key={kind}>
                  <input
                    type="radio"
                    name="ai-kind"
                    value={kind}
                    checked={draft.kind === kind}
                    onChange={() => actions.setKind(kind)}
                  />
                  {t(kind === 'chat' ? 'ai.chat.kind.chat' : 'ai.chat.kind.agent')}
                </label>
              ))}
            </fieldset>
          )}
          {draft.mode !== 'chat' && (
            <p className="ai-mode" data-testid="ai-mode" data-mode={draft.mode}>
              {t(`ai.chat.mode.${draft.mode}`)}
            </p>
          )}
          {/* S48.2: grows with its content (field-sizing, or the hidden mirror where that is unsupported). */}
          <div className="ai-input-grow" data-grow={grow}>
            <textarea
              ref={input}
              className="ai-input"
              rows={1}
              aria-label={t('ai.chat.input')}
              aria-describedby="ai-input-hint"
              data-testid="ai-input"
              value={draft.prompt}
              onChange={(event) => actions.setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || isImeKey(event.nativeEvent)) return;
                event.preventDefault();
                if (canSend) void actions.send();
              }}
            />
            {grow === 'mirror' && (
              <span className="ai-input-mirror" aria-hidden="true" data-testid="ai-input-mirror">
                {/* The trailing space gives a final empty line its height, as the textarea does. */}
                {`${draft.prompt} `}
              </span>
            )}
          </div>
          <div className="ai-composer-row">
            <p className="ai-hint" id="ai-input-hint">
              {t('ai.chat.inputHint')}
            </p>
            {running ? (
              <button
                type="button"
                className="secondary-button"
                data-testid="ai-stop"
                disabled={running.stopping}
                onClick={() => void actions.stop()}
              >
                {t('ai.chat.stop')}
              </button>
            ) : (
              <button
                type="submit"
                className="ai-entry ai-entry-strong ai-send"
                data-testid="ai-send"
                disabled={!canSend}
              >
                <AiIcon size={16} />
                {t('ai.chat.send')}
              </button>
            )}
          </div>
        </form>
      )}
      <p className="sr-only" role="status" data-testid="ai-live">
        {running ? t(turnStatusKey(running) ?? 'ai.chat.state.streaming') : ''}
      </p>
    </section>
  );
}
