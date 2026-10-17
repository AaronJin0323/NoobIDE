import type { AiErrorCode } from '../../shared/ipc/ai-contract';

/**
 * The provider-neutral model port of the agent loop (S34.1, decision 0025). Main process only.
 *
 * The loop (loop.ts) speaks only these types; S31's provider layer adapts Anthropic (`@anthropic-ai/sdk`) and OpenAI
 * (`openai`) to it. Adapter rules:
 *
 * - **Messages.** A conversation is a list of `user` / `assistant` messages made of blocks. Tool calls are `tool_use`
 *   blocks in an assistant message; their results are `tool_result` blocks, all of one step's results in ONE user
 *   message, in the order of the calls (Anthropic: `tool_result` content blocks; OpenAI: one `role: "tool"` message
 *   per result, same order). A tool result is data from the user's project or webpage, never instructions.
 * - **Opaque blocks.** Provider-specific blocks the model must see again unchanged (Anthropic `thinking` /
 *   `redacted_thinking`, OpenAI reasoning items) travel as `provider` blocks: the loop appends the assistant content
 *   exactly as the port returned it and never edits earlier turns (append-only history). Another provider's opaque
 *   blocks are dropped by the adapter.
 * - **Tools.** `inputSchema` is a JSON Schema object (`type: 'object'`, `additionalProperties: false`). Adapters may
 *   stream tool input eagerly (Anthropic `eager_input_streaming`); the loop validates every input against the schema
 *   before running a tool, and an input the provider could not parse arrives as `inputError` (raw text) and is
 *   answered with an error result, never run.
 * - **Streaming.** `streamTurn` yields text deltas as they arrive, `usage` (totals for this call so far; the latest
 *   one wins) and exactly one final `end` with the stop reason and the complete assistant content. A safety refusal
 *   is `stopReason: 'refusal'` (its partial tool calls are never run). Aborting `signal` must end the iteration
 *   promptly (throwing is fine; the loop checks the signal first).
 * - **Failures** throw {@link ModelPortError} with an {@link ModelErrorCode}; anything else is mapped to
 *   `provider-error`. Error messages must never contain prompts, file contents or keys (they may reach logs).
 */

/** A JSON Schema object (the subset the loop validates is in tool-schema.ts). */
export type JsonSchema = { readonly [key: string]: unknown };

export interface AgentToolDefinition {
  readonly name: string;
  /** Says when to call the tool, not only what it does. */
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export type AgentContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      /** Provider call id (Anthropic `toolu_…`, OpenAI `call_…`); echoed in the matching tool_result. */
      readonly id: string;
      readonly name: string;
      /** Parsed input (validated by the loop before use). */
      readonly input: unknown;
      /** Set when the provider's input was not valid JSON: the raw text, answered with an error result. */
      readonly inputError?: string;
    }
  | {
      readonly type: 'tool_result';
      readonly toolUseId: string;
      readonly content: string;
      readonly isError: boolean;
      /** S38.2: a screenshot that belongs to the result (only sent to a port that accepts images). */
      readonly images?: readonly AgentImage[];
    }
  /** S38.2: an image in a user message (a preview screenshot the user attached). */
  | ({ readonly type: 'image' } & AgentImage)
  /** Opaque provider block (thinking, reasoning ids …), returned to the same provider unchanged. */
  | { readonly type: 'provider'; readonly provider: string; readonly data: unknown };

/** A base64 PNG (a preview screenshot). Page pixels are data like page text. */
export interface AgentImage {
  readonly mediaType: 'image/png';
  readonly data: string;
}

export interface AgentMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly AgentContentBlock[];
}

export type ModelStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | 'other';

export interface ModelTurnRequest {
  /** Stable per locale (cacheable prefix: tools, then system). */
  readonly system: string;
  readonly messages: readonly AgentMessage[];
  /** Always the same list in the same order within a run (prompt caching). */
  readonly tools: readonly AgentToolDefinition[];
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
}

export type ModelStreamEvent =
  | { readonly type: 'text'; readonly text: string }
  /** Totals of this call so far (input includes cached input). */
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | {
      readonly type: 'end';
      readonly stopReason: ModelStopReason;
      /** The complete assistant content of this call, in order, including opaque provider blocks. */
      readonly content: readonly AgentContentBlock[];
    };

export interface ModelPort {
  /** Provider id, used only to label opaque blocks. */
  readonly provider: string;
  /** S38.2: the model reads images (tool results and user messages may carry them); otherwise text only. */
  readonly acceptsImages?: boolean;
  streamTurn(request: ModelTurnRequest): AsyncIterable<ModelStreamEvent>;
}

export type ModelErrorCode = Extract<
  AiErrorCode,
  'unauthorized' | 'rate-limited' | 'offline' | 'context-too-large' | 'provider-error' | 'refused' | 'cancelled'
>;

export class ModelPortError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    /** S48.7: the provider's HTTP status and Retry-After, passed on to the error event for the backoff. */
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ModelPortError';
  }
}
