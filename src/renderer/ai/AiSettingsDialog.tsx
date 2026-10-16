import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ANTHROPIC_DEFAULT_MODELS } from '../../ai/providers/provider';
import {
  AI_PROVIDERS,
  type AiApi,
  type AiConfig,
  type AiModelInfo,
  type AiProviderId,
  type AiPurpose,
  type AiStatus,
} from '../../shared/ipc/ai-contract';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { fill } from '../recovery/format';
import { useModalKeys } from '../workbench/focus-trap';
import { AiConsentPrompt } from './AiConsentPrompt';
import { AiUsageSection, RevokeChatsPrompt } from './AiHistorySettings';
import { aiHistoryBridge } from './chat-history';
import type { AiHistoryApi } from '../../shared/ipc/ai-history-contract';
import { onOpenAiSettings } from './ai-bridge';
import {
  keyErrorKey,
  modelChoices,
  notifyAiStatusChanged,
  PROVIDER_LABEL,
  PURPOSE_LABEL,
  PURPOSE_ORDER,
  testErrorKey,
  withKeyStore,
} from './ai-status';
import './ai.css';

/** Open state of Settings → AI: opened by `openAiSettings()` from anywhere, closed by the dialog. */
export function useAiSettingsRequests(): { open: boolean; close: () => void } {
  const [open, setOpen] = useState(false);
  const opener = useRef<Element | null>(null);
  useEffect(
    () =>
      // Registered through the bridge so the chat panel's "Open AI settings" becomes a button (S33).
      onOpenAiSettings(() => {
        opener.current = document.activeElement;
        setOpen(true);
      }),
    [],
  );
  const close = useCallback(() => {
    setOpen(false);
    if (opener.current instanceof HTMLElement) opener.current.focus();
  }, []);
  return { open, close };
}

type Message = { readonly tone: 'ok' | 'error'; readonly key: MessageKey } | null;

/**
 * Settings → AI (S31.4, decision 0025): AI on/off, provider, API key (masked, write-only: once saved it is never
 * shown or sent back — the field empties and the status says "saved"), Test, a model per purpose from the provider's
 * list, inline completions on/off, and the open project's consent. Every state is said in words (never colour
 * alone); everything is reachable with Tab; Escape or Close dismisses it.
 */
