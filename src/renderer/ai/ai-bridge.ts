/**
 * The renderer's access to the AI bridge (S31 exposes `window.noobide.ai`, contract src/shared/ipc/ai-contract.ts).
 * Read structurally so the chat panel builds before and after S31 adds `ai` to `NoobideApi`: without it every AI
 * surface stays hidden (offline first, decision 0025).
 */
import type { AiApi } from '../../shared/ipc/ai-contract';

export function aiBridge(): AiApi | undefined {
  if (typeof window === 'undefined') return undefined;
  const bridge = window.noobide as { readonly ai?: AiApi } | undefined;
  return bridge?.ai;
}

/**
 * Settings → AI (S31) listens for this event and opens; the chat panel's "Open AI settings" button dispatches it.
 * `aiSettingsAvailable()` says whether anything listens (otherwise the panel tells where the settings are).
 */
export const OPEN_AI_SETTINGS_EVENT = 'noobide:open-ai-settings';
/** S31 dispatches this on window after the AI settings or a project's consent changed; the panel re-reads status. */
export const AI_STATUS_CHANGED_EVENT = 'noobide:ai-status-changed';

let settingsListeners = 0;

export function openAiSettings(target: EventTarget = window): void {
  target.dispatchEvent(new Event(OPEN_AI_SETTINGS_EVENT));
}

/** For Settings → AI: registers the opener. Returns the unsubscribe function. */
export function onOpenAiSettings(listener: () => void, target: EventTarget = window): () => void {
  target.addEventListener(OPEN_AI_SETTINGS_EVENT, listener);
  settingsListeners += 1;
  return () => {
    target.removeEventListener(OPEN_AI_SETTINGS_EVENT, listener);
    settingsListeners -= 1;
  };
}

export function aiSettingsAvailable(): boolean {
  return settingsListeners > 0;
}
