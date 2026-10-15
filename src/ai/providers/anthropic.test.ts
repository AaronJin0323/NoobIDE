import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createAnthropicProvider, mapAnthropicError, type AnthropicClientLike } from './anthropic';
import { ProviderError, type ProviderEvent, type ProviderTool } from './provider';

/**
 * S31.1: the Anthropic provider against the real @anthropic-ai/sdk client with a mocked `fetch` (SDK-level mock):
 * no test reaches the network. Checks the request shape (streaming, adaptive thinking, prompt caching, eager tool
 * input streaming, fallbacks), stream parsing, tool input validation, refusal and error mapping.
 */
interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function sse(events: readonly Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function messageEvents(opts: {
  blocks: readonly ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; json: string })[];
  stopReason: string;
}): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      },
    },
  ];
  opts.blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const part of block.text.match(/.{1,4}/gs) ?? []) {
        events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } });
      }
    } else {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: block.json },
      });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: opts.stopReason, stop_sequence: null },
    usage: { output_tokens: 7 },
  });
  events.push({ type: 'message_stop' });
  return events;
}

function clientWith(respond: (req: Captured) => Response): { client: AnthropicClientLike; seen: Captured[] } {
  const seen: Captured[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const captured = { url, headers: new Headers(init?.headers), body };
    seen.push(captured);
    return respond(captured);
  };
  const client = new Anthropic({ apiKey: 'sk-ant-test-key', fetch, maxRetries: 0 }) as unknown as AnthropicClientLike;
  return { client, seen };
}

const streamResponse = (events: Record<string, unknown>[]) =>
  new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });

async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

const READ_FILE: ProviderTool = {
  name: 'read_file',
  description: 'Read a project file',
  inputSchema: {
    type: 'object',
    properties: { relPath: { type: 'string', minLength: 1 } },
    required: ['relPath'],
    additionalProperties: false,
  },
};

