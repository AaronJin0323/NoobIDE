import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions/completions';
import type { AiModelInfo } from '../../shared/ipc/ai-contract';
import { guardedFetch, PROVIDER_ORIGINS, SILENT_LOGGER } from './egress';
import {
  ProviderError,
  toolInputProblem,
  type AiProvider,
  type ProviderEvent,
  type ProviderMessage,
  type ProviderStopReason,
  type ProviderStreamRequest,
  type ProviderToolCall,
} from './provider';

/**
 * OpenAI provider over the official `openai` SDK (S31.1, decision 0025), using the Chat Completions API (stateless:
 * NoobIDE keeps the history and sends it each turn, like the Anthropic provider). Streaming with usage, function
 * tools whose JSON arguments are parsed and validated against the schema before they are reported, refusals
 * (`delta.refusal` / `content_filter`) reported as stop reason 'refusal', and the SDK's typed errors mapped to
 * ProviderError codes. OpenAI caches long prompt prefixes automatically; the stable system prompt goes first.
 */
export interface OpenAiClientLike {
  readonly chat: {
    readonly completions: {
      create(
        params: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<ChatCompletionChunk>>;
    };
  };
  readonly models: {
    list(options?: { signal?: AbortSignal }): AsyncIterable<{ id: string; created?: number }>;
  };
}

export interface OpenAiProviderOptions {
  readonly client?: OpenAiClientLike;
  /** For tests: the transport under the egress guard (default: global fetch). */
  readonly fetch?: typeof fetch;
}

/**
 * The real SDK client, with every option the SDK would otherwise take from the environment set explicitly (endpoint,
 * organization, project, logging) and requests confined to api.openai.com (egress.ts, S36.1).
 */
export function createOpenAiClient(apiKey: string, transport?: typeof fetch): OpenAI {
  return new OpenAI({
    apiKey,
    adminAPIKey: null,
    organization: null,
    project: null,
    baseURL: `${PROVIDER_ORIGINS.openai}/v1`,
    timeout: 10 * 60 * 1000,
    logLevel: 'off',
    logger: SILENT_LOGGER,
    fetch: guardedFetch(PROVIDER_ORIGINS.openai, 'OPENAI_CUSTOM_HEADERS', transport),
  });
}

/** Model ids that are not chat models (audio, images, embeddings, moderation…). */
const NOT_CHAT =
  /(audio|realtime|tts|transcribe|image|embedding|search|dall-e|whisper|moderation|davinci|babbage|instruct)/;
const CHAT = /^(gpt-|o\d|chatgpt-|codex)/;

export function createOpenAiProvider(apiKey: string, options: OpenAiProviderOptions = {}): AiProvider {
  const client: OpenAiClientLike =
    options.client ?? (createOpenAiClient(apiKey, options.fetch) as unknown as OpenAiClientLike);

  return {
    id: 'openai',
    stream: (request) => streamTurn(client, request),
    async listModels(signal) {
      try {
        const models: { id: string; created: number }[] = [];
        for await (const model of client.models.list(signal ? { signal } : {})) {
          if (CHAT.test(model.id) && !NOT_CHAT.test(model.id))
            models.push({ id: model.id, created: model.created ?? 0 });
        }
        // Newest first, so defaults pick the current generation.
        models.sort((a, b) => b.created - a.created || b.id.localeCompare(a.id));
        return models.map((m): AiModelInfo => ({ id: m.id, displayName: m.id }));
      } catch (e) {
        throw mapOpenAiError(e, signal);
      }
    },
    async test(signal) {
      try {
        for await (const model of client.models.list(signal ? { signal } : {})) {
          void model;
          break;
        }
      } catch (e) {
        throw mapOpenAiError(e, signal);
      }
    },
  };
}

export function toOpenAiMessages(system: string, messages: readonly ProviderMessage[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: 'developer', content: system }];
  for (const message of messages) {
    if (message.role === 'user') out.push({ role: 'user', content: message.text });
    else if (message.role === 'tool') {
      for (const result of message.results) {
        out.push({
          role: 'tool',
          tool_call_id: result.callId,
          content: result.isError ? JSON.stringify({ error: result.content }) : result.content,
        });
      }
    } else {
      const calls = message.toolCalls ?? [];
      out.push({
        role: 'assistant',
        content: message.text || null,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
              })),
            }
          : {}),
      });
    }
  }
  return out;
}

