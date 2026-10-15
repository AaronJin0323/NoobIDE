import { describe, expect, it } from 'vitest';
import { createFakeProviders, parseFakeScript } from './fake-provider';
import type { ProviderEvent, ProviderStreamRequest, ProviderTool } from './providers/provider';
import { validateJsonSchema } from './providers/schema';

/** S31.1: the scripted fake provider used by every AI test, and the tool-input schema validator. */
async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

const TOOL: ProviderTool = {
  name: 'read_file',
  description: 'read',
  inputSchema: {
    type: 'object',
    properties: { relPath: { type: 'string' } },
    required: ['relPath'],
    additionalProperties: false,
  },
};

const request = (text: string, extra: Partial<ProviderStreamRequest> = {}): ProviderStreamRequest => ({
  model: 'fake-large',
  purpose: 'chat',
  system: 'sys',
  messages: [{ role: 'user', text }],
  maxOutputTokens: 100,
  ...extra,
});

describe('fake provider (S31.1)', () => {
  it('plays scripted text turns by match, purpose and order, then the default turn', async () => {
    const hub = createFakeProviders(
      parseFakeScript({
        turns: [
          {
            match: 'hello',
            steps: [
              { type: 'text', text: 'Hi ' },
              { type: 'text', text: 'there' },
            ],
            usage: { inputTokens: 3, outputTokens: 2 },
          },
          { purpose: 'inline', repeat: true, steps: [{ type: 'text', text: 'ghost' }] },
        ],
        defaultTurn: { steps: [{ type: 'text', text: 'default' }] },
      }),
    );
    const provider = hub.factory('anthropic', 'sk-good');
    const first = await collect(provider.stream(request('hello world')));
    expect(first).toEqual([
      { type: 'text', text: 'Hi ' },
      { type: 'text', text: 'there' },
      {
        type: 'stop',
        reason: 'end',
        usage: { inputTokens: 3, outputTokens: 2 },
        assistant: { role: 'assistant', text: 'Hi there', native: { provider: 'fake', content: null } },
      },
    ]);
    // Used up: the same prompt now gets the default turn; repeatable inline turns stay.
    expect((await collect(provider.stream(request('hello')))).at(0)).toEqual({ type: 'text', text: 'default' });
    for (let i = 0; i < 2; i += 1) {
      expect((await collect(provider.stream(request('x', { purpose: 'inline' })))).at(0)).toEqual({
        type: 'text',
        text: 'ghost',
      });
    }
    expect(hub.requests).toHaveLength(4);
    expect(hub.requests[0]).toMatchObject({
      provider: 'anthropic',
      purpose: 'chat',
      model: 'fake-large',
      system: 'sys',
    });
  });

  it('reports valid tool calls, rejects invalid ones and honours an explicit refusal', async () => {
    const hub = createFakeProviders(
      parseFakeScript({
        turns: [
          {
            match: 'tools',
            steps: [
              { type: 'tool-call', id: 'a', name: 'read_file', input: { relPath: 'index.html' } },
              { type: 'tool-call', id: 'b', name: 'read_file', input: { nope: 1 } },
            ],
          },
          {
            match: 'refuse',
            steps: [{ type: 'tool-call', name: 'read_file', input: { relPath: 'x' } }],
            stop: 'refusal',
          },
        ],
      }),
    );
    const provider = hub.factory('openai', 'k');
    const events = await collect(provider.stream(request('tools', { tools: [TOOL] })));
    expect(events.filter((e) => e.type === 'tool-call')).toEqual([
      { type: 'tool-call', call: { id: 'a', name: 'read_file', input: { relPath: 'index.html' } } },
    ]);
    expect(events.filter((e) => e.type === 'tool-call-invalid')).toEqual([
      { type: 'tool-call-invalid', id: 'b', name: 'read_file', problem: 'input.relPath is required' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'stop', reason: 'tool-use' });
    const refused = await collect(provider.stream(request('refuse', { tools: [TOOL] })));
    expect(refused.some((e) => e.type === 'tool-call')).toBe(false);
    expect(refused.at(-1)).toMatchObject({ type: 'stop', reason: 'refusal' });
  });

  it('throws scripted errors, rejects listed keys and cancels slow streams', async () => {
    const hub = createFakeProviders(
      parseFakeScript({
        rejectKeys: ['sk-bad'],
        turns: [
          {
            match: 'boom',
            steps: [
              { type: 'text', text: 'a' },
              { type: 'error', code: 'rate-limited' },
            ],
          },
          {
            match: 'slow',
            steps: [
              { type: 'text', text: 'a' },
              { type: 'delay', ms: 10_000 },
              { type: 'text', text: 'b' },
            ],
          },
        ],
      }),
    );
    await expect(collect(hub.factory('anthropic', 'k').stream(request('boom')))).rejects.toMatchObject({
      code: 'rate-limited',
    });
    await expect(hub.factory('anthropic', 'sk-bad').test()).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(hub.factory('anthropic', 'sk-good').test()).resolves.toBeUndefined();
    expect((await hub.factory('openai', 'sk-good').listModels()).length).toBeGreaterThan(0);

    const controller = new AbortController();
    const seen: string[] = [];
    const started = Date.now();
    const run = (async () => {
      for await (const event of hub.factory('anthropic', 'k').stream(request('slow', { signal: controller.signal }))) {
        if (event.type === 'text') {
          seen.push(event.text);
          controller.abort();
        }
      }
    })();
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
    expect(seen).toEqual(['a']);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('applies testError to test and listModels', async () => {
    const hub = createFakeProviders(parseFakeScript({ testError: 'offline' }));
    await expect(hub.factory('openai', 'k').test()).rejects.toMatchObject({ code: 'offline' });
    await expect(hub.factory('openai', 'k').listModels()).rejects.toMatchObject({ code: 'offline' });
  });

  it('rejects malformed scripts', () => {
    expect(() => parseFakeScript([])).toThrow();
    expect(() => parseFakeScript({ turns: [{ steps: [{ type: 'nope' }] }] })).toThrow();
    expect(() => parseFakeScript({ turns: [{ steps: [{ type: 'error', code: 'weird' }] }] })).toThrow();
    expect(parseFakeScript({ secureStorage: false })).toMatchObject({ secureStorage: false, turns: [] });
  });
});

describe('tool input schema validation (S31.1)', () => {
  const schema = {
    type: 'object',
    properties: {
      relPath: { type: 'string', minLength: 1, maxLength: 5 },
      line: { type: 'integer', minimum: 1 },
      kind: { type: 'string', enum: ['a', 'b'] },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
      flag: { type: 'boolean' },
    },
    required: ['relPath'],
    additionalProperties: false,
  } as const;

  it.each([
    [{ relPath: 'a' }, null],
    [{ relPath: 'a', line: 2, kind: 'b', tags: ['x'], flag: true }, null],
    [null, 'input must be an object'],
    [[], 'input must be an object'],
    [{}, 'input.relPath is required'],
    [{ relPath: '' }, 'input.relPath is too short'],
    [{ relPath: 'toolong' }, 'input.relPath is too long'],
    [{ relPath: 'a', line: 1.5 }, 'input.line must be an integer'],
    [{ relPath: 'a', line: 0 }, 'input.line is too small'],
    [{ relPath: 'a', kind: 'c' }, 'input.kind must be one of a, b'],
    [{ relPath: 'a', tags: [1] }, 'input.tags[0] must be a string'],
    [{ relPath: 'a', tags: ['1', '2', '3'] }, 'input.tags has too many items'],
    [{ relPath: 'a', flag: 'yes' }, 'input.flag must be true or false'],
    [{ relPath: 'a', extra: 1 }, 'input.extra is not allowed'],
  ])('%j → %s', (value, problem) => {
    expect(validateJsonSchema(schema, value)).toBe(problem);
  });
});
