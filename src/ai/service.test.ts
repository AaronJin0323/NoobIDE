import { describe, expect, it } from 'vitest';
import type { AiEvent } from '../shared/ipc/ai-contract';
import { AiService, type AiServiceDeps } from './service';
import type { AiProvider, ProviderEvent, ProviderStreamRequest } from './providers/provider';

/**
 * Unit tests of the request lifecycle with a provider whose stream ends quietly when aborted (both provider SDKs do
 * that for an abort mid-stream): an answer cut off by the time budget or Stop must never be reported as complete.
 */
function quietProvider(): AiProvider {
  return {
    id: 'anthropic',
    async *stream(request: ProviderStreamRequest): AsyncGenerator<ProviderEvent> {
      yield { type: 'text', text: 'const half = ' };
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        request.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      // Ends without an error, like the SDK's iterator after an abort.
    },
    listModels: async () => [],
    test: async () => undefined,
  };
}

function service(): AiService {
  const deps: AiServiceDeps = {
    keys: {
      stored: async () => ({ anthropic: true, openai: false }),
      get: async () => 'sk-test',
      set: async () => ({ ok: true, value: null }),
      clear: async () => ({ ok: true, value: null }),
      secureStorageAvailable: () => true,
    },
    config: {
      get: async () => ({ enabled: true, provider: 'anthropic', inlineCompletions: true }),
      modelsOf: async () => ({ chat: 'm', agent: 'm', inline: 'm', edit: 'm' }),
    } as unknown as AiServiceDeps['config'],
    consent: { isAllowed: async () => true } as unknown as AiServiceDeps['consent'],
    providers: () => quietProvider(),
    rootOf: () => '/project',
    readFile: async () => null,
    budgets: { edit: { maxOutputTokens: 100, timeoutMs: 30, effort: 'low' } },
  };
  return new AiService(deps);
}

async function terminal(events: AiEvent[]): Promise<AiEvent> {
  for (let i = 0; i < 200; i += 1) {
    const end = events.find((e) => e.type === 'done' || e.type === 'error');
    if (end) return end;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('no terminal event');
}

const edit = {
  kind: 'edit',
  projectId: 'p',
  relPath: 'a.js',
  languageId: 'javascript',
  instruction: 'fix',
  before: '',
  selection: 'x',
  after: '',
  locale: 'en',
} as const;

describe('AiService: aborted streams', () => {
  it('a request that ran out of time fails as timed out; its partial code is never sent', async () => {
    const events: AiEvent[] = [];
    const started = await service().request(edit as never, 1, (e) => events.push(e));
    expect(started.ok).toBe(true);
    expect(await terminal(events)).toMatchObject({ type: 'error', code: 'provider-error', message: 'timed out' });
    expect(events.filter((e) => e.type === 'text')).toEqual([]);
  });

  it('a stopped request ends as cancelled, not done', async () => {
    const events: AiEvent[] = [];
    const ai = service();
    const started = await ai.request(edit as never, 7, (e) => events.push(e));
    if (!started.ok) throw new Error('not started');
    ai.cancel(started.value.requestId, 7);
    expect(await terminal(events)).toMatchObject({ type: 'error', code: 'cancelled' });
    expect(events.some((e) => e.type === 'done' || e.type === 'text')).toBe(false);
  });
});
