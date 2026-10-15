import { useEffect, useId, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { shortcutLabel, type PlatformId } from '../../platform/labels';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { fill } from '../recovery/format';
import { saveErrorKey } from '../workbench/file-op-messages';
import { errorExplanation } from './chat-text';
import { proposalDiff, SETTINGS_ERRORS, type InlineEditPhase, type InlineEditState } from './inline-edit-model';
import './inline-edit.css';

type Translate = (key: MessageKey) => string;

export interface InlineEditTarget {
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly wholeFile: boolean;
}

export interface InlineEditPanelActions {
  instruction(text: string): void;
  send(): void;
  stop(): void;
  accept(): void;
  reject(): void;
  close(): void;
  openSettings(): void;
}

export interface InlineEditPanelProps {
  readonly state: InlineEditState;
  readonly target: InlineEditTarget;
  /** The range text the proposal replaces (for the diff). */
  readonly original: string;
  /** S35.2: the problem being fixed (its title), when this is "Fix with AI". */
  readonly fixTitle?: string | undefined;
  /** S42.3: the request of an inline `/ai` prompt, when this zone runs one (its line is what gets replaced). */
  readonly promptRequest?: string | undefined;
  /** The consent prompt (phase 'consent'). */
  readonly consent?: ReactNode;
  readonly platform: PlatformId;
  readonly actions: InlineEditPanelActions;
}

export function targetText(t: Translate, target: InlineEditTarget, prompt = false): string {
  const params = { file: target.relPath, start: target.startLine, end: target.endLine };
  if (prompt) return fill(t('aiPrompt.target'), params);
  if (target.wholeFile) return fill(t('ai.edit.target.file'), params);
  return fill(t(target.startLine === target.endLine ? 'ai.edit.target.line' : 'ai.edit.target.lines'), params);
}

/** The state in words (the zone's live status line). Null where the phase shows its own text (input, error). */
export function statusText(t: Translate, state: InlineEditState, platform: PlatformId): string | null {
  const phase: InlineEditPhase = state.phase;
  switch (phase) {
    case 'running':
      return t('ai.edit.running');
    case 'applying':
      return t('ai.edit.applying');
    case 'applied':
      return fill(t('ai.edit.applied'), { shortcut: shortcutLabel(platform, 'Z') });
    case 'no-change':
      return t('ai.edit.noChange');
    case 'stale':
      return t('ai.edit.stale');
    case 'blocked':
      return t('ai.edit.blocked');
    case 'cancelled':
      return t('ai.edit.cancelled');
    case 'save-failed':
      return fill(t('ai.edit.saveFailed'), {
        reason: state.saveError ? t(saveErrorKey(state.saveError, platform)) : '',
      });
    default:
      return null;
  }
}

export function errorText(t: Translate, code: string): string {
  return code === 'empty-answer' ? t('ai.edit.error.empty-answer') : errorExplanation(t, code);
}

/**
 * S35: the content of the inline edit zone — instruction box, Stop, the proposed change as a line diff with Accept /
 * Reject, and every outcome in words. All of it is reachable by keyboard: Enter sends, Esc cancels / rejects / closes,
 * and focus moves to the next sensible control as the phase changes.
 */
export function InlineEditPanel({
  state,
  target,
  original,
  fixTitle,
  promptRequest,
  consent,
  platform,
  actions,
}: InlineEditPanelProps) {
  const { t } = useI18n();
  const inputId = useId();
  const hintId = useId();
  const focusRef = useRef<HTMLElement | null>(null);
  const setFocus = (node: HTMLElement | null) => {
    focusRef.current = node;
  };
  // Each phase puts keyboard focus on its main control (input, Stop, Accept, Close…).
  useEffect(() => {
    focusRef.current?.focus();
  }, [state.phase]);

  const diff = useMemo(
    () => (state.proposal !== null ? proposalDiff(original, state.proposal) : null),
    [original, state.proposal],
  );
  const status = statusText(t, state, platform);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (state.phase === 'review') actions.reject();
    else actions.close();
  };
  const retry =
    ['error', 'cancelled', 'stale', 'blocked', 'no-change'].includes(state.phase) && state.instruction.trim() !== '';

  return (
    <section
      className="inline-edit"
      role="group"
      aria-label={t('ai.edit.region')}
      data-phase={state.phase}
      data-testid="inline-edit-panel"
      onKeyDown={onKeyDown}
    >
      <p className="inline-edit-target" data-testid="inline-edit-target">
        {targetText(t, target, promptRequest !== undefined)}
      </p>
      {promptRequest !== undefined && (
        <p className="inline-edit-hint" data-testid="inline-edit-prompt">
          {fill(t('aiPrompt.request'), { prompt: promptRequest })}
        </p>
      )}
      {fixTitle !== undefined && (
        <p className="inline-edit-hint" data-testid="inline-edit-fix">
          {fill(t('ai.fix.instructionLabel'), { title: fixTitle })}
        </p>
      )}
      {state.phase === 'consent' && consent}
      {state.phase === 'instruction' && (
        <>
          <label className="inline-edit-label" htmlFor={inputId}>
            {t('ai.edit.instruction')}
          </label>
          <textarea
            id={inputId}
            ref={setFocus}
            className="inline-edit-input"
            data-testid="inline-edit-input"
            rows={2}
            placeholder={t('ai.edit.instructionPlaceholder')}
            aria-describedby={hintId}
            value={state.instruction}
            onChange={(event) => actions.instruction(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                actions.send();
              }
            }}
          />
          <p className="inline-edit-hint" id={hintId}>
            {t('ai.edit.instructionHint')}
          </p>
        </>
      )}
      {(state.phase === 'no-key' || state.phase === 'read-only') && (
        <p className="inline-edit-error" role="alert" data-testid="inline-edit-error" data-code={state.phase}>
          {t(state.phase === 'no-key' ? 'ai.edit.noKey' : 'ai.edit.readOnly')}
        </p>
      )}
      {state.phase === 'error' && state.error && (
        <p className="inline-edit-error" role="alert" data-testid="inline-edit-error" data-code={state.error.code}>
          {errorText(t, state.error.code)}
        </p>
      )}
      <p className="inline-edit-status" role="status" aria-live="polite" data-testid="inline-edit-status">
        {state.phase === 'review' && diff
          ? fill(t('ai.edit.review'), { removed: diff.removed, added: diff.added })
          : (status ?? '')}
      </p>
      {state.phase === 'review' && diff && <DiffView diff={diff} t={t} />}
      {state.usage && (state.phase === 'review' || state.phase === 'no-change') && (
        <p className="inline-edit-usage" data-testid="inline-edit-usage">
          {fill(t('ai.chat.usage'), {
            input: state.usage.inputTokens.toLocaleString(),
            output: state.usage.outputTokens.toLocaleString(),
          })}
        </p>
      )}
      <div className="inline-edit-row">
        {state.phase === 'instruction' && (
          <>
            <button
              type="button"
              className="primary-button"
              data-testid="inline-edit-send"
              disabled={!state.instruction.trim()}
              onClick={actions.send}
            >
              {t('ai.edit.send')}
            </button>
            <button type="button" className="secondary-button" data-testid="inline-edit-cancel" onClick={actions.close}>
              {t('ai.edit.cancel')}
            </button>
          </>
        )}
        {state.phase === 'running' && (
          <button
            type="button"
            className="secondary-button"
            data-testid="inline-edit-stop"
            ref={setFocus}
            onClick={actions.stop}
          >
            {t('ai.edit.stop')}
          </button>
        )}
        {state.phase === 'review' && (
          <>
            <button
              type="button"
              className="primary-button"
              data-testid="inline-edit-accept"
              ref={setFocus}
              onClick={actions.accept}
            >
              {t('ai.edit.accept')}
            </button>
            <button
              type="button"
              className="secondary-button"
              data-testid="inline-edit-reject"
              onClick={actions.reject}
            >
              {t('ai.edit.reject')}
            </button>
          </>
        )}
        {retry && (
          <button
            type="button"
            className="secondary-button"
            data-testid="inline-edit-retry"
            ref={setFocus}
            onClick={actions.send}
          >
            {t('ai.edit.retry')}
          </button>
        )}
        {(state.phase === 'no-key' ||
          (state.phase === 'error' && state.error && SETTINGS_ERRORS.has(String(state.error.code)))) && (
          <button
            type="button"
            className="secondary-button"
            data-testid="inline-edit-settings"
            onClick={actions.openSettings}
          >
            {t('ai.edit.openSettings')}
          </button>
        )}
        {!['instruction', 'running', 'review', 'applying', 'consent'].includes(state.phase) && (
          <button
            type="button"
            className="quiet-button"
            data-testid="inline-edit-close"
            ref={retry ? undefined : setFocus}
            onClick={actions.close}
          >
            {t('ai.edit.close')}
          </button>
        )}
      </div>
    </section>
  );
}

function DiffView({ diff, t }: { diff: ReturnType<typeof proposalDiff>; t: Translate }) {
  if (diff.tooLarge) {
    return (
      <p className="inline-edit-hint" data-testid="inline-edit-diff">
        {fill(t('ai.edit.diff.tooLarge'), { removed: diff.removed, added: diff.added })}
      </p>
    );
  }
  return (
    <div className="inline-edit-diff" role="group" aria-label={t('ai.edit.diff')} data-testid="inline-edit-diff">
      {diff.lines.map((line, i) =>
        line.kind === 'skipped' ? (
          <div key={i} className="inline-edit-skipped">
            {fill(t('ai.edit.diff.skipped'), { n: line.count })}
          </div>
        ) : (
          <div key={i} className="inline-edit-line" data-kind={line.kind}>
            <span className="inline-edit-sign" aria-hidden="true">
              {line.kind === 'removed' ? '−' : line.kind === 'added' ? '+' : ' '}
            </span>
            {line.kind !== 'same' && (
              <span className="sr-only">
                {t(line.kind === 'removed' ? 'ai.edit.diff.removed' : 'ai.edit.diff.added')}
              </span>
            )}
            <code>{line.text || ' '}</code>
          </div>
        ),
      )}
    </div>
  );
}
