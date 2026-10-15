/**
 * A fake `window.noobide.ai` for the S32.1 unit tests: records requests and cancels, lets the test emit events.
 * Implements the whole AiApi so the tests compile against the real contract.
 */
import type { AiApi, AiConfig, AiErrorCode, AiEvent, AiRequest, AiStatus } from '../../shared/ipc/ai-contract';

export const CONFIG: AiConfig = {
  enabled: true,
  provider: 'anthropic',
  models: { chat: 'claude-opus-5-5', agent: 'claude-opus-5-5', edit: 'claude-opus-5-5', inline: 'claude-haiku-5-5' },
  inlineCompletions: true,
};

export const STATUS: AiStatus = {
  config: CONFIG,
  keyStored: { anthropic: true, openai: false },
  secureStorage: true,
  projectConsent: true,
};

export class FakeAiBridge implements AiApi {
  readonly requests: AiRequest[] = [];
  readonly cancels: string[] = [];
  readonly statusCalls: (string | null)[] = [];
  readonly configs: AiConfig[] = [];
  current: AiStatus = STATUS;
  /** When set, request() is refused with this code. */
  refuse: AiErrorCode | null = null;
  /** Events emitted inside request(), before its answer arrives (main may be that fast). */
  earlyEvents: (requestId: string) => AiEvent[] = () => [];
  private next = 0;
  private readonly listeners = new Set<(event: AiEvent) => void>();

  status(request: { readonly projectId: string | null }) {
    this.statusCalls.push(request.projectId);
    return Promise.resolve({ ok: true as const, value: this.current });
  }
  setKey() {
    return Promise.resolve({ ok: true as const, value: null });
  }
  clearKey() {
    return Promise.resolve({ ok: true as const, value: null });
  }
  testKey() {
    return Promise.resolve({ ok: true as const, value: null });
  }
  listModels() {
    return Promise.resolve({ ok: true as const, value: [] });
  }
  setConfig(request: { readonly config: AiConfig }) {
    this.configs.push(request.config);
    this.current = { ...this.current, config: request.config };
    return Promise.resolve({ ok: true as const, value: request.config });
  }
  setConsent() {
    return Promise.resolve({ ok: true as const, value: null });
  }
  request(request: AiRequest): ReturnType<AiApi['request']> {
    this.requests.push(request);
    if (this.refuse) return Promise.resolve({ ok: false as const, code: this.refuse, message: '' });
    this.next += 1;
    const requestId = `r${this.next}`;
    for (const event of this.earlyEvents(requestId)) this.emit(event);
    return Promise.resolve({ ok: true as const, value: { requestId } });
  }
  cancel(request: { readonly requestId: string }) {
    this.cancels.push(request.requestId);
    return Promise.resolve({ ok: true as const, value: null });
  }
  resolveProposal() {
    return Promise.resolve({ ok: true as const, value: null });
  }
  onEvent(listener: (event: AiEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(event: AiEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  /** Streams `chunks` as text events and finishes the request. */
  stream(requestId: string, chunks: readonly string[]): void {
    for (const text of chunks) this.emit({ requestId, type: 'text', text });
    this.emit({ requestId, type: 'done', usage: { inputTokens: 10, outputTokens: 5 } });
  }
}
