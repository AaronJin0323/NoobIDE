import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { createOpenAiProvider, type OpenAiClientLike } from './openai';
import { pickOpenAiDefaults, type ProviderEvent, type ProviderTool } from './provider';

/** S31.1: the OpenAI provider against the real `openai` client with a mocked `fetch`; no network. */
interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
}

function clientWith(respond: (req: Captured) => Response): { client: OpenAiClientLike; seen: Captured[] } {
  const seen: Captured[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const captured = { url, body, headers: new Headers(init?.headers) };
    seen.push(captured);
    return respond(captured);
  };
  return {
    client: new OpenAI({ apiKey: 'sk-openai-test', fetch, maxRetries: 0 }) as unknown as OpenAiClientLike,
    seen,
  };
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, unknown>) => ({
  id: 'c1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-x',
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...(usage ? { usage } : {}),
});

const sse = (chunks: readonly unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

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
    properties: { relPath: { type: 'string' } },
    required: ['relPath'],
    additionalProperties: false,
  },
};

describe('OpenAI provider (S31.1)', () => {
  it('streams text and usage with the system prompt first', async () => {
    const { client, seen } = clientWith(() =>
      sse([
        chunk({ role: 'assistant', content: 'Hel' }),
        chunk({ content: 'lo' }),
        chunk({}, 'stop'),
        {
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gpt-x',
          choices: [],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 2,
            total_tokens: 22,
            prompt_tokens_details: { cached_tokens: 8 },
          },
        },
      ]),
    );
    const events = await collect(
      createOpenAiProvider('u', { client }).stream({
        model: 'gpt-x',
        purpose: 'chat',
        system: 'Be kind.',
        messages: [{ role: 'user', text: 'hi' }],
        maxOutputTokens: 500,
      }),
    );
    expect(events.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.text : ''))).toEqual([
      'Hel',
      'lo',
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'stop',
      reason: 'end',
      usage: { inputTokens: 20, outputTokens: 2, cacheReadTokens: 8 },
      assistant: { text: 'Hello' },
    });
    expect(seen[0]?.url).toContain('/chat/completions');
    expect(seen[0]?.body).toMatchObject({
      model: 'gpt-x',
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 500,
      messages: [
        { role: 'developer', content: 'Be kind.' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer sk-openai-test');
  });

  it('assembles streamed tool calls and validates their arguments', async () => {
    const { client, seen } = clientWith(() =>
      sse([
        chunk({
          tool_calls: [
            { index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"relP' } },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'ath":"a.html"}' } }] }),
        chunk({
          tool_calls: [
            { index: 1, id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{bad' } },
          ],
        }),
        chunk({}, 'tool_calls'),
      ]),
    );
    const events = await collect(
      createOpenAiProvider('u', { client }).stream({
        model: 'gpt-x',
        purpose: 'agent',
        system: 's',
        messages: [{ role: 'user', text: 'go' }],
        tools: [READ_FILE],
        maxOutputTokens: 500,
      }),
    );
    expect(seen[0]?.body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'read_file', description: 'Read a project file', parameters: READ_FILE.inputSchema },
      },
    ]);
    expect(events.filter((e) => e.type === 'tool-call')).toEqual([
      { type: 'tool-call', call: { id: 'call_1', name: 'read_file', input: { relPath: 'a.html' } } },
    ]);
    expect(events.filter((e) => e.type === 'tool-call-invalid')).toMatchObject([
      { id: 'call_2', problem: 'input is not valid JSON' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'stop', reason: 'tool-use' });
  });

  it('reports refusals and sends tool results back as tool messages', async () => {
    const { client, seen } = clientWith(() => sse([chunk({ refusal: "I can't help" }), chunk({}, 'stop')]));
    const events = await collect(
      createOpenAiProvider('u', { client }).stream({
        model: 'gpt-x',
        purpose: 'agent',
        system: 's',
        messages: [
          { role: 'user', text: 'go' },
          { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'read_file', input: { relPath: 'a' } }] },
          { role: 'tool', results: [{ callId: 'call_1', content: 'text' }] },
        ],
        maxOutputTokens: 500,
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'stop', reason: 'refusal' });
    expect(seen[0]?.body.messages).toEqual([
      { role: 'developer', content: 's' },
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"relPath":"a"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'text' },
    ]);
  });

  it('maps HTTP failures to provider error codes', async () => {
    for (const [status, code] of [
      [401, 'unauthorized'],
      [404, 'model-not-found'],
      [429, 'rate-limited'],
      [500, 'provider-error'],
    ] as const) {
      const { client } = clientWith(
        () =>
          new Response(JSON.stringify({ error: { message: 'no', type: 'x', code: null } }), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
      );
      await expect(createOpenAiProvider('u', { client }).test()).rejects.toMatchObject({ code });
    }
    const offline = clientWith(() => {
      throw new TypeError('fetch failed');
    });
    await expect(createOpenAiProvider('u', { client: offline.client }).test()).rejects.toMatchObject({
      code: 'offline',
    });
  });

  it('lists chat models newest first and picks defaults from them', async () => {
    const { client } = clientWith(
      () =>
        new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'whisper-1', object: 'model', created: 5, owned_by: 'x' },
              { id: 'gpt-old', object: 'model', created: 1, owned_by: 'x' },
              { id: 'gpt-new-mini', object: 'model', created: 3, owned_by: 'x' },
              { id: 'gpt-new', object: 'model', created: 3, owned_by: 'x' },
              { id: 'text-embedding-3', object: 'model', created: 4, owned_by: 'x' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const models = await createOpenAiProvider('u', { client }).listModels();
    expect(models.map((m) => m.id)).toEqual(['gpt-new-mini', 'gpt-new', 'gpt-old']);
    expect(pickOpenAiDefaults(models)).toEqual({
      chat: 'gpt-new',
      agent: 'gpt-new',
      edit: 'gpt-new',
      inline: 'gpt-new-mini',
    });
    expect(pickOpenAiDefaults([])).toBeNull();
  });
});
