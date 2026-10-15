/**
 * A scripted fake of the renderer's AI bridge (`window.noobide.ai`) for unit tests of the chat (S33). Records every
 * call; tests push events with `emit` and decide each request's answer with `nextRequest`.
 */
import type {
  AiApi,
  AiErrorCode,
  AiEvent,
  AiPreviewSnapshot,
  AiPreviewSnapshotError,
  AiRequest,
  AiStatus,
} from '../../shared/ipc/ai-contract';

export interface FakeAiApi extends AiApi {
  readonly requests: AiRequest[];
  readonly cancels: string[];
  readonly consents: { projectId: string; allowed: boolean }[];
  status: AiApi['status'];
  current: AiStatus;
  emit(event: AiEvent): void;
  /** S38.2: what previewSnapshot() answers (default: the preview is not running). */
  snapshot: AiPreviewSnapshot | AiPreviewSnapshotError;
  readonly snapshotRequests: { projectId: string; locale: string }[];
  /** The next request() result: an id (default `r<n>`) or an error code. Events to emit before it returns. */
  nextRequest: { error?: AiErrorCode | 'invalid-request'; early?: (requestId: string) => AiEvent[] } | null;
}

export function readyStatus(overrides: Partial<AiStatus> = {}): AiStatus {
  return {
    config: {
      enabled: true,
      provider: 'anthropic',
      models: {
        chat: 'claude-opus-5-5',
        agent: 'claude-opus-5-5',
        inline: 'claude-haiku-5-5',
        edit: 'claude-opus-5-5',
      },
      inlineCompletions: true,
    },
    keyStored: { anthropic: true, openai: false },
    secureStorage: true,
    projectConsent: true,
    ...overrides,
  };
}

export function fakeAiApi(status: AiStatus = readyStatus()): FakeAiApi {
  const listeners = new Set<(event: AiEvent) => void>();
  let n = 0;
  const api: FakeAiApi = {
    requests: [],
    cancels: [],
    consents: [],
    current: status,
    nextRequest: null,
    snapshot: 'not-running',
    snapshotRequests: [],
    previewSnapshot: async (request) => {
      api.snapshotRequests.push({ ...request });
      return typeof api.snapshot === 'string'
        ? { ok: false, code: api.snapshot, message: `fake ${api.snapshot}` }
        : { ok: true, value: api.snapshot };
    },
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    status: async () => ({ ok: true, value: api.current }),
    setKey: async () => ({ ok: true, value: null }),
    clearKey: async () => ({ ok: true, value: null }),
    testKey: async () => ({ ok: true, value: null }),
    listModels: async () => ({ ok: true, value: [] }),
    setConfig: async ({ config }) => ({ ok: true, value: config }),
    setConsent: async (request) => {
      api.consents.push({ ...request });
      api.current = { ...api.current, projectConsent: request.allowed };
      return { ok: true, value: null };
    },
    request: async (request) => {
      api.requests.push(request);
      const next = api.nextRequest;
      api.nextRequest = null;
      if (next?.error) return { ok: false, code: next.error, message: `fake ${next.error}` };
      n += 1;
      const requestId = `r${n}`;
      for (const event of next?.early?.(requestId) ?? []) api.emit(event);
      return { ok: true, value: { requestId } };
    },
    cancel: async ({ requestId }) => {
      api.cancels.push(requestId);
      return { ok: true, value: null };
    },
    resolveProposal: async () => ({ ok: true, value: null }),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return api;
}
