import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaTool,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { AiModelInfo } from '../../shared/ipc/ai-contract';
import { guardedFetch, PROVIDER_ORIGINS, SILENT_LOGGER } from './egress';
import {
  ProviderError,
  requestOptions,
  retryAfterOf,
  toolInputProblem,
  type AiProvider,
  type ProviderEvent,
  type ProviderImage,
  type ProviderMessage,
  type ProviderStopReason,
  type ProviderStreamRequest,
  type ProviderToolCall,
} from './provider';

/**
 * Anthropic (Claude) provider over the official @anthropic-ai/sdk (S31.1, decision 0025):
 *
 * - streaming (`beta.messages.stream`), adaptive thinking (Claude Opus 5.5 / Haiku 5.5 accept nothing else) with the
 *   effort chosen per purpose;
 * - prompt caching: tools render before the system prompt, so one `cache_control` breakpoint on the stable system
 *   prompt caches tools + system; a top-level breakpoint caches the growing conversation for chat and agent turns;
 * - client tools stream their input eagerly (`eager_input_streaming`), so every parsed input is validated against
 *   the tool's schema before it is reported, and no tool call of a turn that stopped on `max_tokens` or `refusal`
 *   is ever reported as runnable;
 * - `refusal` stop reasons are reported as such, with server-side fallbacks opted in (`fallbacks: "default"`; a
 *   model without fallbacks simply runs alone);
 * - SDK errors map to ProviderError codes through the SDK's typed error classes.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Block types echoed back in the next request of the same conversation (thinking blocks must stay unchanged). */
const REPLAYED_BLOCKS = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use']);

/** The SDK surface this provider uses; tests pass a fake with the same shape. */
export interface AnthropicClientLike {
  readonly beta: {
    readonly messages: {
      stream(
        params: Anthropic.Beta.Messages.MessageCreateParamsStreaming | Record<string, unknown>,
        options?: { signal?: AbortSignal; maxRetries?: number },
      ): AsyncIterable<BetaRawMessageStreamEvent> & { finalMessage(): Promise<BetaMessage> };
    };
  };
  readonly models: {
    list(
      params?: { limit?: number },
      options?: { signal?: AbortSignal },
    ): AsyncIterable<{ id: string; display_name: string }>;
  };
}

export interface AnthropicProviderOptions {
  /** For tests: an SDK-shaped fake. Production builds the real client from the key. */
  readonly client?: AnthropicClientLike;
  /** For tests: the transport under the egress guard (default: global fetch). */
  readonly fetch?: typeof fetch;
}

/**
 * The real SDK client, with every option the SDK would otherwise take from the environment set explicitly (endpoint,
 * auth token, logging) and requests confined to api.anthropic.com (egress.ts, S36.1).
 */
export function createAnthropicClient(apiKey: string, transport?: typeof fetch): Anthropic {
  return new Anthropic({
    apiKey,
    authToken: null,
    baseURL: PROVIDER_ORIGINS.anthropic,
    timeout: 10 * 60 * 1000,
    logLevel: 'off',
    logger: SILENT_LOGGER,
    // No spans (the SDK can read a trace content mode from ANTHROPIC_OPEN_TELEMETRY_*).
    openTelemetry: false,
    fetch: guardedFetch(PROVIDER_ORIGINS.anthropic, 'ANTHROPIC_CUSTOM_HEADERS', transport),
  });
}

export function createAnthropicProvider(apiKey: string, options: AnthropicProviderOptions = {}): AiProvider {
  // maxRetries: the SDK retries 408/409/429/5xx and connection errors twice by default; kept for inline and edit.
  // Chat and agent turns use maxRetries 0: the chat's own backoff (S48.7) retries them visibly, at most three times.
  const client: AnthropicClientLike =
    options.client ?? (createAnthropicClient(apiKey, options.fetch) as unknown as AnthropicClientLike);

  return {
    id: 'anthropic',
    stream: (request) => streamTurn(client, request),
    async listModels(signal) {
      try {
        const models: AiModelInfo[] = [];
        for await (const model of client.models.list({ limit: 100 }, signal ? { signal } : {})) {
          models.push({ id: model.id, displayName: model.display_name || model.id });
        }
        return models;
      } catch (e) {
        throw mapAnthropicError(e, signal);
      }
    },
    async test(signal) {
      try {
        // Listing one model costs nothing and proves the key.
        for await (const model of client.models.list({ limit: 1 }, signal ? { signal } : {})) {
          void model;
          break;
        }
      } catch (e) {
        throw mapAnthropicError(e, signal);
      }
    },
  };
}

function toolParams(request: ProviderStreamRequest): BetaTool[] | undefined {
  if (!request.tools || request.tools.length === 0) return undefined;
  return request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as unknown as BetaTool.InputSchema,
    eager_input_streaming: true,
  }));
}

