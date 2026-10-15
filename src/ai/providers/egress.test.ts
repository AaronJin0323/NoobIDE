import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider } from './anthropic';
import { createOpenAiProvider } from './openai';
import { EgressBlockedError, envHeaderNames, guardedFetch, PROVIDER_ORIGINS } from './egress';

/**
 * S36.1 security review finding 2: environment variables that the SDKs read (endpoint, auth token, custom headers,
 * debug logging) must not redirect the user's key or code, add credentials, or print request bodies. The real SDK
 * clients are built by the providers with a recording transport; no network.
 */
const ENV = {
  ANTHROPIC_BASE_URL: 'http://evil.test',
  ANTHROPIC_AUTH_TOKEN: 'stolen-bearer',
  ANTHROPIC_CUSTOM_HEADERS: 'X-Exfil: 1\nX-Other: two',
  ANTHROPIC_LOG: 'debug',
  OPENAI_BASE_URL: 'http://evil.test/v1',
  OPENAI_ORG_ID: 'org-evil',
  OPENAI_PROJECT_ID: 'proj-evil',
  OPENAI_CUSTOM_HEADERS: 'X-Exfil: 1',
  OPENAI_LOG: 'debug',
};

interface Sent {
  url: string;
  headers: Headers;
}

function recorder(body: unknown) {
  const sent: Sent[] = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input instanceof Request ? input.url : input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { sent, transport };
}

let saved: Record<string, string | undefined>;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  saved = {};
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const spy of consoleSpies) spy.mockRestore();
});

describe('provider egress', () => {
  it('Anthropic: only api.anthropic.com, no bearer token, no injected headers, no SDK logging', async () => {
    const { sent, transport } = recorder({ data: [{ id: 'claude-opus-5-5', display_name: 'Opus' }], has_more: false });
    const models = await createAnthropicProvider('sk-ant-key', { fetch: transport }).listModels();
    expect(models.map((m) => m.id)).toEqual(['claude-opus-5-5']);
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      expect(new URL(request.url).origin).toBe(PROVIDER_ORIGINS.anthropic);
      expect(request.headers.get('authorization')).toBeNull();
      expect(request.headers.get('x-api-key')).toBe('sk-ant-key');
      expect(request.headers.get('x-exfil')).toBeNull();
      expect(request.headers.get('x-other')).toBeNull();
    }
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('OpenAI: only api.openai.com, no organization/project, no injected headers, no SDK logging', async () => {
    const { sent, transport } = recorder({ object: 'list', data: [{ id: 'gpt-5', created: 1, object: 'model' }] });
    await createOpenAiProvider('sk-openai-key', { fetch: transport }).listModels();
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      expect(new URL(request.url).origin).toBe(PROVIDER_ORIGINS.openai);
      expect(request.headers.get('authorization')).toBe('Bearer sk-openai-key');
      expect(request.headers.get('openai-organization')).toBeNull();
      expect(request.headers.get('openai-project')).toBeNull();
      expect(request.headers.get('x-exfil')).toBeNull();
    }
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('guardedFetch never sends to another host', async () => {
    const { sent, transport } = recorder({});
    const guarded = guardedFetch(PROVIDER_ORIGINS.anthropic, 'ANTHROPIC_CUSTOM_HEADERS', transport);
    await expect(guarded('https://api.anthropic.com.evil.test/v1/models')).rejects.toBeInstanceOf(EgressBlockedError);
    await expect(guarded('http://api.anthropic.com/v1/models')).rejects.toBeInstanceOf(EgressBlockedError);
    await expect(guarded('not a url')).rejects.toBeInstanceOf(EgressBlockedError);
    expect(sent).toEqual([]);
    await guarded(new URL('https://api.anthropic.com/v1/models'));
    expect(sent).toHaveLength(1);
  });

  it('parses custom-header variable names like the SDKs do', () => {
    expect(envHeaderNames('A: 1\n B :2\nnocolon\n: empty')).toEqual(['a', 'b']);
    expect(envHeaderNames(undefined)).toEqual([]);
  });
});
