import { useId, useState } from 'react';
import type { AiApi } from '../../shared/ipc/ai-contract';
import { useI18n } from '../i18n/I18nProvider';
import { fill } from '../recovery/format';
import { notifyAiStatusChanged } from './ai-status';
import type { AiConsentProps, AiConsentRenderer } from './chat-extensions';
import './ai.css';

/**
 * The one-time AI consent for a project (S31.4, decision 0025): "Code from this project will be sent to <provider>".
 * Reusable by every AI surface — it implements the chat panel's `AiConsentRenderer` slot (S33, chat-extensions.ts)
 * and is used by Settings → AI, inline completions (S32) and the agent (S34). It stores the answer in main
 * (`ai.setConsent`, revocable in Settings → AI), announces the change (`noobide:ai-status-changed`) and reports it.
 * Not a modal: it sits inline where the request would start; its buttons are ordinary keyboard-reachable buttons and
 * the outcome is said in words.
 */
export interface AiConsentPromptProps extends AiConsentProps {
  readonly api: Pick<AiApi, 'setConsent'>;
  /** Focus the Allow button on mount (when the prompt replaces what the user just clicked). */
  readonly autoFocus?: boolean;
}

export function AiConsentPrompt({
  api,
  projectId,
  providerName,
  onAllowed,
  onDeclined,
  autoFocus,
}: AiConsentPromptProps) {
  const { t } = useI18n();
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const allow = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const result = await api.setConsent({ projectId, allowed: true });
      if (!result.ok) {
        setFailed(true);
        return;
      }
    } catch {
      setFailed(true);
      return;
    } finally {
      setBusy(false);
    }
    notifyAiStatusChanged();
    onAllowed();
  };

  return (
    <section className="ais-consent" role="group" aria-labelledby={titleId} data-testid="ai-consent">
      <h3 className="ais-consent-title" id={titleId}>
        {t('ai.consent.title')}
      </h3>
      <p className="ais-consent-body">{fill(t('ai.consent.body'), { provider: providerName })}</p>
      {failed && (
        <p className="ais-message ais-message-error" role="alert">
          {t('ai.consent.failed')}
        </p>
      )}
      <div className="ais-row">
        <button
          type="button"
          className="primary-button dialog-button"
          disabled={busy}
          autoFocus={autoFocus}
          data-testid="ai-consent-allow"
          onClick={() => void allow()}
        >
          {t('ai.consent.allow')}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          data-testid="ai-consent-deny"
          onClick={onDeclined}
        >
          {t('ai.consent.notNow')}
        </button>
      </div>
    </section>
  );
}

/** The chat panel's consent slot (`useAiChat(…, { consent })`), backed by this component. */
export function aiConsentRenderer(api: Pick<AiApi, 'setConsent'>): AiConsentRenderer {
  return (props) => <AiConsentPrompt key={props.projectId} api={api} {...props} autoFocus />;
}