describe('Anthropic provider (S31.1)', () => {
  it('streams text with adaptive thinking, prompt caching, fallbacks and usage', async () => {
    const { client, seen } = clientWith(() =>
      streamResponse(messageEvents({ blocks: [{ type: 'text', text: 'Hello there' }], stopReason: 'end_turn' })),
    );
    const provider = createAnthropicProvider('unused', { client });
    const events = await collect(
      provider.stream({
        model: 'claude-opus-5-5',
        purpose: 'chat',
        system: 'You help beginners.',
        messages: [{ role: 'user', text: 'hi' }],
        maxOutputTokens: 4000,
        effort: 'medium',
      }),
    );
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => (e.type === 'text' ? e.text : ''))
        .join(''),
    ).toBe('Hello there');
    const stop = events.at(-1);
    expect(stop).toMatchObject({
      type: 'stop',
      reason: 'end',
      usage: { inputTokens: 112, outputTokens: 7, cacheReadTokens: 100 },
      assistant: { role: 'assistant', text: 'Hello there', native: { provider: 'anthropic' } },
    });
    const request = seen[0];
    expect(request?.url).toContain('/v1/messages');
    expect(request?.body).toMatchObject({
      model: 'claude-opus-5-5',
      stream: true,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: [{ type: 'text', text: 'You help beginners.', cache_control: { type: 'ephemeral' } }],
      cache_control: { type: 'ephemeral' },
      fallbacks: 'default',
    });
    expect(request?.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(request?.headers.get('x-api-key')).toBe('sk-ant-test-key');
  });

  it('declares tools with eager input streaming and reports only validated tool calls', async () => {
    const { client, seen } = clientWith(() =>
      streamResponse(
        messageEvents({
          blocks: [
            { type: 'text', text: 'Reading.' },
            { type: 'tool_use', id: 'toolu_1', name: 'read_file', json: '{"relPath":"index.html"}' },
            { type: 'tool_use', id: 'toolu_2', name: 'read_file', json: '{"path":"x"}' },
          ],
          stopReason: 'tool_use',
        }),
      ),
    );
    const provider = createAnthropicProvider('unused', { client });
    const events = await collect(
      provider.stream({
        model: 'claude-opus-5-5',
        purpose: 'agent',
        system: 's',
        messages: [{ role: 'user', text: 'go' }],
        tools: [READ_FILE],
        maxOutputTokens: 1000,
      }),
    );
    expect(seen[0]?.body.tools).toEqual([
      {
        name: 'read_file',
        description: 'Read a project file',
        input_schema: READ_FILE.inputSchema,
        eager_input_streaming: true,
      },
    ]);
    expect(events.filter((e) => e.type === 'tool-call')).toEqual([
      { type: 'tool-call', call: { id: 'toolu_1', name: 'read_file', input: { relPath: 'index.html' } } },
    ]);
    expect(events.filter((e) => e.type === 'tool-call-invalid')).toEqual([
      { type: 'tool-call-invalid', id: 'toolu_2', name: 'read_file', problem: 'input.relPath is required' },
    ]);
    const stop = events.at(-1);
    expect(stop?.type === 'stop' && stop.reason).toBe('tool-use');
    // The native blocks (incl. both tool_use blocks) are kept to be echoed back unchanged.
    expect(stop?.type === 'stop' && (stop.assistant.native?.content as unknown[]).length).toBe(3);
  });

  it('never reports tool calls of a turn that stopped on refusal or max_tokens', async () => {
    for (const stopReason of ['refusal', 'max_tokens']) {
      const { client } = clientWith(() =>
        streamResponse(
          messageEvents({
            blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', json: '{"relPath":"a.html"}' }],
            stopReason,
          }),
        ),
      );
      const events = await collect(
        createAnthropicProvider('unused', { client }).stream({
          model: 'claude-opus-5-5',
          purpose: 'agent',
          system: 's',
          messages: [{ role: 'user', text: 'go' }],
          tools: [READ_FILE],
          maxOutputTokens: 1000,
        }),
      );
      expect(events.some((e) => e.type === 'tool-call')).toBe(false);
      const stop = events.at(-1);
      expect(stop?.type === 'stop' && stop.reason).toBe(stopReason === 'refusal' ? 'refusal' : 'max-tokens');
    }
  });

  it('echoes native assistant blocks and sends tool results as tool_result blocks', async () => {
    const { client, seen } = clientWith(() =>
      streamResponse(messageEvents({ blocks: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' })),
    );
    const native = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { relPath: 'a.html' } },
    ];
    await collect(
      createAnthropicProvider('unused', { client }).stream({
        model: 'claude-opus-5-5',
        purpose: 'agent',
        system: 's',
        messages: [
          { role: 'user', text: 'go' },
          { role: 'assistant', text: '', native: { provider: 'anthropic', content: native } },
          { role: 'tool', results: [{ callId: 'toolu_1', content: '<html></html>' }] },
        ],
        tools: [READ_FILE],
        maxOutputTokens: 1000,
      }),
    );
    expect(seen[0]?.body.messages).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: native },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '<html></html>' }] },
    ]);
  });

  it('maps HTTP failures to provider error codes', async () => {
    const cases: [number, string][] = [
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [404, 'model-not-found'],
      [429, 'rate-limited'],
      [413, 'context-too-large'],
      [500, 'provider-error'],
    ];
    for (const [status, code] of cases) {
      const { client } = clientWith(
        () =>
          new Response(JSON.stringify({ type: 'error', error: { type: 'x', message: 'nope' } }), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const provider = createAnthropicProvider('unused', { client });
      await expect(provider.test()).rejects.toMatchObject({ code });
      await expect(
        collect(
          provider.stream({
            model: 'm',
            purpose: 'chat',
            system: 's',
            messages: [{ role: 'user', text: 'x' }],
            maxOutputTokens: 10,
          }),
        ),
      ).rejects.toMatchObject({ code });
    }
  });

  it('maps a connection failure to offline and an abort to cancelled', async () => {
    const offline = clientWith(() => {
      throw new TypeError('fetch failed');
    });
    await expect(createAnthropicProvider('u', { client: offline.client }).test()).rejects.toMatchObject({
      code: 'offline',
    });
    const controller = new AbortController();
    controller.abort();
    expect(mapAnthropicError(new Error('x'), controller.signal).code).toBe('cancelled');
    expect(mapAnthropicError(new ProviderError('rate-limited', 'r')).code).toBe('rate-limited');
  });

  it('lists models with their display names', async () => {
    const { client, seen } = clientWith(
      () =>
        new Response(
          JSON.stringify({
            data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01' }],
            has_more: false,
            first_id: 'claude-opus-5-5',
            last_id: 'claude-opus-5-5',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    expect(await createAnthropicProvider('u', { client }).listModels()).toEqual([
      { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
    ]);
    expect(seen[0]?.url).toContain('/v1/models');
  });
});
