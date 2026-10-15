import { useId, useState } from 'react';
import type { AiApi, AiProviderId } from '../../shared/ipc/ai-contract';
import { useI18n } from '../i18n/I18nProvider';
import { fill } from '../recovery/format';
import { notifyAiStatusChanged, PROVIDER_LABEL } from './ai-status';
import './ai.css';

/**
 * The one-time AI consent for a project (S31.4, decision 0025): "Code from this project will be sent to <provider>".
 * Reusable by every AI surface (chat panel S33, inline completions S32, agent S34): render it where the AI request
 * would start; it stores the answer in main (`setConsent`, revocable in Settings → AI) and reports it. Not a modal:
 * it sits inline in the panel, its buttons are ordinary keyboard-reachable buttons, and the decision is text.
 */
export interface AiConsentPromptProps {
  readonly api: Pick<AiApi, 'setConsent'>;
  readonly projectId: string;
  readonly provider: AiProviderId;
  /** Called after the decision was stored (allowed) or declined (nothing stored). */
  readonly onResolved: (allowed: boolean) => void;
  /** Focus the Allow button on mount (when the prompt replaces what the user just clicked). */
  readonly autoFocus?: boolean;
}

export function AiConsentPrompt({ api, projectId, provider, onResolved, autoFocus }: AiConsentPromptProps) {
  const { t } = useI18n();
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const allow = async () => {
    setBusy(true);
    setFailed(false);
    const result = await api.setConsent({ projectId, allowed: true });
    setBusy(false);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    notifyAiStatusChanged();
    onResolved(true);
  };

  return (
    <section className="ai-consent" role="group" aria-labelledby={titleId} data-testid="ai-consent">
      <h3 className="ai-consent-title" id={titleId}>
        {t('ai.consent.title')}
      </h3>
      <p className="ai-consent-body">{fill(t('ai.consent.body'), { provider: t(PROVIDER_LABEL[provider]) })}</p>
      {failed && (
        <p className="ai-message ai-message-error" role="alert">
          {t('ai.error.unknown-project')}
        </p>
      )}
      <div className="ai-row">
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
          onClick={() => onResolved(false)}
        >
          {t('ai.consent.deny')}
        </button>
      </div>
    </section>
  );
}
