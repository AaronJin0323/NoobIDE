import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AiApi,
  AiErrorCode,
  AiKeyError,
  AiModelInfo,
  AiProviderId,
  AiPurpose,
  AiStatus,
  AiTestError,
} from '../../shared/ipc/ai-contract';
import type { MessageKey } from '../i18n/index';
import type { PlatformId } from '../../platform/labels';
import { rendererPlatform } from '../workbench/file-op-messages';
import { AI_STATUS_CHANGED_EVENT } from './ai-bridge';

/**
 * Shared renderer state of the AI assistant (S31.4), for Settings → AI and every AI surface (S32–S35):
 *
 * - `aiAvailable(status)`: AI may show at all — switched on, a provider chosen, its key stored, secure storage
 *   available. When false, every AI surface is hidden ("AI off removes every AI surface").
 * - `useAiStatus(api, projectId)`: the current status; refreshed when any part of the workbench changes AI settings
 *   or consent (`notifyAiStatusChanged()`).
 * - `openAiSettings()`: opens Settings → AI from anywhere (menus, an error message's button).
 * - `aiErrorKey(code)`: the i18n key explaining an AiErrorCode to a beginner.
 *
 * The API key never passes through here: status only says which providers have one.
 */
export { AI_STATUS_CHANGED_EVENT, OPEN_AI_SETTINGS_EVENT, openAiSettings } from './ai-bridge';

/** Settings or consent changed: every AI surface re-reads the status (the S33 chat panel listens too). */
export function notifyAiStatusChanged(target: EventTarget = window): void {
  target.dispatchEvent(new Event(AI_STATUS_CHANGED_EVENT));
}

export function aiAvailable(status: AiStatus | null): boolean {
  if (!status || !status.config.enabled || !status.secureStorage) return false;
  const provider = status.config.provider;
  return provider !== null && status.keyStored[provider];
}

/** Inline completions may show: AI available, inline switched on, the project allowed, and (S39.2) budget left. */
export function inlineAvailable(status: AiStatus | null): boolean {
  return (
    aiAvailable(status) &&
    status?.config.inlineCompletions === true &&
    status.projectConsent &&
    status.budgetReached !== true
  );
}

/**
 * Wraps an asynchronous read so that only the reply of the newest call is applied: `apply` is skipped for a call that
 * a later one superseded. Main answers status reads concurrently (key storage is read asynchronously), so an older
 * read can answer last: a read sent before the key was removed then switched the AI surfaces back on (the macOS
 * ai-prompt e2e saw `/ai` take Enter after the key was cleared, PR #44 run 39093872611).
 */
export function latestOnly<T>(read: () => Promise<T>, apply: (value: T) => void): () => Promise<void> {
  let newest = 0;
  return async () => {
    newest += 1;
    const call = newest;
    const value = await read();
    if (call === newest) apply(value);
  };
}

export function useAiStatus(
  api: AiApi | undefined,
  projectId: string | null,
): { readonly status: AiStatus | null; readonly refresh: () => Promise<void> } {
  const [status, setStatus] = useState<AiStatus | null>(null);
  // One sequence per api and project: a reply for the previous project is never applied either.
  const read = useMemo(
    () =>
      api
        ? latestOnly(
            () => api.status({ projectId }),
            (result) => {
              if (result.ok) setStatus(result.value);
            },
          )
        : null,
    [api, projectId],
  );
  const refresh = useCallback(async () => {
    await read?.();
  }, [read]);
  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(AI_STATUS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(AI_STATUS_CHANGED_EVENT, onChange);
  }, [refresh]);
  return { status, refresh };
}

export const PROVIDER_LABEL: Readonly<Record<AiProviderId, MessageKey>> = {
  anthropic: 'ai.provider.anthropic',
  openai: 'ai.provider.openai',
};

export const PURPOSE_LABEL: Readonly<Record<AiPurpose, MessageKey>> = {
  chat: 'ai.purpose.chat',
  agent: 'ai.purpose.agent',
  edit: 'ai.purpose.edit',
  inline: 'ai.purpose.inline',
};

/** Purposes in the order Settings lists them. */
export const PURPOSE_ORDER: readonly AiPurpose[] = ['chat', 'agent', 'edit', 'inline'];

export function aiErrorKey(code: AiErrorCode | 'forbidden-sender' | 'invalid-request'): MessageKey {
  switch (code) {
    case 'forbidden-sender':
    case 'invalid-request':
      return 'ai.error.provider-error';
    default:
      return `ai.error.${code}`;
  }
}

/**
 * Fills `{keyStore}` with what protects the API key on this platform (Electron safeStorage: the Keychain on macOS,
 * Windows Data Protection on Windows), so no text names the macOS Keychain on Windows. Other text is unchanged.
 */
export function withKeyStore(
  text: string,
  t: (key: MessageKey) => string,
  platform: PlatformId = rendererPlatform(),
): string {
  if (!text.includes('{keyStore}')) return text;
  const name = t(
    platform === 'mac' ? 'ai.keyStore.mac' : platform === 'windows' ? 'ai.keyStore.windows' : 'ai.keyStore.other',
  );
  return text.replaceAll('{keyStore}', name);
}

export function keyErrorKey(code: AiKeyError | 'forbidden-sender' | 'invalid-request'): MessageKey {
  return code === 'forbidden-sender' || code === 'invalid-request'
    ? 'ai.settings.key.error.empty-key'
    : `ai.settings.key.error.${code}`;
}

export function testErrorKey(code: AiTestError | 'forbidden-sender' | 'invalid-request'): MessageKey {
  return code === 'forbidden-sender' || code === 'invalid-request'
    ? 'ai.settings.test.error.provider-error'
    : `ai.settings.test.error.${code}`;
}

/**
 * The choices of one model select: '' (the default) first, then the provider's models, keeping the current choice
 * even when the list does not have it (an older or custom id).
 */
export function modelChoices(current: string, models: readonly AiModelInfo[] | null): readonly AiModelInfo[] {
  const list = models ?? [];
  const known = current === '' || list.some((m) => m.id === current);
  return known ? list : [{ id: current, displayName: current }, ...list];
}