/** Provider-neutral history → Anthropic messages (append-only; native assistant blocks echoed unchanged). */
export function toAnthropicMessages(messages: readonly ProviderMessage[]): BetaMessageParam[] {
  return messages.map((message): BetaMessageParam => {
    if (message.role === 'user') {
      // S38.2: images (a preview screenshot) go before the text that refers to them.
      if (!message.images || message.images.length === 0) return { role: 'user', content: message.text };
      return { role: 'user', content: [...message.images.map(imageBlock), { type: 'text', text: message.text }] };
    }
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: message.results.map((result) => ({
          type: 'tool_result' as const,
          tool_use_id: result.callId,
          content:
            result.images && result.images.length > 0
              ? [{ type: 'text' as const, text: result.content }, ...result.images.map(imageBlock)]
              : result.content,
          ...(result.isError ? { is_error: true } : {}),
        })),
      };
    }
    if (message.native?.provider === 'anthropic' && Array.isArray(message.native.content)) {
      return { role: 'assistant', content: message.native.content as BetaContentBlockParam[] };
    }
    const content: BetaContentBlockParam[] = [];
    if (message.text) content.push({ type: 'text', text: message.text });
    for (const call of message.toolCalls ?? []) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    }
    return { role: 'assistant', content: content.length > 0 ? content : message.text };
  });
}

function imageBlock(image: ProviderImage) {
  return {
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: image.mediaType, data: image.data },
  };
}

function stopReasonOf(message: BetaMessage): ProviderStopReason {
  switch (message.stop_reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool-use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max-tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

async function* streamTurn(client: AnthropicClientLike, request: ProviderStreamRequest): AsyncGenerator<ProviderEvent> {
  const tools = toolParams(request);
  const multiTurn = request.purpose === 'chat' || request.purpose === 'agent';
  const params = {
    model: request.model,
    max_tokens: request.maxOutputTokens,
    // Stable instructions first and cached; nothing per-request (ids, times) goes into the system prompt.
    system: [{ type: 'text' as const, text: request.system, cache_control: { type: 'ephemeral' as const } }],
    messages: toAnthropicMessages(request.messages),
    thinking: { type: 'adaptive' as const },
    ...(request.effort ? { output_config: { effort: request.effort } } : {}),
    ...(tools ? { tools } : {}),
    // Caches the conversation so far (last cacheable block) for the next turn of a chat or agent loop.
    ...(multiTurn ? { cache_control: { type: 'ephemeral' as const } } : {}),
    betas: [FALLBACK_BETA],
    fallbacks: 'default' as const,
  };

  let final: BetaMessage;
  try {
    const stream = client.beta.messages.stream(params, requestOptions(request));
    // Iteration and the final read are wrapped together: with eager input streaming, unparseable tool JSON rejects
    // whichever of them is awaited when the block closes.
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      }
    }
    final = await stream.finalMessage();
  } catch (e) {
    throw mapAnthropicError(e, request.signal);
  }

  const reason = stopReasonOf(final);
  const blocks: readonly BetaContentBlock[] = final.content;
  const calls: ProviderToolCall[] = [];
  if (reason === 'tool-use') {
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue;
      const problem = toolInputProblem(request.tools, block.name, block.input);
      if (problem) yield { type: 'tool-call-invalid', id: block.id, name: block.name, problem };
      else calls.push({ id: block.id, name: block.name, input: block.input });
    }
    for (const call of calls) yield { type: 'tool-call', call };
  }
  const text = blocks
    .filter((b): b is Extract<BetaContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const allCalls = blocks
    .filter((b): b is Extract<BetaContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
  yield {
    type: 'stop',
    reason,
    usage: {
      inputTokens:
        final.usage.input_tokens +
        (final.usage.cache_read_input_tokens ?? 0) +
        (final.usage.cache_creation_input_tokens ?? 0),
      outputTokens: final.usage.output_tokens,
      cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
    },
    assistant: {
      role: 'assistant',
      text,
      ...(allCalls.length > 0 ? { toolCalls: allCalls } : {}),
      native: { provider: 'anthropic', content: blocks.filter((b) => REPLAYED_BLOCKS.has(b.type)) },
    },
  };
}

/** SDK error → ProviderError, most specific class first. Messages carry the status, never request content. */
export function mapAnthropicError(e: unknown, signal?: AbortSignal): ProviderError {
  if (e instanceof ProviderError) return e;
  if (signal?.aborted || e instanceof Anthropic.APIUserAbortError) return new ProviderError('cancelled', 'cancelled');
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError('unauthorized', `anthropic ${e.status}`, e.status);
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new ProviderError('rate-limited', 'anthropic 429', 429, retryAfterOf(e.headers));
  }
  if (e instanceof Anthropic.NotFoundError) return new ProviderError('model-not-found', 'anthropic 404', 404);
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError('offline', 'anthropic connection failed');
  if (e instanceof Anthropic.APIError) {
    if (e.status === 413) return new ProviderError('context-too-large', 'anthropic 413', 413);
    return new ProviderError('provider-error', `anthropic ${e.status ?? 'error'}`, e.status, retryAfterOf(e.headers));
  }
  // Not an API error: the SDK could not parse a streamed tool input (eager input streaming). Re-issue the turn.
  if (e instanceof Anthropic.AnthropicError || e instanceof SyntaxError) {
    return new ProviderError('invalid-tool-input', 'tool input was not valid JSON');
  }
  return new ProviderError('provider-error', e instanceof Error ? e.name : 'unknown');
}
