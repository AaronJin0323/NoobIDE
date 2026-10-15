/**
 * One streaming interface over the AI providers (S31.1, decision 0025). Runs in the main process only: providers
 * hold the user's API key, which never reaches a renderer. Implementations: anthropic.ts (@anthropic-ai/sdk),
 * openai.ts (openai) and ../fake-provider.ts (scripted, for tests and e2e via NOOBIDE_AI_FAKE).
 *
 * The shapes here are provider-neutral so the request service (service.ts) and the agent loop (src/ai/agent, S34)
 * never import an SDK. Nothing in this module logs; callers log ids, counts and codes only (AGENTS.md).
 */
import type { AiModelInfo, AiProviderId, AiPurpose } from '../../shared/ipc/ai-contract';
import { validateJsonSchema, type JsonSchema } from './schema';

/** A tool call the model made, with its input already validated against the tool's schema. */
export interface ProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** S38.2: an image sent to the model (a preview screenshot): base64 PNG. */
export interface ProviderImage {
  readonly mediaType: 'image/png';
  readonly data: string;
}

export interface ProviderToolResult {
  readonly callId: string;
  /** Plain text (or JSON text) given back to the model. File contents are data, never instructions. */
  readonly content: string;
  readonly isError?: boolean;
  /** S38.2: images that belong to the result (only for models that accept images, see modelAcceptsImages). */
  readonly images?: readonly ProviderImage[];
}

/**
 * A conversation turn. Assistant turns produced by `stream` carry `native`: the provider's own content blocks
 * (thinking blocks, tool calls), which must be echoed back unchanged on the next request of the same conversation.
 * Histories are append-only (never edit an earlier turn).
 */
export type ProviderMessage =
  | {
      readonly role: 'user';
      readonly text: string;
      /** S38.2: images sent with the text (a preview screenshot the user saw in the Preview chip). */
      readonly images?: readonly ProviderImage[];
    }
  | {
      readonly role: 'assistant';
      readonly text: string;
      readonly toolCalls?: readonly ProviderToolCall[];
      /** Opaque, provider-specific; only the provider that produced it reads it. */
      readonly native?: { readonly provider: AiProviderId | 'fake'; readonly content: unknown };
    }
  | { readonly role: 'tool'; readonly results: readonly ProviderToolResult[] };

export interface ProviderTool {
  readonly name: string;
  readonly description: string;
  /** JSON schema of the input: an object with typed properties (see schema.ts for the supported subset). */
  readonly inputSchema: JsonSchema;
}

export type ProviderEffort = 'low' | 'medium' | 'high';

export interface ProviderStreamRequest {
  readonly model: string;
  readonly purpose: AiPurpose;
  /** Stable instructions (cached by providers that support prompt caching). Never per-request ids or times. */
  readonly system: string;
  readonly messages: readonly ProviderMessage[];
  /** Deterministic order (prompt caching is a prefix match). */
  readonly tools?: readonly ProviderTool[];
  readonly maxOutputTokens: number;
  readonly effort?: ProviderEffort;
  readonly signal?: AbortSignal;
}

export type ProviderStopReason = 'end' | 'tool-use' | 'max-tokens' | 'refusal' | 'other';

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
}

export type ProviderEvent =
  | { readonly type: 'text'; readonly text: string }
  /** Emitted once the turn ended with stop reason 'tool-use'; the input passed schema validation. */
  | { readonly type: 'tool-call'; readonly call: ProviderToolCall }
  /** The model called a tool with input that does not match the schema (or is not valid JSON). Never run it. */
  | { readonly type: 'tool-call-invalid'; readonly id: string; readonly name: string; readonly problem: string }
  | {
      readonly type: 'stop';
      readonly reason: ProviderStopReason;
      readonly usage: ProviderUsage;
      /** The assistant turn to append to the history before the next request. */
      readonly assistant: Extract<ProviderMessage, { role: 'assistant' }>;
    };

export type ProviderErrorCode =
  | 'unauthorized'
  | 'rate-limited'
  | 'offline'
  | 'model-not-found'
  | 'context-too-large'
  | 'cancelled'
  /** Tool input the SDK could not parse at all (eager input streaming): re-issue the request. */
  | 'invalid-tool-input'
  | 'provider-error';

/** Every failure a provider reports. `message` is technical detail without prompts, code or keys. */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    /** HTTP status when there was one. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface AiProvider {
  readonly id: AiProviderId;
  /** Streams one model turn. Throws ProviderError (also from the iteration) on failure or cancellation. */
  stream(request: ProviderStreamRequest): AsyncIterable<ProviderEvent>;
  listModels(signal?: AbortSignal): Promise<readonly AiModelInfo[]>;
  /** Checks the key with a free call (the model list). Throws ProviderError. */
  test(signal?: AbortSignal): Promise<void>;
}

/** Creates a provider for a key. The key stays inside the returned object (main process only). */
export type ProviderFactory = (provider: AiProviderId, apiKey: string) => AiProvider;

/** Default models per purpose (decision 0025). OpenAI defaults are chosen from its model list at setup. */
export const ANTHROPIC_DEFAULT_MODELS: Readonly<Record<AiPurpose, string>> = {
  chat: 'claude-opus-5-5',
  agent: 'claude-opus-5-5',
  edit: 'claude-opus-5-5',
  inline: 'claude-haiku-5-5',
};

/**
 * Picks OpenAI defaults from the account's model list: a full model for chat/agent/edit and a small one ("mini",
 * "nano") for inline completions. Newest first by the list order the caller gives (models sorted by id descending).
 */
export function pickOpenAiDefaults(models: readonly AiModelInfo[]): Record<AiPurpose, string> | null {
  const ids = models.map((m) => m.id);
  const small = (id: string) => /(mini|nano)/.test(id);
  const full = ids.find((id) => id.startsWith('gpt-') && !small(id)) ?? ids.find((id) => !small(id)) ?? ids[0];
  if (full === undefined) return null;
  const fast = ids.find((id) => id.startsWith('gpt-') && small(id)) ?? full;
  return { chat: full, agent: full, edit: full, inline: fast };
}

/**
 * S38.2: whether a model can read images. Every Claude model can. OpenAI: the current GPT/o-series and Codex models
 * can; older text-only ones (GPT-3.5, the first GPT-4, o1-mini / o3-mini) cannot, and get the text-only fallback.
 */
export function modelAcceptsImages(provider: AiProviderId | 'fake', model: string): boolean {
  if (provider !== 'openai') return true;
  if (/^gpt-4-vision/.test(model)) return true;
  if (/(audio|realtime|search|transcribe|tts)/.test(model)) return false;
  return !/^(gpt-3\.5|gpt-4(?![o.]|-turbo)|o1-mini|o1-preview|o3-mini|text-|davinci|babbage)/.test(model);
}

/** Validates a parsed tool input against the tool's schema; returns the problem, or null when it is valid. */
export function toolInputProblem(
  tools: readonly ProviderTool[] | undefined,
  name: string,
  input: unknown,
): string | null {
  const tool = tools?.find((t) => t.name === name);
  if (!tool) return `unknown tool ${name}`;
  return validateJsonSchema(tool.inputSchema, input);
}

/** Abort reasons and SDK aborts both become 'cancelled'. */
export function isAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
