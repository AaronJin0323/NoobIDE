import { useState } from 'react';
import type { AiApi } from '../../shared/ipc/ai-contract';
import { useI18n } from '../i18n/I18nProvider';
import { fill } from '../recovery/format';
import type { AiConsentProps } from './chat-extensions';

/**
 * Asks once per project before its code is sent (decision 0025). Stand-in until S31's reusable consent component is
 * merged; it plugs into the same `AiConsentRenderer` slot. The answer is stored by main (`ai.setConsent`).
 */
export function ConsentPlaceholder({ api, ...props }: AiConsentProps & { api: AiApi }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const allow = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const result = await api.setConsent({ projectId: props.projectId, allowed: true });
      if (result.ok) props.onAllowed();
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ai-consent" role="group" aria-labelledby="ai-consent-title" data-testid="ai-consent">
      <p className="ai-consent-title" id="ai-consent-title">
        {t('ai.consent.title')}
      </p>
      <p>{fill(t('ai.consent.text'), { provider: props.providerName })}</p>
      {failed && (
        <p role="alert" className="ai-error-text">
          {t('ai.consent.failed')}
        </p>
      )}
      <div className="ai-consent-actions">
        <button
          type="button"
          className="primary-button"
          data-testid="ai-consent-allow"
          disabled={busy}
          onClick={() => void allow()}
        >
          {t('ai.consent.allow')}
        </button>
        <button type="button" className="secondary-button" data-testid="ai-consent-decline" onClick={props.onDeclined}>
          {t('ai.consent.notNow')}
        </button>
      </div>
    </div>
  );
}