function toolParams(request: ProviderStreamRequest): ChatCompletionTool[] | undefined {
  if (!request.tools || request.tools.length === 0) return undefined;
  return request.tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as unknown as Record<string, unknown>,
    },
  }));
}

async function* streamTurn(client: OpenAiClientLike, request: ProviderStreamRequest): AsyncGenerator<ProviderEvent> {
  const tools = toolParams(request);
  const params = {
    model: request.model,
    messages: toOpenAiMessages(request.system, request.messages),
    max_completion_tokens: request.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools ? { tools } : {}),
  };

  let text = '';
  let refusal = '';
  let finish: string | null = null;
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const pending = new Map<number, { id: string; name: string; args: string }>();
  try {
    const stream = await client.chat.completions.create(params, request.signal ? { signal: request.signal } : {});
    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta.content) {
        text += delta.content;
        yield { type: 'text', text: delta.content };
      }
      if (delta.refusal) refusal += delta.refusal;
      for (const call of delta.tool_calls ?? []) {
        const entry = pending.get(call.index) ?? { id: '', name: '', args: '' };
        if (call.id) entry.id = call.id;
        if (call.function?.name) entry.name += call.function.name;
        if (call.function?.arguments) entry.args += call.function.arguments;
        pending.set(call.index, entry);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  } catch (e) {
    throw mapOpenAiError(e, request.signal);
  }

  const reason: ProviderStopReason =
    refusal || finish === 'content_filter'
      ? 'refusal'
      : finish === 'tool_calls'
        ? 'tool-use'
        : finish === 'length'
          ? 'max-tokens'
          : finish === 'stop'
            ? 'end'
            : 'other';
  const allCalls: ProviderToolCall[] = [];
  const valid: ProviderToolCall[] = [];
  for (const entry of [...pending.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)) {
    let input: unknown;
    let problem: string | null;
    try {
      input = JSON.parse(entry.args || '{}');
      problem = toolInputProblem(request.tools, entry.name, input);
    } catch {
      input = {};
      problem = 'input is not valid JSON';
    }
    allCalls.push({ id: entry.id, name: entry.name, input });
    // Tool calls of a truncated or refused turn are never runnable.
    if (reason !== 'tool-use') continue;
    if (problem) yield { type: 'tool-call-invalid', id: entry.id, name: entry.name, problem };
    else valid.push({ id: entry.id, name: entry.name, input });
  }
  for (const call of valid) yield { type: 'tool-call', call };
  yield {
    type: 'stop',
    reason,
    usage,
    assistant: { role: 'assistant', text, ...(allCalls.length > 0 ? { toolCalls: allCalls } : {}) },
  };
}

export function mapOpenAiError(e: unknown, signal?: AbortSignal): ProviderError {
  if (e instanceof ProviderError) return e;
  if (signal?.aborted || e instanceof OpenAI.APIUserAbortError) return new ProviderError('cancelled', 'cancelled');
  if (e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError) {
    return new ProviderError('unauthorized', `openai ${e.status}`, e.status);
  }
  if (e instanceof OpenAI.RateLimitError) return new ProviderError('rate-limited', 'openai 429', 429);
  if (e instanceof OpenAI.NotFoundError) return new ProviderError('model-not-found', 'openai 404', 404);
  if (e instanceof OpenAI.APIConnectionError) return new ProviderError('offline', 'openai connection failed');
  if (e instanceof OpenAI.APIError) {
    if (e.status === 413 || e.code === 'context_length_exceeded') {
      return new ProviderError('context-too-large', `openai ${e.status ?? 'error'}`, e.status);
    }
    return new ProviderError('provider-error', `openai ${e.status ?? 'error'}`, e.status);
  }
  return new ProviderError('provider-error', e instanceof Error ? e.name : 'unknown');
}
