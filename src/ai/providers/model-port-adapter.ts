import {
  ModelPortError,
  type AgentContentBlock,
  type AgentMessage,
  type ModelErrorCode,
  type ModelPort,
  type ModelStopReason,
  type ModelStreamEvent,
  type ModelTurnRequest,
} from '../agent/model-port';
import {
  ProviderError,
  type AiProvider,
  modelAcceptsImages,
  type ProviderImage,
  type ProviderMessage,
  type ProviderStopReason,
  type ProviderToolCall,
  type ProviderToolResult,
} from './provider';
import type { JsonSchema } from './schema';

/**
 * Adapts an S31 provider (Anthropic / OpenAI / fake, provider.ts) to the agent loop's ModelPort (S34,
 * src/ai/agent/model-port.ts):
 *
 * - user text → user message; `tool_result` blocks → one tool message with every result in call order (the Anthropic
 *   provider sends them as `tool_result` blocks of one user turn, the OpenAI provider as one `role: "tool"` message
 *   per result);
 * - an assistant turn produced by the provider carries its native blocks (Anthropic thinking blocks, tool_use…) as
 *   ONE opaque `provider` block, echoed back unchanged on the next call; another provider's opaque blocks are dropped;
 * - a tool call whose input failed the provider-side schema check comes back as `tool_use` with `inputError` (the
 *   loop answers it with an error result and never runs it);
 * - ProviderError codes map to ModelPortError codes.
 */
const STOP: Readonly<Record<ProviderStopReason, ModelStopReason>> = {
  end: 'end_turn',
  'tool-use': 'tool_use',
  'max-tokens': 'max_tokens',
  refusal: 'refusal',
  other: 'other',
};

const PORT_ERRORS: ReadonlySet<ModelErrorCode> = new Set([
  'unauthorized',
  'rate-limited',
  'offline',
  'context-too-large',
  'cancelled',
]);

export function toProviderMessages(provider: string, messages: readonly AgentMessage[]): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const results: ProviderToolResult[] = [];
      const texts: string[] = [];
      const images: ProviderImage[] = [];
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          results.push({
            callId: block.toolUseId,
            content: block.content,
            ...(block.isError ? { isError: true } : {}),
            ...(block.images && block.images.length > 0
              ? { images: block.images.map((i) => ({ mediaType: i.mediaType, data: i.data })) }
              : {}),
          });
        } else if (block.type === 'text') texts.push(block.text);
        else if (block.type === 'image') images.push({ mediaType: block.mediaType, data: block.data });
      }
      if (results.length > 0) out.push({ role: 'tool', results });
      if (texts.length > 0 || images.length > 0) {
        out.push({ role: 'user', text: texts.join('\n\n'), ...(images.length > 0 ? { images } : {}) });
      }
      continue;
    }
    let text = '';
    const toolCalls: ProviderToolCall[] = [];
    let native: { provider: 'anthropic' | 'openai' | 'fake'; content: unknown } | undefined;
    for (const block of message.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
      else if (block.type === 'provider' && block.provider === provider) {
        native = { provider: provider as 'anthropic' | 'openai' | 'fake', content: block.data };
      }
    }
    out.push({
      role: 'assistant',
      text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(native ? { native } : {}),
    });
  }
  return out;
}

export function toModelPortError(e: unknown): ModelPortError {
  if (e instanceof ModelPortError) return e;
  if (e instanceof ProviderError) {
    const code = PORT_ERRORS.has(e.code as ModelErrorCode) ? (e.code as ModelErrorCode) : 'provider-error';
    return new ModelPortError(code, e.message);
  }
  return new ModelPortError('provider-error', e instanceof Error ? e.name : 'unknown error');
}

export function toModelPort(provider: AiProvider, model: string): ModelPort {
  return {
    provider: provider.id,
    acceptsImages: modelAcceptsImages(provider.id, model),
    async *streamTurn(request: ModelTurnRequest): AsyncIterable<ModelStreamEvent> {
      const invalid = new Map<string, string>();
      try {
        for await (const event of provider.stream({
          model,
          purpose: 'agent',
          system: request.system,
          messages: toProviderMessages(provider.id, request.messages),
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema as unknown as JsonSchema,
          })),
          maxOutputTokens: request.maxOutputTokens,
          effort: 'high',
          signal: request.signal,
        })) {
          if (event.type === 'text') yield { type: 'text', text: event.text };
          else if (event.type === 'tool-call-invalid') invalid.set(event.id, event.problem);
          else if (event.type === 'stop') {
            yield { type: 'usage', inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens };
            const content: AgentContentBlock[] = [];
            if (event.assistant.native && event.assistant.native.provider !== 'fake') {
              content.push({ type: 'provider', provider: provider.id, data: event.assistant.native.content });
            }
            if (event.assistant.text) content.push({ type: 'text', text: event.assistant.text });
            for (const call of event.assistant.toolCalls ?? []) {
              const problem = invalid.get(call.id);
              content.push(
                problem === undefined
                  ? { type: 'tool_use', id: call.id, name: call.name, input: call.input }
                  : { type: 'tool_use', id: call.id, name: call.name, input: {}, inputError: problem },
              );
            }
            yield { type: 'end', stopReason: STOP[event.reason], content };
          }
        }
      } catch (e) {
        throw toModelPortError(e);
      }
    },
  };
}