export function AiSettingsDialog({
  api,
  projectId,
  onClose,
  history = aiHistoryBridge(),
}: {
  readonly api: AiApi;
  readonly projectId: string | null;
  readonly onClose: () => void;
  /** S39: saved chats and token usage; absent in builds without it. */
  readonly history?: AiHistoryApi | undefined;
}) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const keyId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useModalKeys(dialog, onClose);

  const [status, setStatus] = useState<AiStatus | null>(null);
  // The key being typed lives only in this field's state and is cleared as soon as it was sent.
  const [keyDraft, setKeyDraft] = useState('');
  const [keyMessage, setKeyMessage] = useState<Message>(null);
  const [testMessage, setTestMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<Partial<Record<AiProviderId, readonly AiModelInfo[]>>>({});
  const [loadingModels, setLoadingModels] = useState(false);
  // S39.1: after a revoke, how many saved chats the project has (the prompt offers to delete them).
  const [revokeChats, setRevokeChats] = useState(0);
  const [revokeMessage, setRevokeMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await api.status({ projectId });
    if (result.ok) setStatus(result.value);
  }, [api, projectId]);

  useEffect(() => {
    void refresh();
    closeButton.current?.focus();
  }, [refresh]);

  const provider: AiProviderId = status?.config.provider ?? 'anthropic';
  const keyStored = status?.keyStored[provider] ?? false;

  const loadModels = useCallback(
    async (which: AiProviderId) => {
      setLoadingModels(true);
      const result = await api.listModels({ provider: which });
      setLoadingModels(false);
      if (result.ok) setModels((current) => ({ ...current, [which]: result.value }));
      else setTestMessage({ tone: 'error', key: testErrorKey(result.code) });
    },
    [api],
  );

  useEffect(() => {
    if (keyStored && models[provider] === undefined) void loadModels(provider);
  }, [keyStored, provider, models, loadModels]);

  const saveConfig = async (config: AiConfig) => {
    // Shown at once (controlled inputs), then confirmed by main.
    setStatus((current) => (current ? { ...current, config } : current));
    const result = await api.setConfig({ config });
    if (result.ok) {
      setStatus((current) => (current ? { ...current, config: result.value } : current));
      await refresh();
      notifyAiStatusChanged();
    }
  };

  const saveKey = async () => {
    const key = keyDraft;
    setKeyDraft('');
    setKeyMessage(null);
    setTestMessage(null);
    setBusy(true);
    const result = await api.setKey({ provider, key });
    setBusy(false);
    setKeyMessage(
      result.ok ? { tone: 'ok', key: 'ai.settings.key.saved' } : { tone: 'error', key: keyErrorKey(result.code) },
    );
    await refresh();
    notifyAiStatusChanged();
    if (result.ok) void loadModels(provider);
  };

  const removeKey = async () => {
    setBusy(true);
    const result = await api.clearKey({ provider });
    setBusy(false);
    setTestMessage(null);
    setKeyMessage(
      result.ok ? { tone: 'ok', key: 'ai.settings.key.removed' } : { tone: 'error', key: keyErrorKey(result.code) },
    );
    setModels((current) => {
      const next = { ...current };
      delete next[provider];
      return next;
    });
    await refresh();
    notifyAiStatusChanged();
  };

  const test = async () => {
    setBusy(true);
    setTestMessage({ tone: 'ok', key: 'ai.settings.testing' });
    const result = await api.testKey({ provider });
    setBusy(false);
    setTestMessage(
      result.ok ? { tone: 'ok', key: 'ai.settings.test.ok' } : { tone: 'error', key: testErrorKey(result.code) },
    );
  };

  const revokeConsent = async () => {
    if (!projectId) return;
    await api.setConsent({ projectId, allowed: false });
    await refresh();
    notifyAiStatusChanged();
    setRevokeMessage(null);
    const saved = await history?.listChats({ projectId }).catch(() => null);
    setRevokeChats(saved?.ok ? saved.value.chats.length : 0);
  };

  const config = status?.config;
  const defaultLabel = (purpose: AiPurpose) =>
    provider === 'anthropic'
      ? fill(t('ai.settings.models.default'), { model: ANTHROPIC_DEFAULT_MODELS[purpose] })
      : t('ai.settings.models.auto');

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        ref={dialog}
        className="dialog ai-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="ai-settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="dialog-title" id={titleId}>
          {t('ai.settings.title')}
        </h2>
        <div className="dialog-body ai-settings-body">
          <p className="dialog-hint">{t('ai.settings.intro')}</p>
          {status && !status.secureStorage && (
            <p className="ais-message ais-message-error" role="alert" data-testid="ai-no-secure-storage">
              {withKeyStore(t('ai.settings.noSecureStorage'), t)}
            </p>
          )}

          {config && (
            <>
              <label className="ais-check">
                <input
                  type="checkbox"
                  checked={config.enabled}
                  data-testid="ai-enabled"
                  onChange={(event) => void saveConfig({ ...config, enabled: event.target.checked })}
                />
                <span>{t('ai.settings.enabled')}</span>
              </label>
              <p className="dialog-hint" role="status" data-testid="ai-enabled-state">
                {!config.enabled
                  ? t('ai.settings.enabled.off')
                  : keyStored
                    ? t('ai.settings.enabled.on')
                    : t('ai.settings.enabled.noKey')}
              </p>

              <fieldset className="ais-fieldset">
                <legend>{t('ai.settings.provider')}</legend>
                {AI_PROVIDERS.map((id) => (
                  <label key={id} className="ais-check">
                    <input
                      type="radio"
                      name="ai-provider"
                      value={id}
                      checked={provider === id}
                      data-testid={`ai-provider-${id}`}
                      onChange={() => {
                        setKeyMessage(null);
                        setTestMessage(null);
                        void saveConfig({ ...config, provider: id });
                      }}
                    />
                    <span>
                      {t(PROVIDER_LABEL[id])}
                      {status.keyStored[id] ? ` · ${t('ai.settings.key.stored')}` : ''}
                    </span>
                  </label>
                ))}
              </fieldset>

              <div className="ais-section">
                <label className="ais-label" htmlFor={keyId}>
                  {t('ai.settings.key')}
                </label>
                <p className="ais-key-state" role="status" data-testid="ai-key-state">
                  {keyStored ? `✓ ${t('ai.settings.key.stored')}` : t('ai.settings.key.missing')}
                </p>
                <form
                  className="ais-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (keyDraft.trim()) void saveKey();
                  }}
                >
                  <input
                    id={keyId}
                    className="text-field ais-input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={keyDraft}
                    placeholder={t('ai.settings.key.placeholder')}
                    disabled={!status.secureStorage || busy}
                    data-testid="ai-key-input"
                    onChange={(event) => setKeyDraft(event.target.value)}
                  />
                  <button
                    type="submit"
                    className="secondary-button"
                    disabled={!status.secureStorage || busy || keyDraft.trim() === ''}
                    data-testid="ai-key-save"
                  >
                    {t('ai.settings.key.save')}
                  </button>
                </form>
                <p className="dialog-hint">{withKeyStore(t('ai.settings.key.hint'), t)}</p>
                {keyMessage && (
                  <p
                    className={`ais-message ais-message-${keyMessage.tone}`}
                    role={keyMessage.tone === 'error' ? 'alert' : 'status'}
                    data-testid="ai-key-message"
                  >
                    {withKeyStore(t(keyMessage.key), t)}
                  </p>
                )}
                <div className="ais-row">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!keyStored || busy}
                    data-testid="ai-test"
                    onClick={() => void test()}
                  >
                    {t('ai.settings.test')}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!keyStored || busy}
                    data-testid="ai-key-remove"
                    onClick={() => void removeKey()}
                  >
                    {t('ai.settings.key.remove')}
                  </button>
                </div>
                {testMessage && (
                  <p
                    className={`ais-message ais-message-${testMessage.tone}`}
                    role={testMessage.tone === 'error' ? 'alert' : 'status'}
                    data-testid="ai-test-message"
                  >
                    {testMessage.tone === 'ok' && testMessage.key === 'ai.settings.test.ok' ? '✓ ' : ''}
                    {testMessage.tone === 'error' ? '✗ ' : ''}
                    {t(testMessage.key)}
                  </p>
                )}
              </div>

              <fieldset className="ais-fieldset" disabled={!keyStored}>
                <legend>{t('ai.settings.models')}</legend>
                <p className="dialog-hint">{t('ai.settings.models.hint')}</p>
                {PURPOSE_ORDER.map((purpose) => (
                  <label key={purpose} className="ais-model-row">
                    <span>{t(PURPOSE_LABEL[purpose])}</span>
                    <select
                      className="text-field ais-select"
                      value={config.models[purpose]}
                      data-testid={`ai-model-${purpose}`}
                      onChange={(event) =>
                        void saveConfig({ ...config, models: { ...config.models, [purpose]: event.target.value } })
                      }
                    >
                      <option value="">{defaultLabel(purpose)}</option>
                      {modelChoices(config.models[purpose], models[provider] ?? null).map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.displayName === model.id ? model.id : `${model.displayName} (${model.id})`}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                <div className="ais-row">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!keyStored || loadingModels}
                    data-testid="ai-models-refresh"
                    onClick={() => void loadModels(provider)}
                  >
                    {t('ai.settings.models.refresh')}
                  </button>
                  {loadingModels && (
                    <span className="dialog-hint" role="status">
                      {t('ai.settings.models.loading')}
                    </span>
                  )}
                </div>
              </fieldset>

              <label className="ais-check">
                <input
                  type="checkbox"
                  checked={config.inlineCompletions}
                  data-testid="ai-inline"
                  onChange={(event) => void saveConfig({ ...config, inlineCompletions: event.target.checked })}
                />
                <span>{t('ai.settings.inline')}</span>
              </label>

              <div className="ais-section" data-testid="ai-consent-section">
                <h3 className="ais-label">{t('ai.settings.consent')}</h3>
                {projectId === null ? (
                  <p className="dialog-hint">{t('ai.settings.consent.noProject')}</p>
                ) : status.projectConsent ? (
                  <div className="ais-row">
                    <p className="ais-key-state" role="status" data-testid="ai-consent-state">
                      {`✓ ${t('ai.settings.consent.allowed')}`}
                    </p>
                    <button
                      type="button"
                      className="secondary-button"
                      data-testid="ai-consent-revoke"
                      onClick={() => void revokeConsent()}
                    >
                      {t('ai.settings.consent.revoke')}
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="dialog-hint" data-testid="ai-consent-state">
                      {t('ai.settings.consent.notAllowed')}
                    </p>
                    <AiConsentPrompt
                      api={api}
                      projectId={projectId}
                      providerName={t(PROVIDER_LABEL[provider])}
                      onAllowed={() => void refresh()}
                      onDeclined={() => undefined}
                    />
                  </>
                )}
                {history && projectId !== null && revokeChats > 0 && (
                  <RevokeChatsPrompt
                    api={history}
                    projectId={projectId}
                    count={revokeChats}
                    t={t}
                    onDone={(deleted) => {
                      setRevokeChats(0);
                      setRevokeMessage(
                        deleted === null ? null : fill(t('ai.history.revoke.deleted', deleted), { n: deleted }),
                      );
                    }}
                  />
                )}
                {revokeMessage && (
                  <p className="dialog-hint" role="status" data-testid="ai-revoke-chats-result">
                    {revokeMessage}
                  </p>
                )}
              </div>

              {history && <AiUsageSection api={history} t={t} locale={locale} />}
            </>
          )}
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="primary-button dialog-button"
            ref={closeButton}
            data-testid="ai-settings-close"
            onClick={onClose}
          >
            {t('ai.settings.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
